/**
 * Reusable contract checker for `ExpeditionSimulator` implementations (docs/engine/expedition-kernel.md §3). Plain
 * functions with no test-framework dependency: games call it from their own tests and assert that the returned list
 * is empty, e.g. `expect(checkSimulatorContract(sim, fixtures)).toEqual([])`.
 */

import { assertLedgerDelta } from '@engine/economy';
import type { Seed } from '@engine/sim-core';

import { revisionSeed } from './placement.ts';
import { stableStringify } from './stable-stringify.ts';
import { defaultSettle, spliceTimeline, timelineProblems, totalWeight } from './timeline.ts';
import { SETTLE_REASONS } from './types.ts';
import type { ExpeditionSimulator, SimulateInput, Timeline } from './types.ts';

export interface ContractFixture<Config, Snapshot> {
  /** Optional label used in violation messages. */
  readonly name?: string;
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  readonly budget: number;
  readonly seeds: readonly Seed[];
}

export interface ContractOptions {
  /**
   * `default`: `settle` must equal {@link defaultSettle} for every cutoff and reason (so it never includes deltas of
   * segments after the cutoff). `custom`: only validity and determinism of `settle` are checked. When omitted:
   * `default` iff `simulator.settle === defaultSettle`.
   */
  readonly settlement?: 'default' | 'custom';
  /** Check every cutoff up to this many segments; longer timelines are sampled. Default 64. */
  readonly maxExhaustiveCutoffs?: number;
}

export type ContractRule =
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
  | 'summarize-determinism'
  | 'resume';

export interface ContractViolation {
  /** Index of the fixture in the list. */
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

function sampleCutoffs(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length: length + 1 }, (_, i) => i - 1);
  return [...new Set([-1, 0, length >>> 1, length - 2, length - 1])].filter((c) => c < length).sort((a, b) => a - b);
}

/**
 * Checks a simulator against the kernel contract on every fixture and seed and returns the violations (empty = OK):
 *
 * - `simulate` is deterministic (same input twice, the second time deep-cloned ⇒ identical stable JSON), does not
 *   mutate its input, and returns JSON data;
 * - segment indices are contiguous from 0, weights are positive safe integers, outcome is known, every delta is
 *   well-formed with a safe-integer `qty`, and Σ weight ≤ budget;
 * - `parseConfig` accepts the fixture config (as JSON data) and returns an equal config;
 * - `settle` for every reason and cutoff (sampled for long timelines) returns well-formed, deterministic deltas and
 *   does not mutate the timeline; with default settlement it equals `defaultSettle`, so no delta of a later segment
 *   is ever included;
 * - `summarize` is deterministic at cutoffs −1 and last;
 * - resumption: where `stateAfter` of segment k−1 is present (k sampled at 1, middle, last), `simulate` with
 *   `from: { segment: k, state }`, `revisionSeed(seed, 1)` and the remaining budget is deterministic and returns a
 *   valid timeline starting at index k within the remaining budget.
 */
export function checkSimulatorContract<Config, Snapshot, Event, SimState, Report>(
  simulator: ExpeditionSimulator<Config, Snapshot, Event, SimState, Report>,
  fixtures: readonly ContractFixture<Config, Snapshot>[],
  options: ContractOptions = {},
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const useDefault = (options.settlement ?? (simulator.settle === defaultSettle ? 'default' : 'custom')) === 'default';
  const maxCutoffs = options.maxExhaustiveCutoffs ?? 64;

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

    for (const seed of fixture.seeds) {
      const input: SimulateInput<Config, Snapshot, SimState> = {
        config: fixture.config,
        actors: fixture.actors,
        seed,
        budget: fixture.budget,
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
          if (useDefault && dj !== stableStringify(defaultSettle(t1 as Timeline<unknown, unknown>, cutoff))) {
            report('settle-cutoff', `${where} differs from defaultSettle (deltas outside segments 0..${cutoff}?)`, seed);
          }
        }
      }

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
