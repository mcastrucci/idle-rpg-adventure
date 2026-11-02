import { netHoldings } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { COIN, coinCollector } from './__tests__/coin-collector.ts';
import type { CoinEvent, CoinState } from './__tests__/coin-collector.ts';
import { estimate, estimateSeed, nearestRank } from './index.ts';
import type { Timeline } from './index.ts';

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

  it('aggregates game metrics with the same nearest-rank percentiles (missing keys count as 0)', () => {
    const config = { maxCoins: 10, hazardBp: 1500 };
    const runs = 40;
    const metrics = (t: Timeline<CoinEvent, CoinState>, settled: readonly LedgerDelta[]): Record<string, number> => {
      const out: Record<string, number> = { segments: t.segments.length };
      if (t.outcome === 'failed') out['failed'] = 1;
      out['deltas'] = settled.length;
      return out;
    };
    const result = estimate(coinCollector, { config, actors, budget: 12 }, runs, 77, { metrics });
    const plain = estimate(coinCollector, { config, actors, budget: 12 }, runs, 77);
    expect(plain.metrics).toEqual([]);
    expect({ ...result, metrics: [] }).toEqual(plain);
    expect(result.metrics.map((m) => m.key)).toEqual(['deltas', 'failed', 'segments']);

    const lengths: number[] = [];
    for (let i = 0; i < runs; i++) lengths.push(coinCollector.simulate({ config, actors, seed: estimateSeed(77, i), budget: 12 }).segments.length);
    lengths.sort((x, y) => x - y);
    expect(result.metrics.find((m) => m.key === 'segments')).toEqual({
      key: 'segments',
      min: lengths[0],
      p10: lengths[3], // rank ceil(10*40/100) = 4
      p50: lengths[19],
      p90: lengths[35],
      max: lengths[39],
    });
    const failed = result.metrics.find((m) => m.key === 'failed');
    expect(failed?.max).toBe(1);
    expect(failed?.min).toBe(0); // runs without the key count as 0
  });

  it('passes the target to simulate and rejects non-integer metrics', () => {
    const seen: string[] = [];
    const sim = { ...coinCollector, simulate: (input: Parameters<typeof coinCollector.simulate>[0]) => (seen.push(input.activityId ?? '-'), coinCollector.simulate(input)) };
    estimate(sim, { config: { maxCoins: 1, hazardBp: 0 }, actors, budget: 3, areaId: 'area:x', activityId: 'activity:y' }, 2, 1);
    expect(seen).toEqual(['activity:y', 'activity:y']);
    expect(() => estimate(coinCollector, { config: { maxCoins: 1, hazardBp: 0 }, actors, budget: 3 }, 2, 1, { metrics: () => ({ x: 0.5 }) })).toThrow(RangeError);
  });

  it('rejects bad arguments', () => {
    const input = { config: { maxCoins: 1, hazardBp: 0 }, actors, budget: 3 };
    expect(() => estimate(coinCollector, input, 0, 1)).toThrow(RangeError);
    expect(() => estimate(coinCollector, input, 1, -1)).toThrow(RangeError);
  });
});
