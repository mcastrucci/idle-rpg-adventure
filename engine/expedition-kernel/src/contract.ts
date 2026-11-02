/**
 * Reusable contract checker for `ExpeditionSimulator` implementations (docs/engine/expedition-kernel.md §3). Plain
 * functions with no test-framework dependency: games call it from their own tests and assert that the returned list
 * is empty, e.g. `expect(checkSimulatorContract(sim, fixtures)).toEqual([])`.
 */

import { assertLedgerDelta, assetKey, netHoldings } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import type { Seed } from '@engine/sim-core';
import type { AreaId } from '@engine/world';

import { escrowProblems, escrowReturns } from './escrow.ts';
import { placeSegments, revisionSeed } from './placement.ts';
import { resolveSettlement } from './settlement.ts';
import { stableStringify } from './stable-stringify.ts';
import { defaultSettle, spliceTimeline, timelineProblems, totalWeight } from './timeline.ts';
import { SETTLE_REASONS, SIMULATOR_ID_PATTERN } from './types.ts';
import type { ExpeditionSimulator, SettleReason, SimulateInput, Timeline } from './types.ts';

export interface ContractFixture<Config, Snapshot> {
  /** Optional label used in violation messages. */
  readonly name?: string;
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  readonly budget: number;
  readonly seeds: readonly Seed[];
  /** The expedition's target (v0.3), passed to every `simulate` call (needed by simulators whose model uses it). */
  readonly areaId?: AreaId;
  readonly activityId?: string;
}

/**
 * How `settle` is checked for one reason:
 * - `default`: it must equal {@link defaultSettle} for every cutoff (so it never includes deltas of later segments).
 * - `custom`: validity, determinism, escrow conservation and the **default bound**: for every cutoff and every
 *   (actor, asset), `net(settle(t, cutoff, reason)) ≤ max(net(defaultSettle(t, cutoff)), 0)`, where `net` is the net
 *   holding change over all containers (`netHoldings`). A custom rule may therefore reduce gains (failure penalties),
 *   drop or reduce costs down to zero, but never grant more of anything than the default would up to that cutoff —
 *   which also rules out leaking gains of segments after the cutoff. Escrow returns are moves (holding-neutral) and
 *   are bounded separately by escrow conservation.
 */
export type SettlementMode = 'default' | 'custom';

export interface ContractOptions {
  /**
   * One mode for every reason, or per reason (`{ completed: 'custom', cancelled: 'default', member_left: 'default' }`).
   * Omitted (or a reason missing from the record): `default` iff `simulator.settle === defaultSettle`, else `custom`.
   */
  readonly settlement?: SettlementMode | Readonly<Partial<Record<SettleReason, SettlementMode>>>;
  /** Check every cutoff up to this many segments; longer timelines are sampled. Default 64. */
  readonly maxExhaustiveCutoffs?: number;
}

export type ContractRule =
  | 'identity'
  | 'fixture'
  | 'threw'
  | 'json'
  | 'determinism'
  | 'input-mutation'
  | 'structure'
  | 'budget'
  | 'config-roundtrip'
  | 'settle-delta'
  | 'settle-determinism'
  | 'settle-cutoff'
  | 'settle-bound'
  | 'escrow'
  | 'summarize-determinism'
  | 'resume'
  | 'cancel-after-end';

export interface ContractViolation {
  /** Index of the fixture in the list (`-1` for simulator-level rules such as `identity`). */
  readonly fixture: number;
  readonly seed?: Seed;
  readonly rule: ContractRule;
  readonly message: string;
}

/** Stable JSON or `undefined` if the value is not JSON data. */
function tryStringify(value: unknown): string | undefined {
  try {
    return stableStringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Violations of the default bound (see {@link SettlementMode}): every (actor, asset) whose net holding change in
 * `custom` exceeds `max(net change in reference, 0)`. Empty = within bounds.
 */
export function settlementBoundViolations(custom: readonly LedgerDelta[], reference: readonly LedgerDelta[]): string[] {
  const allowed = new Map<string, number>();
  for (const h of netHoldings(reference)) allowed.set(JSON.stringify([h.actorId, assetKey(h.asset)]), h.qty);
  const out: string[] = [];
  for (const h of netHoldings(custom)) {
    const limit = Math.max(allowed.get(JSON.stringify([h.actorId, assetKey(h.asset)])) ?? 0, 0);
    if (h.qty > limit) out.push(`${h.actorId} ${assetKey(h.asset)}: +${h.qty} exceeds the default bound ${limit}`);
  }
  return out;
}

function sampleCutoffs(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length: length + 1 }, (_, i) => i - 1);
  return [...new Set([-1, 0, length >>> 1, length - 2, length - 1])].filter((c) => c < length).sort((a, b) => a - b);
}

