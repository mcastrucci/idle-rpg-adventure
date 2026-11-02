/**
 * Escrow bookkeeping (docs/engine/expedition-kernel.md §2): what a simulator declares with `escrow(config, actors)` is
 * moved into the engine `escrow` container at start; segments consume it with `from: 'escrow'` deltas; at settlement
 * the kernel returns the unused part to its source container. Pure functions over {@link LedgerDelta} data.
 */

import { assertLedgerDelta, assetKey, isUniqueMint } from '@engine/economy';
import type { AssetRef, Container, LedgerDelta } from '@engine/economy';

import { assertCutoff } from './timeline.ts';
import type { ExpeditionSimulator, SettleReason, Timeline } from './types.ts';

/** The engine container holding escrowed inputs. */
export const ESCROW_CONTAINER = 'escrow';

function key(actorId: string, asset: AssetRef): string {
  return JSON.stringify([actorId, assetKey(asset)]);
}

/**
 * Problems of a list of escrow deltas (empty = valid): each must be a well-formed delta with a positive `qty`, an
 * explicit source `from` other than `escrow` and `to: 'escrow'`; one (actor, asset) may only come from one source
 * container (so the return target is unambiguous). `unique_mint` assets cannot be escrowed (nothing exists yet; a
 * mint delta never has a `from`, so settlement can never mint into or out of escrow either).
 */
export function escrowProblems(escrow: readonly LedgerDelta[]): string[] {
  if (!Array.isArray(escrow)) return ['escrow must be an array of ledger deltas'];
  const problems: string[] = [];
  const sources = new Map<string, Container>();
  escrow.forEach((d, i) => {
    try {
      assertLedgerDelta(d);
    } catch (e) {
      problems.push(`escrow delta ${i}: ${(e as Error).message}`);
      return;
    }
    if (d.qty <= 0) problems.push(`escrow delta ${i}: qty must be positive`);
    if (isUniqueMint(d.asset)) problems.push(`escrow delta ${i}: unique_mint assets cannot be escrowed (no instance exists yet)`);
    if (d.to !== ESCROW_CONTAINER) problems.push(`escrow delta ${i}: to must be '${ESCROW_CONTAINER}'`);
    if (d.from === undefined || d.from === ESCROW_CONTAINER) {
      problems.push(`escrow delta ${i}: from must name the source container (not '${ESCROW_CONTAINER}')`);
      return;
    }
    const k = key(d.actorId, d.asset);
    const source = sources.get(k);
    if (source === undefined) sources.set(k, d.from);
    else if (source !== d.from) problems.push(`escrow delta ${i}: ${d.actorId} ${assetKey(d.asset)} escrowed from both ${source} and ${d.from}`);
  });
  return problems;
}

/** Throws a `RangeError` listing every problem unless the escrow deltas are valid (see {@link escrowProblems}). */
export function assertEscrow(escrow: readonly LedgerDelta[]): void {
  const problems = escrowProblems(escrow);
  if (problems.length > 0) throw new RangeError(`invalid escrow: ${problems.join('; ')}`);
}

/**
 * Automatic escrow returns: per (actor, asset), `escrowed + net change of the escrow container in settled`, i.e.
 * `escrowed − consumed`, moved back from `escrow` to the source container. Output is in first-escrow order; zero
 * returns are omitted.
 *
 * Throws a `RangeError` when `settled` takes more out of escrow than was escrowed for some (actor, asset) (including
 * assets that were never escrowed), or moves additional assets *into* escrow (net change > 0): both break escrow
 * conservation.
 */
export function escrowReturns(escrow: readonly LedgerDelta[], settled: readonly LedgerDelta[]): LedgerDelta[] {
  assertEscrow(escrow);
  const entries = new Map<string, { actorId: string; asset: AssetRef; source: Container; escrowed: number; net: number }>();
  for (const d of escrow) {
    const k = key(d.actorId, d.asset);
    const e = entries.get(k);
    if (e === undefined) entries.set(k, { actorId: d.actorId, asset: d.asset, source: d.from as Container, escrowed: d.qty, net: 0 });
    else e.escrowed += d.qty;
  }
  for (const d of settled) {
    assertLedgerDelta(d);
    const change = (d.to === ESCROW_CONTAINER ? d.qty : 0) - (d.from === ESCROW_CONTAINER ? d.qty : 0);
    if (change === 0) continue;
    const k = key(d.actorId, d.asset);
    const e = entries.get(k);
    if (e === undefined) {
      throw new RangeError(`escrow: ${d.actorId} ${assetKey(d.asset)} was never escrowed but settlement moves ${change} through escrow`);
    }
    e.net += change;
  }
  const out: LedgerDelta[] = [];
  for (const e of entries.values()) {
    const remaining = e.escrowed + e.net;
    if (!Number.isSafeInteger(remaining)) throw new RangeError('escrow: quantity overflow');
    if (e.net > 0) throw new RangeError(`escrow: settlement moves ${e.net} ${assetKey(e.asset)} of ${e.actorId} into escrow`);
    if (remaining < 0) {
      throw new RangeError(`escrow: ${e.actorId} consumes ${-e.net} ${assetKey(e.asset)} but only ${e.escrowed} were escrowed`);
    }
    if (remaining > 0) out.push({ actorId: e.actorId, asset: e.asset, qty: remaining, from: ESCROW_CONTAINER, to: e.source });
  }
  return out;
}

/** Escrow of a simulator for `(config, actors)` (validated); `[]` when it declares none. */
export function simulatorEscrow<Config, Snapshot>(
  simulator: Pick<ExpeditionSimulator<Config, Snapshot, unknown, unknown, unknown, unknown>, 'escrow'>,
  config: Config,
  actors: readonly Snapshot[],
): LedgerDelta[] {
  const escrow = simulator.escrow === undefined ? [] : simulator.escrow(config, actors);
  assertEscrow(escrow);
  return escrow;
}

/** Everything a settlement applies, split by origin. */
export interface Settlement {
  /** What was escrowed at start (already applied then; listed for audit/reports). */
  readonly escrowed: readonly LedgerDelta[];
  /** `simulator.settle(timeline, cutoff, reason)`. */
  readonly settled: readonly LedgerDelta[];
  /** Automatic return of unused escrow to its source containers. */
  readonly returned: readonly LedgerDelta[];
  /** What the ledger applies at settlement: `settled` followed by `returned`. */
  readonly deltas: readonly LedgerDelta[];
}

/**
 * Settles segments `0..cutoff` for `reason` **and** returns unused escrow: `settled = simulator.settle(...)`,
 * `returned = escrowReturns(simulator.escrow(config, actors), settled)`. Works for every cutoff including `-1`
 * (cancel before the first segment: everything escrowed is returned). Pure; throws on invalid escrow or when the
 * simulator breaks escrow conservation.
 */
export function settleWithEscrow<Config, Snapshot, Event, SimState>(
  simulator: ExpeditionSimulator<Config, Snapshot, Event, SimState, unknown, unknown>,
  timeline: Timeline<Event, SimState>,
  cutoff: number,
  reason: SettleReason,
  config: Config,
  actors: readonly Snapshot[],
): Settlement {
  assertCutoff(timeline as Timeline<unknown, unknown>, cutoff);
  const escrowed = simulatorEscrow(simulator, config, actors);
  const settled = simulator.settle(timeline, cutoff, reason);
  const returned = escrowReturns(escrowed, settled);
  return { escrowed, settled, returned, deltas: [...settled, ...returned] };
}
