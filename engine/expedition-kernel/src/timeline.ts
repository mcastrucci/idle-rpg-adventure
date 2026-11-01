/** Structural validation and generic operations on timelines. */

import { assertLedgerDelta } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import { hashSeed } from '@engine/sim-core';

import { stableStringify } from './stable-stringify.ts';

import { OUTCOMES } from './types.ts';
import type { Segment, Timeline } from './types.ts';

/**
 * Returns the problems of a timeline as human-readable strings (empty = valid): known outcome, segment indices
 * contiguous from `firstIndex`, positive safe-integer weights, well-formed deltas with safe-integer quantities, and
 * (if given) Σ weight ≤ `budget`.
 */
export function timelineProblems(timeline: Timeline<unknown, unknown>, firstIndex = 0, budget?: number): string[] {
  const problems: string[] = [];
  if (typeof timeline !== 'object' || timeline === null || !Array.isArray(timeline.segments)) {
    return ['timeline must be an object with a segments array'];
  }
  if (!OUTCOMES.includes(timeline.outcome)) problems.push(`unknown outcome ${JSON.stringify(timeline.outcome)}`);
  let total = 0;
  timeline.segments.forEach((s, i) => {
    const expected = firstIndex + i;
    if (s.index !== expected) problems.push(`segment ${i}: index ${String(s.index)}, expected ${expected}`);
    if (!Number.isSafeInteger(s.weight) || s.weight <= 0) {
      problems.push(`segment ${i}: weight ${String(s.weight)} is not a positive safe integer`);
    } else {
      total += s.weight;
    }
    if (!Array.isArray(s.events)) problems.push(`segment ${i}: events must be an array`);
    if (!Array.isArray(s.deltas)) {
      problems.push(`segment ${i}: deltas must be an array`);
    } else {
      (s.deltas as readonly LedgerDelta[]).forEach((d: LedgerDelta, j: number) => {
        try {
          assertLedgerDelta(d);
        } catch (e) {
          problems.push(`segment ${i} delta ${j}: ${(e as Error).message}`);
        }
      });
    }
  });
  if (!Number.isSafeInteger(total)) problems.push('total weight is not a safe integer');
  if (budget !== undefined && total > budget) problems.push(`total weight ${total} exceeds budget ${budget}`);
  return problems;
}

/** Throws a `RangeError` listing every problem unless the timeline is structurally valid (see {@link timelineProblems}). */
export function assertTimeline(timeline: Timeline<unknown, unknown>, firstIndex = 0, budget?: number): void {
  const problems = timelineProblems(timeline, firstIndex, budget);
  if (problems.length > 0) throw new RangeError(`invalid timeline: ${problems.join('; ')}`);
}

/** Σ weight of all segments. */
export function totalWeight(segments: readonly Segment<unknown, unknown>[]): number {
  let total = 0;
  for (const s of segments) total += s.weight;
  return total;
}

/** Throws unless `cutoff` is an integer in `[-1, segments.length - 1]`. */
export function assertCutoff(timeline: Timeline<unknown, unknown>, cutoff: number): void {
  if (!Number.isSafeInteger(cutoff) || cutoff < -1 || cutoff >= timeline.segments.length) {
    throw new RangeError(`cutoff ${String(cutoff)} outside [-1, ${timeline.segments.length - 1}]`);
  }
}

/**
 * Default settlement: the deltas of segments `0..cutoff`, in timeline order, regardless of `reason`. Simulators
 * without special settlement rules (e.g. losses on failure) assign it directly: `settle: defaultSettle`.
 */
export function defaultSettle(timeline: Timeline<unknown, unknown>, cutoff: number): LedgerDelta[] {
  assertCutoff(timeline, cutoff);
  const out: LedgerDelta[] = [];
  for (let i = 0; i <= cutoff; i++) out.push(...(timeline.segments[i] as Segment<unknown, unknown>).deltas);
  return out;
}

/**
 * Replaces everything from `resumed.segments[0].index` (= `k`) on: keeps segments `0..k-1` of `original` and appends
 * the resumed ones; the outcome is the resumed one. Used for party revisions (`simulate` with `from`).
 */
export function spliceTimeline<E, S>(original: Timeline<E, S>, from: number, resumed: Timeline<E, S>): Timeline<E, S> {
  if (!Number.isSafeInteger(from) || from < 0 || from > original.segments.length) {
    throw new RangeError(`resume point ${String(from)} outside [0, ${original.segments.length}]`);
  }
  assertTimeline(resumed as Timeline<unknown, unknown>, from);
  return { segments: [...original.segments.slice(0, from), ...resumed.segments], outcome: resumed.outcome };
}

/**
 * Deterministic uint32 hash of a timeline: `hashSeed(stableStringify(timeline))` (FNV-1a 32 + murmur3 finalizer over
 * canonical JSON with sorted keys). Same inputs ⇒ same timeline ⇒ same hash, across processes and platforms; used for
 * golden tests and persisted alongside the seed and versions. Not cryptographic. Throws on non-JSON data.
 */
export function timelineHash(timeline: Timeline<unknown, unknown>): number {
  return hashSeed(stableStringify(timeline));
}
