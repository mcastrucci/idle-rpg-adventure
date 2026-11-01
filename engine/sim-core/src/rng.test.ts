import { describe, expect, it } from 'vitest';

import { Rng, RngStreams } from './index.ts';
import type { RngState, RngStreamsState } from './index.ts';

const take = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.nextU32());
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('Rng known answers', () => {
  it('matches the reference PCG32 vector (pcg32-demo: pcg32_srandom_r(42, 54))', () => {
    // From the official pcg-c-basic `pcg32-demo.c` output; also cross-checked against a BigInt
    // implementation of pcg32_random_r over 200 random 64-bit seeds × 500 draws during development.
    const rng = Rng.fromPcg32({ hi: 0, lo: 42 }, { hi: 0, lo: 54 });
    expect(take(rng, 6)).toEqual([0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e]);
  });

  it('fromSeed sequences are frozen', () => {
    // Produced once by this implementation (whose core is verified by the vector above) and frozen:
    // changing them changes every replay, which requires an ENGINE_VERSION bump.
    expect(take(Rng.fromSeed(0), 5)).toEqual([0x761b0bb5, 0x1f3b7ebe, 0x7519351f, 0x41fd7f80, 0xb93a1a5d]);
    expect(take(Rng.fromSeed(1), 5)).toEqual([0xb47f77e1, 0x0cc623a7, 0xc55d6c18, 0xf2344862, 0x42cad5a4]);
    expect(take(Rng.fromSeed(42), 5)).toEqual([0x1fd2afa8, 0x280bbf7f, 0x98607f47, 0x07f8c565, 0xcf964682]);
    expect(take(Rng.fromSeed(0xffffffff), 5)).toEqual([0xca751dea, 0xbe960e8f, 0xee2a2488, 0x4fcf28e8, 0x0ddecb1d]);
  });

  it('int and bp sequences are frozen', () => {
    const rng = Rng.fromSeed(7);
    expect(Array.from({ length: 8 }, () => rng.int(1, 6))).toEqual([4, 1, 4, 3, 6, 5, 6, 4]);
    expect(Array.from({ length: 5 }, () => rng.bp())).toEqual([2328, 5030, 7898, 7047, 662]);
  });

  it('outputs are uint32', () => {
    const rng = Rng.fromSeed(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextU32();
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
    }
  });

  it('rejects invalid seeds', () => {
    for (const bad of [-1, 0x1_0000_0000, 1.5, Number.NaN]) expect(() => Rng.fromSeed(bad)).toThrow(RangeError);
  });
});