/**
 * Checks a simulator against the kernel contract on every fixture and seed and returns the violations (empty = OK):
 *
 * - `id` matches `SIMULATOR_ID_PATTERN` and `version` is non-empty (`identity`, fixture −1);
 * - `simulate` is deterministic (same input twice, the second time deep-cloned ⇒ identical stable JSON), does not
 *   mutate its input, and returns JSON data;
 * - segment indices are contiguous from 0, weights are positive safe integers, outcome is known, every delta is
 *   well-formed with a safe-integer `qty`, and Σ weight ≤ budget;
 * - `parseConfig` accepts the fixture config (as JSON data) and returns an equal config;
 * - `escrow` (when declared) is deterministic JSON, does not mutate its input and is well-formed (`escrowProblems`);
 * - `settle` for every reason and cutoff (sampled for long timelines) returns well-formed, deterministic deltas and
 *   does not mutate the timeline; per reason, in `default` mode it equals `defaultSettle` (so no delta of a later
 *   segment is ever included), in `custom` mode it stays within the default bound (`settle-bound`, see
 *   {@link SettlementMode}); in both modes it conserves escrow: never takes more out of `escrow` than was escrowed per
 *   (actor, asset), never moves anything into it, so returns are non-negative (`escrow`);
 * - `summarize` is deterministic at cutoffs −1 and last;
 * - cancel-after-end guard (v0.3, `cancel-after-end`): with the timeline placed at 1 ms per weight unit, a `cancel`
 *   resolved at `endsAt` (`resolveSettlement`) is a `completed` settlement of the whole timeline, and settling it gives
 *   exactly the deltas (and escrow returns) of `settle(t, last, 'completed')` — so a cancel after the end can never
 *   bypass a natural-end penalty (e.g. the loss on a failed timeline); a cancel 1 ms before the end resolves to
 *   `cancelled` with a cutoff before the last segment;
 * - resumption: where `stateAfter` of segment k−1 is present (k sampled at 1, middle, last), `simulate` with
 *   `from: { segment: k, state }`, `revisionSeed(seed, 1)` and the remaining budget is deterministic and returns a
 *   valid timeline starting at index k within the remaining budget.
 */
