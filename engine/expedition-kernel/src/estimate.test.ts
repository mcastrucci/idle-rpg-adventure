import { netHoldings } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { COIN, coinCollector } from './__tests__/coin-collector.ts';
import { estimate, estimateSeed, nearestRank } from './index.ts';

describe('nearestRank', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses rank ceil(p*n/100), at least 1', () => {
    expect(nearestRank(values, 0)).toBe(1);
    expect(nearestRank(values, 10)).toBe(1);
    expect(nearestRank(values, 11)).toBe(2);
    expect(nearestRank(values, 50)).toBe(5);
    expect(nearestRank(values, 90)).toBe(9);
    expect(nearestRank(values, 100)).toBe(10);
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([1, 2, 3], 50)).toBe(2);
  });

  it('rejects bad input', () => {
    expect(() => nearestRank([], 50)).toThrow(RangeError);
    expect(() => nearestRank(values, 101)).toThrow(RangeError);
    expect(() => nearestRank(values, 2.5)).toThrow(RangeError);
  });
});

describe('estimate', () => {
  const actors = [{ id: 'b' }, { id: 'a' }];

  it('matches a manual aggregation of the same seeds', () => {
    const config = { maxCoins: 10, hazardBp: 1500 };
    const runs = 50;
    const result = estimate(coinCollector, { config, actors, budget: 12 }, runs, 77);

    const perActor: Record<string, number[]> = { a: [], b: [] };
    const outcomes = { completed: 0, retreated: 0, failed: 0 };
    for (let i = 0; i < runs; i++) {
      const t = coinCollector.simulate({ config, actors, seed: estimateSeed(77, i), budget: 12 });
      outcomes[t.outcome]++;
      const net = netHoldings(coinCollector.settle(t, t.segments.length - 1, 'completed'));
      for (const id of ['a', 'b']) perActor[id]?.push(net.find((h) => h.actorId === id)?.qty ?? 0);
    }
    expect(result.runs).toBe(runs);
    expect(result.outcomes).toEqual(outcomes);
    expect(outcomes.failed).toBeGreaterThan(0);
    expect(outcomes.completed).toBeGreaterThan(0);
    expect(result.outcomeRatesBp.failed).toBe(Math.floor((outcomes.failed * 10_000) / runs));
    expect(result.assets.map((a) => a.actorId)).toEqual(['a', 'b']);
    for (const a of result.assets) {
      const sorted = [...(perActor[a.actorId] as number[])].sort((x, y) => x - y);
      expect(a.asset).toEqual(COIN);
      expect(a).toMatchObject({
        min: sorted[0],
        p10: sorted[4], // rank ceil(10*50/100) = 5
        p50: sorted[24], // rank 25
        p90: sorted[44], // rank 45
        max: sorted[49],
      });
      expect(a.p10).toBeLessThanOrEqual(a.p50);
      expect(a.p50).toBeLessThanOrEqual(a.p90);
      for (const v of [a.min, a.p10, a.p50, a.p90, a.max]) expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it('is deterministic and seed-dependent', () => {
    const input = { config: { maxCoins: 5, hazardBp: 1000 }, actors, budget: 9 };
    expect(estimate(coinCollector, input, 30, 1)).toEqual(estimate(coinCollector, input, 30, 1));
    expect(estimate(coinCollector, input, 30, 1)).not.toEqual(estimate(coinCollector, input, 30, 2));
  });

  it('reports exact rates in basis points', () => {
    const safe = estimate(coinCollector, { config: { maxCoins: 3, hazardBp: 0 }, actors, budget: 6 }, 7, 5);
    expect(safe.outcomes).toEqual({ completed: 7, retreated: 0, failed: 0 });
    expect(safe.outcomeRatesBp).toEqual({ completed: 10_000, retreated: 0, failed: 0 });

    const doomed = estimate(coinCollector, { config: { maxCoins: 3, hazardBp: 10_000 }, actors, budget: 6 }, 3, 5);
    expect(doomed.outcomeRatesBp).toEqual({ completed: 0, retreated: 0, failed: 10_000 });

    const retreat = estimate(coinCollector, { config: { maxCoins: 3, hazardBp: 0, retreatAtCoins: 1 }, actors, budget: 6 }, 3, 5);
    expect(retreat.outcomes.retreated).toBe(3);
  });

  it('counts runs without a change as zero', () => {
    const zero = estimate(coinCollector, { config: { maxCoins: 0, hazardBp: 0 }, actors, budget: 3 }, 5, 9);
    expect(zero.assets).toEqual([]);
  });

  it('rejects bad arguments', () => {
    const input = { config: { maxCoins: 1, hazardBp: 0 }, actors, budget: 3 };
    expect(() => estimate(coinCollector, input, 0, 1)).toThrow(RangeError);
    expect(() => estimate(coinCollector, input, 1, -1)).toThrow(RangeError);
  });
});