describe('Rng.int', () => {
  it('stays within inclusive bounds and hits both ends', () => {
    const rng = Rng.fromSeed(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(-3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(rng.int(5, 5)).toBe(5);
  });

  it('supports the full 2^32 span', () => {
    const rng = Rng.fromSeed(9);
    const a = Rng.fromSeed(9);
    expect(rng.int(-0x8000_0000, 0x7fff_ffff)).toBe(a.nextU32() - 0x8000_0000);
  });

  it('is roughly uniform (chi-square, 10 buckets, fixed seed)', () => {
    const rng = Rng.fromSeed(2024);
    const n = 100_000;
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) {
      const v = rng.int(0, 9);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    const expected = n / 10;
    // chi2 = Σ(c-E)²/E < 27.88 (df = 9, p = 0.001)  ⇔  Σ(c-E)² < 27.88·E, kept in integers.
    const sumSq = counts.reduce((acc, c) => acc + (c - expected) * (c - expected), 0);
    expect(sumSq).toBeLessThan(2788 * (expected / 100));
  });

  it('is unbiased where plain modulo would be heavily biased', () => {
    // range = 3·2^30: `nextU32() % range` would put 50 % of draws in the lowest third.
    const rng = Rng.fromSeed(77);
    const third = 0x4000_0000;
    const counts = [0, 0, 0];
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      const bucket = Math.floor(rng.int(0, 3 * third - 1) / third);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(9_500);
      expect(c).toBeLessThan(10_500);
    }
  });

  it('validates arguments', () => {
    const rng = Rng.fromSeed(1);
    expect(() => rng.int(2, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 3)).toThrow(RangeError);
    expect(() => rng.int(0, Number.NaN)).toThrow(RangeError);
    expect(() => rng.int(0, 0x1_0000_0000)).toThrow(RangeError);
    expect(() => rng.int(0, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe('Rng.chanceBp / pickWeighted', () => {
  it('chanceBp honours the extremes and always consumes one draw', () => {
    const a = Rng.fromSeed(5);
    const b = Rng.fromSeed(5);
    for (let i = 0; i < 100; i++) {
      expect(a.chanceBp(0)).toBe(false);
      expect(a.chanceBp(10_000)).toBe(true);
      b.bp();
      b.bp();
    }
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it('chanceBp approximates the probability', () => {
    const rng = Rng.fromSeed(11);
    let hits = 0;
    for (let i = 0; i < 100_000; i++) if (rng.chanceBp(2_500)) hits++;
    expect(hits).toBeGreaterThan(24_400);
    expect(hits).toBeLessThan(25_600);
  });

  it('chanceBp validates its argument', () => {
    const rng = Rng.fromSeed(1);
    expect(() => rng.chanceBp(-1)).toThrow(RangeError);
    expect(() => rng.chanceBp(10_001)).toThrow(RangeError);
    expect(() => rng.chanceBp(0.5)).toThrow(RangeError);
  });

  it('pickWeighted follows weights and never picks zero-weight entries', () => {
    const rng = Rng.fromSeed(3);
    const entries = [
      { weight: 1, value: 'a' },
      { weight: 0, value: 'never' },
      { weight: 3, value: 'b' },
    ] as const;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40_000; i++) {
      const v = rng.pickWeighted(entries);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    expect(counts['never']).toBeUndefined();
    expect(counts['a']).toBeGreaterThan(9_400);
    expect(counts['a']).toBeLessThan(10_600);
    expect(rng.pickWeighted([{ weight: 7, value: 42 }])).toBe(42);
  });

  it('pickWeighted validates entries', () => {
    const rng = Rng.fromSeed(1);
    expect(() => rng.pickWeighted([])).toThrow(RangeError);
    expect(() => rng.pickWeighted([{ weight: 0, value: 1 }])).toThrow(RangeError);
    expect(() => rng.pickWeighted([{ weight: -1, value: 1 }])).toThrow(RangeError);
    expect(() => rng.pickWeighted([{ weight: 1.5, value: 1 }])).toThrow(RangeError);
    expect(() => rng.pickWeighted([{ weight: 0x1_0000_0001, value: 1 }])).toThrow(RangeError);
  });
});

describe('Rng state', () => {
  it('round-trips through JSON and continues identically', () => {
    const rng = Rng.fromSeed(99);
    take(rng, 17);
    const restored = Rng.fromState(roundTrip(rng.state()));
    expect(restored.state()).toEqual(rng.state());
    expect(take(restored, 50)).toEqual(take(rng, 50));
  });

  it('state() is a detached snapshot', () => {
    const rng = Rng.fromSeed(99);
    const snap = rng.state();
    rng.nextU32();
    expect(rng.state()).not.toEqual(snap);
  });

  it('fromState validates input', () => {
    const good = Rng.fromSeed(1).state();
    expect(() => Rng.fromState({ ...good, s0: -1 })).toThrow(RangeError);
    expect(() => Rng.fromState({ ...good, s1: 1.5 })).toThrow(RangeError);
    expect(() => Rng.fromState({ ...good, i1: 2 })).toThrow(RangeError);
    expect(() => Rng.fromState(null as unknown as RngState)).toThrow(TypeError);
  });
});

describe('RngStreams', () => {
  it('consuming one stream never changes another', () => {
    const a = RngStreams.fromSeed(42);
    const b = RngStreams.fromSeed(42);
    take(a.stream('loot'), 1000);
    a.stream('encounters').int(1, 100);
    expect(take(a.stream('combat'), 20)).toEqual(take(b.stream('combat'), 20));
  });

  it('creation order does not matter', () => {
    const a = RngStreams.fromSeed(7);
    const b = RngStreams.fromSeed(7);
    const aCombat = a.stream('combat');
    const aLoot = a.stream('loot');
    const bLoot = b.stream('loot');
    const bCombat = b.stream('combat');
    expect(take(aCombat, 10)).toEqual(take(bCombat, 10));
    expect(take(aLoot, 10)).toEqual(take(bLoot, 10));
    expect(a.state()).toEqual(b.state());
  });

  it('returns the same instance for repeated names, distinct sequences for distinct names', () => {
    const s = RngStreams.fromSeed(1);
    expect(s.stream('ai')).toBe(s.stream('ai'));
    expect(take(RngStreams.fromSeed(1).stream('ai'), 4)).not.toEqual(take(RngStreams.fromSeed(1).stream('loot'), 4));
    expect(take(RngStreams.fromSeed(1).stream('ai'), 4)).not.toEqual(take(RngStreams.fromSeed(2).stream('ai'), 4));
  });

  it('stream sequences are frozen', () => {
    expect(take(RngStreams.fromSeed(42).stream('combat'), 4)).toEqual([2697589195, 1947967654, 2752851364, 1416435523]);
  });

  it('state round-trips through JSON and continues identically', () => {
    const s = RngStreams.fromSeed(500);
    take(s.stream('loot'), 5);
    take(s.stream('combat'), 3);
    const state = s.state();
    expect(state.root).toBe(500);
    expect(state.streams.map((e) => e.name)).toEqual(['combat', 'loot']);
    const restored = RngStreams.fromState(roundTrip(state));
    expect(restored.state()).toEqual(state);
    expect(take(restored.stream('combat'), 10)).toEqual(take(s.stream('combat'), 10));
    expect(take(restored.stream('loot'), 10)).toEqual(take(s.stream('loot'), 10));
    expect(take(restored.stream('new'), 10)).toEqual(take(s.stream('new'), 10));
  });

  it('fromState validates input', () => {
    const state = RngStreams.fromSeed(1).state();
    expect(() => RngStreams.fromState({ ...state, root: -1 })).toThrow(RangeError);
    const dup: RngStreamsState = {
      root: 1,
      streams: [
        { name: 'x', state: Rng.fromSeed(1).state() },
        { name: 'x', state: Rng.fromSeed(2).state() },
      ],
    };
    expect(() => RngStreams.fromState(dup)).toThrow(RangeError);
  });
});