export function checkSimulatorContract<Config, Snapshot, Event, SimState, Report, Game>(
  simulator: ExpeditionSimulator<Config, Snapshot, Event, SimState, Report, Game>,
  fixtures: readonly ContractFixture<Config, Snapshot>[],
  options: ContractOptions = {},
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const inferred: SettlementMode = simulator.settle === defaultSettle ? 'default' : 'custom';
  const setting = options.settlement;
  const modeOf = (reason: SettleReason): SettlementMode =>
    typeof setting === 'string' ? setting : (setting?.[reason] ?? inferred);
  const maxCutoffs = options.maxExhaustiveCutoffs ?? 64;

  if (typeof simulator.id !== 'string' || !SIMULATOR_ID_PATTERN.test(simulator.id)) {
    violations.push({ fixture: -1, rule: 'identity', message: `simulator id ${JSON.stringify(simulator.id)} does not match ${String(SIMULATOR_ID_PATTERN)}` });
  }
  if (typeof simulator.version !== 'string' || simulator.version === '') {
    violations.push({ fixture: -1, rule: 'identity', message: 'simulator version must be a non-empty string' });
  }

  fixtures.forEach((fixture, fi) => {
    const label = fixture.name === undefined ? `fixture ${fi}` : `fixture ${fi} (${fixture.name})`;
    const report = (rule: ContractRule, message: string, seed?: Seed): void => {
      violations.push(seed === undefined ? { fixture: fi, rule, message: `${label}: ${message}` } : { fixture: fi, seed, rule, message: `${label}, seed ${seed}: ${message}` });
    };
    const attempt = <T>(what: string, fn: () => T, seed?: Seed): T | undefined => {
      try {
        return fn();
      } catch (e) {
        report('threw', `${what} threw: ${e instanceof Error ? e.message : String(e)}`, seed);
        return undefined;
      }
    };

    if (!Number.isSafeInteger(fixture.budget) || fixture.budget <= 0) {
      report('fixture', `budget ${String(fixture.budget)} is not a positive safe integer`);
      return;
    }
    const inputJson = tryStringify({ config: fixture.config, actors: fixture.actors });
    if (inputJson === undefined) {
      report('fixture', 'config and actors must be JSON data');
      return;
    }

    const parsed = attempt('parseConfig', () => simulator.parseConfig(JSON.parse(stableStringify(fixture.config))));
    if (parsed !== undefined && tryStringify(parsed) !== stableStringify(fixture.config)) {
      report('config-roundtrip', 'parseConfig(config) does not return an equal config');
    }

    // escrow: deterministic, JSON, well-formed, no input mutation
    let escrow: LedgerDelta[] | undefined = [];
    if (simulator.escrow !== undefined) {
      const escrowOf = simulator.escrow.bind(simulator);
      escrow = attempt('escrow', () => escrowOf(fixture.config, fixture.actors));
      const again = attempt('escrow (repeat)', () => escrowOf(structuredClone(fixture.config), structuredClone(fixture.actors)));
      if (tryStringify({ config: fixture.config, actors: fixture.actors }) !== inputJson) report('input-mutation', 'escrow mutated its config or actors');
      if (escrow !== undefined) {
        const ej = tryStringify(escrow);
        if (ej === undefined) {
          report('json', 'escrow is not JSON data');
          escrow = undefined;
        } else {
          if (ej !== tryStringify(again)) report('escrow', 'escrow is not deterministic');
          const problems = escrowProblems(escrow);
          for (const p of problems) report('escrow', p);
          if (problems.length > 0) escrow = undefined;
        }
      }
    }

    const target = {
      ...(fixture.areaId === undefined ? {} : { areaId: fixture.areaId }),
      ...(fixture.activityId === undefined ? {} : { activityId: fixture.activityId }),
    };

    for (const seed of fixture.seeds) {
      const input: SimulateInput<Config, Snapshot, SimState> = {
        config: fixture.config,
        actors: fixture.actors,
        seed,
        budget: fixture.budget,
        ...target,
      };
      const t1 = attempt('simulate', () => simulator.simulate(input), seed);
      if (tryStringify({ config: fixture.config, actors: fixture.actors }) !== inputJson) {
        report('input-mutation', 'simulate mutated its config or actors', seed);
      }
      const t2 = attempt('simulate (repeat)', () => simulator.simulate(structuredClone(input)), seed);
      if (t1 === undefined || t2 === undefined) continue;

      const json1 = tryStringify(t1);
      if (json1 === undefined) {
        report('json', 'timeline is not JSON data', seed);
        continue;
      }
      if (json1 !== tryStringify(t2)) report('determinism', 'same input produced different timelines', seed);

      const problems = timelineProblems(t1 as Timeline<unknown, unknown>, 0);
      for (const p of problems) report('structure', p, seed);
      if (problems.length > 0) continue;
      const weight = totalWeight(t1.segments);
      if (weight > fixture.budget) report('budget', `total weight ${weight} exceeds budget ${fixture.budget}`, seed);

      // settle
      const last = t1.segments.length - 1;
      for (const reason of SETTLE_REASONS) {
        const mode = modeOf(reason);
        for (const cutoff of sampleCutoffs(t1.segments.length, maxCutoffs)) {
          const where = `settle(cutoff ${cutoff}, ${reason})`;
          const d1 = attempt(where, () => simulator.settle(t1, cutoff, reason), seed);
          const d2 = attempt(where, () => simulator.settle(structuredClone(t1), cutoff, reason), seed);
          if (d1 === undefined || d2 === undefined) continue;
          const dj = tryStringify(d1);
          if (dj === undefined || !Array.isArray(d1)) {
            report('json', `${where} did not return a JSON array`, seed);
            continue;
          }
          d1.forEach((d, j) => {
            try {
              assertLedgerDelta(d);
            } catch (e) {
              report('settle-delta', `${where} delta ${j}: ${(e as Error).message}`, seed);
            }
          });
          if (dj !== tryStringify(d2)) report('settle-determinism', `${where} is not deterministic`, seed);
          const reference = defaultSettle(t1 as Timeline<unknown, unknown>, cutoff);
          if (mode === 'default' && dj !== stableStringify(reference)) {
            report('settle-cutoff', `${where} differs from defaultSettle (deltas outside segments 0..${cutoff}?)`, seed);
          }
          let wellFormed = true;
          for (const d of d1) {
            try {
              assertLedgerDelta(d);
            } catch {
              wellFormed = false;
            }
          }
          if (!wellFormed) continue;
          if (mode === 'custom') {
            for (const v of settlementBoundViolations(d1, reference)) report('settle-bound', `${where}: ${v}`, seed);
          }
          if (escrow !== undefined) {
            try {
              escrowReturns(escrow, d1);
            } catch (e) {
              report('escrow', `${where}: ${(e as Error).message}`, seed);
            }
          }
        }
      }

      // cancel-after-end guard
      attempt(
        'cancel-after-end',
        () => {
          const placed = placeSegments(t1, 0, fixture.budget, fixture.budget);
          const after = resolveSettlement(placed, placed.endsAtMs, 'cancel');
          if (!after.ok || after.reason !== 'completed' || after.cutoff !== last) {
            report('cancel-after-end', `a cancel at the end resolved to ${JSON.stringify(after)}, expected completed at cutoff ${last}`, seed);
            return;
          }
          const viaCancel = simulator.settle(t1, after.cutoff, after.reason);
          const natural = simulator.settle(t1, last, 'completed');
          if (tryStringify(viaCancel) !== tryStringify(natural)) {
            report('cancel-after-end', 'settling a cancel after the end differs from the natural (completed) settlement', seed);
          }
          const returnsOf = (settled: LedgerDelta[]): string | undefined => {
            try {
              return escrow === undefined ? undefined : tryStringify(escrowReturns(escrow, settled));
            } catch {
              return undefined; // already reported by the `escrow` rule
            }
          };
          if (returnsOf(viaCancel) !== returnsOf(natural)) {
            report('cancel-after-end', 'escrow returns of a cancel after the end differ from the natural settlement', seed);
          }
          if (placed.endsAtMs > placed.startsAtMs) {
            const before = resolveSettlement(placed, placed.endsAtMs - 1, 'cancel');
            if (!before.ok || before.reason !== 'cancelled' || before.cutoff >= last) {
              report('cancel-after-end', `a cancel before the end resolved to ${JSON.stringify(before)}, expected cancelled before cutoff ${last}`, seed);
            }
          }
        },
        seed,
      );

      // summarize
      for (const cutoff of [...new Set([-1, last])]) {
        const r1 = attempt(`summarize(${cutoff})`, () => simulator.summarize(t1, cutoff), seed);
        const r2 = attempt(`summarize(${cutoff})`, () => simulator.summarize(structuredClone(t1), cutoff), seed);
        if (r1 === undefined && r2 === undefined) continue;
        const rj = tryStringify(r1);
        if (rj === undefined) report('json', `summarize(${cutoff}) is not JSON data`, seed);
        else if (rj !== tryStringify(r2)) report('summarize-determinism', `summarize(${cutoff}) is not deterministic`, seed);
      }

      if (tryStringify(t1) !== json1) report('input-mutation', 'settle or summarize mutated the timeline', seed);

      // resumption
      const points = [...new Set([1, t1.segments.length >>> 1, last])].filter((k) => k >= 1 && k <= last);
      for (const k of points) {
        const prev = t1.segments[k - 1];
        if (prev === undefined || prev.stateAfter === undefined) continue;
        const remaining = fixture.budget - totalWeight(t1.segments.slice(0, k));
        const rin: SimulateInput<Config, Snapshot, SimState> = {
          config: fixture.config,
          actors: fixture.actors,
          seed: revisionSeed(seed, 1),
          budget: remaining,
          ...target,
          from: { segment: k, state: structuredClone(prev.stateAfter) },
        };
        const where = `simulate(from segment ${k})`;
        const r1 = attempt(where, () => simulator.simulate(rin), seed);
        const r2 = attempt(where, () => simulator.simulate(structuredClone(rin)), seed);
        if (r1 === undefined || r2 === undefined) continue;
        const rj = tryStringify(r1);
        if (rj === undefined) {
          report('json', `${where} timeline is not JSON data`, seed);
          continue;
        }
        if (rj !== tryStringify(r2)) report('resume', `${where} is not deterministic`, seed);
        const rp = timelineProblems(r1 as Timeline<unknown, unknown>, k, remaining);
        for (const p of rp) report('resume', `${where}: ${p}`, seed);
        if (rp.length === 0) attempt(`${where} splice`, () => spliceTimeline(t1, k, r1), seed);
      }
    }
  });
  return violations;
}
