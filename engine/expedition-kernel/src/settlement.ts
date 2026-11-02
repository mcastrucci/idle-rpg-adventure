/**
 * Settlement resolution (docs/engine/expedition-kernel.md §2.3–§2.4, v0.3): which `SettleReason` and cutoff a
 * settlement request uses at a given time. This is the **cancel-after-end guard**: once `now ≥ endsAt` the expedition
 * is over and must be settled as `completed` over the whole timeline, whatever was requested. Otherwise a cancel whose
 * cutoff covers the final (e.g. fatal) segment would settle with `reason = 'cancelled'` and skip the penalties that
 * the simulator applies only to a natural end.
 *
 * The server never picks a reason or cutoff itself: it calls {@link resolveSettlement} (or {@link settleAt}) with the
 * request and its clock's `now`.
 */

import { assertInt } from '@engine/sim-core';

import { settleWithEscrow } from './escrow.ts';
import type { Settlement } from './escrow.ts';
import { revealCutoff } from './placement.ts';
import type { PlacedTimeline } from './placement.ts';
import type { ExpeditionSimulator, SettleReason, Timeline } from './types.ts';

/**
 * What triggered a settlement:
 * - `complete` — the settlement job at the expedition's end;
 * - `cancel` — the owner's cancel command;
 * - `member_left` — a party member leaves (their share is settled before the party revision).
 */
export type SettlementRequest = 'complete' | 'cancel' | 'member_left';

export const SETTLEMENT_REQUESTS: readonly SettlementRequest[] = ['complete', 'cancel', 'member_left'];

/** Stable refusal code: `complete` requested before the expedition's (actual) end. */
export const SETTLE_NOT_ENDED = 'settle.notEnded';

/**
 * Result of {@link resolveSettlement}.
 *
 * On success: the `reason` and `cutoff` to settle with; `ended` = `now ≥ endsAt`; `converted` = the request was turned
 * into a natural end (`cancel` / `member_left` at or after the end). A refusal (`settle.notEnded`) deliberately carries
 * no timestamps: the actual end may be earlier than the planned end and must not leak before it is reached.
 */
export type SettlementResolution =
  | {
      readonly ok: true;
      readonly requested: SettlementRequest;
      readonly reason: SettleReason;
      readonly cutoff: number;
      readonly ended: boolean;
      readonly converted: boolean;
    }
  | { readonly ok: false; readonly requested: SettlementRequest; readonly code: typeof SETTLE_NOT_ENDED };

/**
 * Resolves a settlement request at `nowMs` (integer ms):
 *
 * | request | `now < endsAt` | `now ≥ endsAt` |
 * |---|---|---|
 * | `complete` | refused: `settle.notEnded` | `completed`, cutoff = last segment |
 * | `cancel` | `cancelled`, cutoff = `revealCutoff(now)` | **`completed`, cutoff = last segment** (`converted`) |
 * | `member_left` | `member_left`, cutoff = `revealCutoff(now)` | `completed`, cutoff = last segment (`converted`) |
 *
 * Before the end the reveal cutoff never covers the last segment (it is revealed exactly at `endsAt`), so a cancel can
 * never settle the final segment under a non-natural reason. Pure; throws only on a non-integer `nowMs`.
 */
export function resolveSettlement(placed: PlacedTimeline<unknown, unknown>, nowMs: number, requested: SettlementRequest): SettlementResolution {
  assertInt(nowMs, 'nowMs');
  if (!SETTLEMENT_REQUESTS.includes(requested)) throw new RangeError(`unknown settlement request ${JSON.stringify(requested)}`);
  const ended = nowMs >= placed.endsAtMs;
  if (ended) {
    return { ok: true, requested, reason: 'completed', cutoff: placed.segments.length - 1, ended, converted: requested !== 'complete' };
  }
  if (requested === 'complete') return { ok: false, requested, code: SETTLE_NOT_ENDED };
  return {
    ok: true,
    requested,
    reason: requested === 'cancel' ? 'cancelled' : 'member_left',
    cutoff: revealCutoff(placed, nowMs),
    ended,
    converted: false,
  };
}

/**
 * Whether a cancel at `nowMs` is a real cancellation (`now < endsAt`). After the end a cancel request is settled as a
 * natural end (see {@link resolveSettlement}); a server may also reject the command with this check, but must then
 * still settle the expedition as `completed`.
 */
export function canCancel(placed: PlacedTimeline<unknown, unknown>, nowMs: number): boolean {
  assertInt(nowMs, 'nowMs');
  return nowMs < placed.endsAtMs;
}

/** {@link settleAt} result: the resolution plus the settlement to apply, or the refusal. */
export type SettleAtResult =
  | { readonly ok: true; readonly resolution: Extract<SettlementResolution, { ok: true }>; readonly settlement: Settlement }
  | Extract<SettlementResolution, { ok: false }>;

/**
 * One-call settlement for the server: `resolveSettlement(placed, nowMs, requested)` then
 * `settleWithEscrow(simulator, timeline, cutoff, reason, config, actors)`. `placed` must be the placement of
 * `timeline` (same segment count and outcome; throws otherwise). Pure.
 */
export function settleAt<Config, Snapshot, Event, SimState>(
  simulator: ExpeditionSimulator<Config, Snapshot, Event, SimState, unknown, unknown>,
  timeline: Timeline<Event, SimState>,
  placed: PlacedTimeline<unknown, unknown>,
  nowMs: number,
  requested: SettlementRequest,
  config: Config,
  actors: readonly Snapshot[],
): SettleAtResult {
  if (placed.segments.length !== timeline.segments.length || placed.outcome !== timeline.outcome) {
    throw new RangeError('placed timeline does not match the timeline');
  }
  const resolution = resolveSettlement(placed, nowMs, requested);
  if (!resolution.ok) return resolution;
  return { ok: true, resolution, settlement: settleWithEscrow(simulator, timeline, resolution.cutoff, resolution.reason, config, actors) };
}
