/**
 * Monte Carlo estimates (docs/engine/expedition-kernel.md §2.6): run the simulator with N derived seeds, settle each
 * timeline as a natural end, and aggregate net holdings per actor and asset into integer percentiles plus outcome
 * counts/rates. Integer math only; the result is deterministic for `(simulator, input, runs, rootSeed)`.
 */

import { assetKey, netHoldings } from '@engine/economy';
import type { AssetRef } from '@engine/economy';
import { BP_SCALE, assertInt, assertSeed, deriveSeed, divFloor, mulDivFloor } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';

import { assertTimeline } from './timeline.ts';
import { OUTCOMES } from './types.ts';
import type { ExpeditionSimulator, Outcome, Timeline } from './types.ts';

export interface EstimateInput<Config, Snapshot> {
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  readonly budget: number;
}

/** Percentiles of one actor's net change of one asset across runs (runs where it did not change count as 0). */
export interface AssetEstimate {
  readonly actorId: string;
  readonly asset: AssetRef;
  readonly min: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

export interface EstimateResult {
  readonly runs: number;
  /** Number of runs per outcome; sums to `runs`. */
  readonly outcomes: Readonly<Record<Outcome, number>>;
  /** `⌊count × 10 000 / runs⌋` per outcome (floored, so the rates may sum to slightly less than 10 000). */
  readonly outcomeRatesBp: Readonly<Record<Outcome, number>>;
  /** Sorted by actorId, then asset key. */
  readonly assets: readonly AssetEstimate[];
}

/**
 * Nearest-rank percentile of an ascending-sorted, non-empty list of integers: the value at rank `⌈p × n / 100⌉`
 * (at least 1). `p` is an integer percent in `[0, 100]`.
 */
export function nearestRank(sorted: readonly number[], p: number): number {
  assertInt(p, 'p');
  if (p < 0 || p > 100) throw new RangeError('p must be in [0, 100]');
  if (sorted.length === 0) throw new RangeError('nearestRank of an empty list');
  const rank = divFloor(p * sorted.length + 99, 100);
  return sorted[(rank < 1 ? 1 : rank) - 1] as number;
}

/** Seed of Monte Carlo sample `i`: `deriveSeed(rootSeed, 'estimate', i)`. */
export function estimateSeed(rootSeed: Seed, i: number): Seed {
  return deriveSeed(rootSeed, 'estimate', i);
}

/**
 * Runs `simulate` `runs` times with `estimateSeed(rootSeed, i)`, settles each full timeline with reason `completed`
 * (natural end; the timeline's own outcome decides what the simulator grants) and aggregates.
 */
export function estimate<Config, Snapshot>(
  simulator: ExpeditionSimulator<Config, Snapshot, unknown, unknown, unknown>,
  input: EstimateInput<Config, Snapshot>,
  runs: number,
  rootSeed: Seed,
): EstimateResult {
  assertInt(runs, 'runs');
  if (runs <= 0) throw new RangeError('runs must be > 0');
  assertSeed(rootSeed, 'rootSeed');

  const outcomes: Record<Outcome, number> = { completed: 0, retreated: 0, failed: 0 };
  const samples = new Map<string, { actorId: string; asset: AssetRef; values: number[] }>();
  for (let i = 0; i < runs; i++) {
    const timeline = simulator.simulate({
      config: input.config,
      actors: input.actors,
      seed: estimateSeed(rootSeed, i),
      budget: input.budget,
    });
    assertTimeline(timeline as Timeline<unknown, unknown>, 0, input.budget);
    outcomes[timeline.outcome] += 1;
    for (const h of netHoldings(simulator.settle(timeline, timeline.segments.length - 1, 'completed'))) {
      const key = JSON.stringify([h.actorId, assetKey(h.asset)]);
      let entry = samples.get(key);
      if (entry === undefined) {
        entry = { actorId: h.actorId, asset: h.asset, values: [] };
        samples.set(key, entry);
      }
      entry.values.push(h.qty);
    }
  }

  const assets = [...samples.values()]
    .map((e): AssetEstimate => {
      const values = e.values.concat(new Array<number>(runs - e.values.length).fill(0)).sort((a, b) => a - b);
      return {
        actorId: e.actorId,
        asset: e.asset,
        min: values[0] as number,
        p10: nearestRank(values, 10),
        p50: nearestRank(values, 50),
        p90: nearestRank(values, 90),
        max: values[values.length - 1] as number,
      };
    })
    .sort((a, b) => cmp(a.actorId, b.actorId) || cmp(assetKey(a.asset), assetKey(b.asset)));

  const outcomeRatesBp = Object.fromEntries(
    OUTCOMES.map((o) => [o, mulDivFloor(outcomes[o], BP_SCALE, runs)]),
  ) as Record<Outcome, number>;
  return { runs, outcomes, outcomeRatesBp, assets };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
