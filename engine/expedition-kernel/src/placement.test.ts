import type { LedgerDelta } from '@engine/economy';
import { deriveSeed } from '@engine/sim-core';
import { describe, expect, it } from 'vitest';

import { cancelCutoff, placeSegments, revealCutoff, revisionSeed, visibleView } from './index.ts';
import type { Outcome, Segment, Timeline } from './index.ts';

type E = { readonly n: number };

function timeline(weights: number[], outcome: Outcome = 'completed', withState = false): Timeline<E, { secret: number }> {
  return {
    outcome,
    segments: weights.map(
      (weight, index): Segment<E, { secret: number }> => ({
        index,
        weight,
        events: [{ n: index }],
        deltas: [{ actorId: 'a', asset: { kind: 'currency', currency: 'coin' }, qty: index + 1, to: 'run_bag' } as LedgerDelta],
        ...(withState ? { stateAfter: { secret: 1000 + index } } : {}),
      }),
    ),
  };
}

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('placeSegments', () => {
  it('spreads a full-budget unit-weight timeline exactly over the duration', () => {
    const p = placeSegments(timeline([1, 1, 1, 1]), T0, 60_000, 4);
    expect(p.segments.map((s) => s.revealAtMs - T0)).toEqual([15_000, 30_000, 45_000, 60_000]);
    expect(p.endsAtMs).toBe(T0 + 60_000);
    expect(p.plannedEndsAtMs).toBe(T0 + 60_000);
  });

  it('uses cumulative uneven weights', () => {
    const p = placeSegments(timeline([1, 2, 1]), T0, 60_000, 4);
    expect(p.segments.map((s) => s.revealAtMs - T0)).toEqual([15_000, 45_000, 60_000]);
  });

  it('floors exactly and still ends exactly at the planned end', () => {
    const p = placeSegments(timeline([1, 1, 1]), 0, 1000, 3);
    expect(p.segments.map((s) => s.revealAtMs)).toEqual([333, 666, 1000]);
    const q = placeSegments(timeline([1, 1, 1, 1, 1, 1, 1]), 0, 100, 7);
    expect(q.segments.map((s) => s.revealAtMs)).toEqual([14, 28, 42, 57, 71, 85, 100]);
  });

  it('allows shared reveal times when the duration is shorter than the budget', () => {
    const p = placeSegments(timeline([1, 1, 1, 1]), 0, 2, 4);
    expect(p.segments.map((s) => s.revealAtMs)).toEqual([0, 1, 1, 2]);
  });

  it('ends early when the timeline stops before consuming the budget', () => {
    const p = placeSegments(timeline([1, 1, 1], 'failed'), T0, HOUR, 10);
    expect(p.segments.map((s) => s.revealAtMs - T0)).toEqual([360_000, 720_000, 1_080_000]);
    expect(p.endsAtMs).toBe(T0 + 1_080_000);
    expect(p.plannedEndsAtMs).toBe(T0 + HOUR);
  });

  it('ends at startsAt for an empty early-terminated timeline', () => {
    const p = placeSegments(timeline([], 'retreated'), T0, HOUR, 10);
    expect(p.endsAtMs).toBe(T0);
  });

  it('handles 180-minute expeditions with large budgets exactly', () => {
    const budget = 1_000_003;
    const p = placeSegments(timeline([budget]), T0, 180 * 60_000, budget);
    expect(p.endsAtMs).toBe(T0 + 180 * 60_000);
  });

  it('rejects invalid input', () => {
    expect(() => placeSegments(timeline([1, 2]), 0, 1000, 2)).toThrow(/exceeds budget/);
    expect(() => placeSegments(timeline([1, 0]), 0, 1000, 2)).toThrow(/weight/);
    expect(() => placeSegments({ outcome: 'completed', segments: [{ index: 1, weight: 1, events: [], deltas: [] }] }, 0, 1000, 2)).toThrow(/index/);
    expect(() => placeSegments(timeline([1]), 0.5, 1000, 2)).toThrow(RangeError);
    expect(() => placeSegments(timeline([1]), 0, -1, 2)).toThrow(RangeError);
    expect(() => placeSegments(timeline([]), 0, 1000, 0)).toThrow(RangeError);
  });
});

describe('revealCutoff / cancelCutoff', () => {
  const p = placeSegments(timeline([1, 2, 1]), 0, 4000, 4); // reveals at 1000, 3000, 4000

  it('returns the last segment with revealAt <= now', () => {
    expect([-1, 0, 999, 1000, 2999, 3000, 3999, 4000, 99_999].map((t) => revealCutoff(p, t))).toEqual([
      -1, -1, -1, 0, 0, 1, 1, 2, 2,
    ]);
  });

  it('cancel cutoff equals the reveal cutoff', () => {
    for (const t of [0, 1000, 2500, 4000]) expect(cancelCutoff(p, t)).toBe(revealCutoff(p, t));
  });

  it('works with shared reveal times', () => {
    const q = placeSegments(timeline([1, 1, 1, 1]), 0, 2, 4); // 0, 1, 1, 2
    expect([0, 1, 2].map((t) => revealCutoff(q, t))).toEqual([0, 2, 3]);
  });
});

describe('visibleView', () => {
  const failed = placeSegments(timeline([1, 1, 1], 'failed', true), 0, 10_000, 10); // 1000, 2000, 3000; ends 3000

  it('never leaks the outcome, the actual end or future segments before the end', () => {
    for (const now of [0, 999, 1000, 2500, 2999]) {
      const v = visibleView(failed, now);
      const json = JSON.stringify(v);
      expect(v.ended).toBe(false);
      expect(v.outcome).toBeUndefined();
      expect(v.endedAtMs).toBeUndefined();
      expect(json).not.toContain('failed');
      expect(json).not.toContain('3000'); // the actual end time
      expect(v.plannedEndsAtMs).toBe(10_000);
      expect(v.segments.every((s) => s.revealAtMs <= now)).toBe(true);
      expect(v.segments.length).toBe(revealCutoff(failed, now) + 1);
    }
  });

  it('never exposes stateAfter', () => {
    const v = visibleView(failed, 50_000);
    expect(JSON.stringify(v)).not.toContain('secret');
  });

  it('aggregates revealed deltas only', () => {
    const v = visibleView(failed, 2000);
    expect(v.cutoff).toBe(1);
    expect(v.revealedDeltas).toEqual([{ actorId: 'a', asset: { kind: 'currency', currency: 'coin' }, container: 'run_bag', qty: 3 }]);
  });

  it('shows the outcome exactly from endsAt', () => {
    const v = visibleView(failed, 3000);
    expect(v).toMatchObject({ ended: true, outcome: 'failed', endedAtMs: 3000, cutoff: 2 });
    expect(v.segments).toHaveLength(3);
  });

  it('shows a completed outcome only at the planned end', () => {
    const p = placeSegments(timeline([1, 1]), 0, 2000, 2);
    expect(visibleView(p, 1999).outcome).toBeUndefined();
    expect(visibleView(p, 2000).outcome).toBe('completed');
  });
});

describe('revisionSeed', () => {
  it('keeps revision 0 and derives later revisions', () => {
    expect(revisionSeed(123, 0)).toBe(123);
    expect(revisionSeed(123, 1)).toBe(deriveSeed(123, 'revision', 1));
    expect(revisionSeed(123, 2)).not.toBe(revisionSeed(123, 1));
    expect(() => revisionSeed(123, -1)).toThrow(RangeError);
    expect(() => revisionSeed(-5, 1)).toThrow(RangeError);
  });
});
