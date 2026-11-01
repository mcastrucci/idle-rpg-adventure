import { describe, expect, it } from 'vitest';

import { coinCollector, weightOf } from './__tests__/coin-collector.ts';
import {
  KERNEL_VERSION,
  defaultSettle,
  placeSegments,
  revisionSeed,
  spliceTimeline,
  stableStringify,
  segmentSeed,
  segmentStreams,
  timelineHash,
  timelineProblems,
  totalWeight,
} from './index.ts';
import { deriveSeed, hashSeed } from '@engine/sim-core';

describe('KERNEL_VERSION', () => {
  it('is a semver string', () => {
    expect(KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively and omits undefined properties', () => {
    expect(stableStringify({ b: 1, a: [{ d: true, c: null }], u: undefined })).toBe('{"a":[{"c":null,"d":true}],"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('rejects non-JSON data', () => {
    for (const bad of [Number.NaN, Infinity, 1n, () => 1, undefined, [undefined], new Map(), Symbol('x')]) {
      expect(() => stableStringify(bad)).toThrow(TypeError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/cyclic/);
    const shared = { x: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
});

describe('defaultSettle', () => {
  const t = coinCollector.simulate({ config: { maxCoins: 9, hazardBp: 0 }, actors: [{ id: 'a' }], seed: 3, budget: 8 });

  it('returns the deltas of segments 0..cutoff only', () => {
    expect(defaultSettle(t, -1)).toEqual([]);
    expect(defaultSettle(t, 1)).toEqual([...(t.segments[0]?.deltas ?? []), ...(t.segments[1]?.deltas ?? [])]);
    expect(defaultSettle(t, t.segments.length - 1)).toEqual(t.segments.flatMap((s) => s.deltas));
  });

  it('rejects out-of-range cutoffs', () => {
    expect(() => defaultSettle(t, -2)).toThrow(RangeError);
    expect(() => defaultSettle(t, t.segments.length)).toThrow(RangeError);
  });
});

describe('timelineProblems', () => {
  it('reports every structural problem', () => {
    const problems = timelineProblems(
      {
        outcome: 'exploded' as never,
        segments: [
          { index: 0, weight: 0, events: [], deltas: [] },
          { index: 2, weight: 1.5, events: [], deltas: [{ actorId: 'a', asset: { kind: 'currency', currency: 'c' }, qty: 0.5 }] },
        ],
      },
      0,
    );
    expect(problems).toHaveLength(5);
  });
});

describe('party resumption', () => {
  it('splices a resumed simulation and places it on the original schedule', () => {
    const config = { maxCoins: 5, hazardBp: 0 };
    const actors = [{ id: 'a' }, { id: 'b' }];
    const budget = 9;
    const original = coinCollector.simulate({ config, actors, seed: 42, budget });
    expect(totalWeight(original.segments)).toBe(budget); // weights 1,1,2,1,1,2,1 = 9

    const k = 3;
    const state = original.segments[k - 1]?.stateAfter;
    if (state === undefined) throw new Error('missing stateAfter');
    const remaining = budget - totalWeight(original.segments.slice(0, k));
    const resumed = coinCollector.simulate({
      config,
      actors: [{ id: 'a' }], // b left
      seed: revisionSeed(42, 1),
      budget: remaining,
      from: { segment: k, state },
    });
    expect(resumed.segments[0]?.index).toBe(k);
    expect(resumed.segments[0]?.weight).toBe(weightOf(k));

    const spliced = spliceTimeline(original, k, resumed);
    expect(spliced.segments.slice(0, k)).toEqual(original.segments.slice(0, k));
    expect(spliced.segments.slice(k).every((s) => s.deltas.every((d) => d.actorId === 'a'))).toBe(true);
    const placed = placeSegments(spliced, 0, 90_000, budget);
    expect(placed.segments.slice(0, k).map((s) => s.revealAtMs)).toEqual([10_000, 20_000, 40_000]);
    expect(placed.endsAtMs).toBe(90_000);
  });

  it('rejects a resumed timeline that does not start at the resume point', () => {
    const t = coinCollector.simulate({ config: { maxCoins: 5, hazardBp: 0 }, actors: [{ id: 'a' }], seed: 1, budget: 4 });
    expect(() => spliceTimeline(t, 1, t)).toThrow(/index/);
    expect(() => spliceTimeline(t, 99, t)).toThrow(RangeError);
  });
});

describe('timelineHash', () => {
  it('is a deterministic uint32 of the canonical JSON, independent of key order', () => {
    const t = coinCollector.simulate({ config: { maxCoins: 5, hazardBp: 1000 }, actors: [{ id: 'a' }], seed: 11, budget: 9 });
    const h = timelineHash(t);
    expect(h).toBe(hashSeed(stableStringify(t)));
    expect(h >>> 0).toBe(h);
    expect(timelineHash(structuredClone(t))).toBe(h);
    expect(timelineHash({ outcome: t.outcome, segments: t.segments })).toBe(h);
    expect(timelineHash({ ...t, outcome: 'failed' === t.outcome ? 'completed' : 'failed' })).not.toBe(h);
  });
});

describe('segmentSeed / segmentStreams', () => {
  it("derives per-segment streams from deriveSeed(seed, 'segment', index)", () => {
    expect(segmentSeed(42, 3)).toBe(deriveSeed(42, 'segment', 3));
    expect(segmentStreams(42, 3).stream('x').nextU32()).toBe(segmentStreams(42, 3).stream('x').nextU32());
    expect(segmentStreams(42, 3).stream('x').nextU32()).not.toBe(segmentStreams(42, 4).stream('x').nextU32());
    expect(() => segmentSeed(42, -1)).toThrow(RangeError);
  });
});
