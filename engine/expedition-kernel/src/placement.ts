/**
 * Wall-clock placement, progressive reveal and cutoffs. All timestamps are integer milliseconds passed in by the
 * caller; nothing here reads the clock.
 *
 * ## Placement rule
 *
 * The planned `budget` (total weight, from `simulator.budget`) spans the planned duration. A segment ends — and is
 * revealed — once the cumulative weight up to and including it has "elapsed":
 *
 *     revealAt[i] = startsAt + ⌊ cumWeight[i] × durationMs / budget ⌋
 *     endsAt      = startsAt + ⌊ Σ weight × durationMs / budget ⌋   (= revealAt of the last segment, or startsAt)
 *
 * The denominator is the planned budget, not the produced weight, so an expedition that stops early (failed or
 * retreated, Σ weight < budget) ends early at its last segment's reveal time instead of stretching its few segments
 * over the full duration. A timeline that consumes the whole budget ends exactly at `startsAt + durationMs`.
 * (For unit weights this is the RPG spec's `startsAt + (i+1)/budget × duration`.) The rule applies to every outcome:
 * a simulator that reports `completed` with Σ weight < budget also ends early. Floors are exact integer math
 * (`mulDivFloor`), so reveal times are non-decreasing and several segments may share one when `durationMs < budget`.
 */

import { netDeltas } from '@engine/economy';
import type { NetDelta } from '@engine/economy';
import { assertInt, assertSeed, deriveSeed, mulDivFloor } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';

import { assertTimeline } from './timeline.ts';
import type { Outcome, Segment, Timeline } from './types.ts';

export interface PlacedSegment<Event, SimState = unknown> extends Segment<Event, SimState> {
  /** Integer ms timestamp at which the segment becomes visible. */
  readonly revealAtMs: number;
}

/** A timeline anchored on the wall clock. Server-side data: never send it to clients as-is (use {@link visibleView}). */
export interface PlacedTimeline<Event, SimState = unknown> {
  readonly startsAtMs: number;
  readonly durationMs: number;
  /** `startsAtMs + durationMs`: the planned end, safe to show (progress bars). */
  readonly plannedEndsAtMs: number;
  /** Actual end (settlement time). Earlier than `plannedEndsAtMs` on early termination: server-only until reached. */
  readonly endsAtMs: number;
  readonly budget: number;
  readonly outcome: Outcome;
  readonly segments: readonly PlacedSegment<Event, SimState>[];
}

/**
 * Places a timeline on the wall clock (see the module doc for the rule). Throws if the timeline is structurally
 * invalid, its total weight exceeds `budget`, or any argument is not an integer in range.
 */
export function placeSegments<E, S>(
  timeline: Timeline<E, S>,
  startsAtMs: number,
  durationMs: number,
  budget: number,
): PlacedTimeline<E, S> {
  assertInt(startsAtMs, 'startsAtMs');
  assertInt(durationMs, 'durationMs');
  assertInt(budget, 'budget');
  if (durationMs < 0) throw new RangeError('durationMs must be >= 0');
  if (budget <= 0) throw new RangeError('budget must be > 0');
  assertTimeline(timeline as Timeline<unknown, unknown>, 0, budget);
  const plannedEndsAtMs = startsAtMs + durationMs;
  assertInt(plannedEndsAtMs, 'startsAtMs + durationMs');

  let cumulative = 0;
  const segments = timeline.segments.map((s): PlacedSegment<E, S> => {
    cumulative += s.weight;
    return { ...s, revealAtMs: startsAtMs + mulDivFloor(cumulative, durationMs, budget) };
  });
  const endsAtMs = startsAtMs + mulDivFloor(cumulative, durationMs, budget);
  return { startsAtMs, durationMs, plannedEndsAtMs, endsAtMs, budget, outcome: timeline.outcome, segments };
}

/** Index of the last segment with `revealAtMs ≤ nowMs`, or `-1` if none is revealed yet. */
export function revealCutoff(placed: PlacedTimeline<unknown, unknown>, nowMs: number): number {
  assertInt(nowMs, 'nowMs');
  // Reveal times are non-decreasing: binary search for the last one ≤ now.
  let lo = 0;
  let hi = placed.segments.length; // first index with revealAt > now lies in [lo, hi]
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((placed.segments[mid] as PlacedSegment<unknown, unknown>).revealAtMs <= nowMs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Cutoff for a cancellation at `nowMs`: the last revealed segment (docs/engine/expedition-kernel.md §2.4). What a
 * cancellation grants for those segments is the simulator's `settle(…, 'cancelled')` decision (open decision #6).
 */
export function cancelCutoff(placed: PlacedTimeline<unknown, unknown>, nowMs: number): number {
  return revealCutoff(placed, nowMs);
}

/** A revealed segment as exposed by {@link visibleView}: no `stateAfter` (it may encode RNG state, i.e. the future). */
export interface VisibleSegment<Event> {
  readonly index: number;
  readonly weight: number;
  readonly revealAtMs: number;
  readonly events: readonly Event[];
  readonly deltas: PlacedSegment<Event>['deltas'];
}

/** What may be shown about an expedition at `nowMs`. */
export interface VisibleView<Event> {
  readonly startsAtMs: number;
  /** The planned end. The actual (possibly earlier) end is only exposed via `endedAtMs` once reached. */
  readonly plannedEndsAtMs: number;
  /** Index of the last revealed segment (`-1` = none). */
  readonly cutoff: number;
  readonly segments: readonly VisibleSegment<Event>[];
  /** Net deltas of the revealed segments (per actor, asset and container). Not a settlement promise. */
  readonly revealedDeltas: readonly NetDelta[];
  /** `true` once `nowMs ≥ endsAtMs`. */
  readonly ended: boolean;
  /** Present only when `ended`. */
  readonly outcome?: Outcome;
  /** Present only when `ended`. */
  readonly endedAtMs?: number;
}

/**
 * Client-safe view at `nowMs`: revealed segments only (without `stateAfter`), aggregated revealed deltas, and the
 * outcome / actual end time only once `nowMs ≥ endsAtMs`. It never contains the number of segments or the actual
 * end time before the end, since an early end would reveal a failure in advance.
 */
export function visibleView<E>(placed: PlacedTimeline<E, unknown>, nowMs: number): VisibleView<E> {
  const cutoff = revealCutoff(placed, nowMs);
  const segments = placed.segments.slice(0, cutoff + 1).map(
    (s): VisibleSegment<E> => ({ index: s.index, weight: s.weight, revealAtMs: s.revealAtMs, events: s.events, deltas: s.deltas }),
  );
  const revealedDeltas = netDeltas(segments.flatMap((s) => s.deltas));
  const base = { startsAtMs: placed.startsAtMs, plannedEndsAtMs: placed.plannedEndsAtMs, cutoff, segments, revealedDeltas };
  if (nowMs >= placed.endsAtMs) return { ...base, ended: true, outcome: placed.outcome, endedAtMs: placed.endsAtMs };
  return { ...base, ended: false };
}

/**
 * Seed for revision `revision` of an expedition (party re-simulation). Revision 0 is the original seed; revision
 * `r ≥ 1` is `deriveSeed(seed, 'revision', r)`.
 */
export function revisionSeed(seed: Seed, revision: number): Seed {
  assertInt(revision, 'revision');
  if (revision < 0) throw new RangeError('revision must be >= 0');
  assertSeed(seed, 'seed');
  return revision === 0 ? seed : deriveSeed(seed, 'revision', revision);
}
