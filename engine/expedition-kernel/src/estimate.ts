/**
 * Monte Carlo estimates (docs/engine/expedition-kernel.md §2.6): run the simulator with N derived seeds, settle each
 * timeline as a natural end, and aggregate net holdings per actor and asset — plus, optionally, game-defined integer
 * metrics (v0.3, e.g. XP) — into integer percentiles, with outcome counts/rates. Integer math only; the result is
 * deterministic for `(simulator, input, runs, rootSeed, metrics)`.
 */

import { assetKey, netHoldings } from '@engine/economy';
import type { AssetRef, LedgerDelta } from '@engine/economy';
import { BP_SCALE, assertInt, assertSeed, deriveSeed, divFloor, mulDivFloor } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';
import type { AreaId } from '@engine/world';

import { assertTimeline } from './timeline.ts';
import { OUTCOMES } from './types.ts';
import type { ExpeditionSimulator, Outcome, Timeline } from './types.ts';

export interface EstimateInput<Config, Snapshot> {
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  readonly budget: number;
  /** The expedition's target (v0.3), passed to `simulate`; needed by simulators whose model depends on it. */
  readonly areaId?: AreaId;
  readonly activityId?: string;
}

/**
 * Game-provided extractor of non-ledger outcomes (v0.3), e.g. XP per hero: called once per run with the full timeline
 * and its `completed` settlement; returns integer values by stable key (e.g. `xp:<actorId>`). Keys missing in a run
 * count as 0 for that run. Must be pure and deterministic; values must be safe integers.
 */
export type EstimateMetrics<Event, SimState> = (
  timeline: Timeline<Event, SimState>,
  settled: readonly LedgerDelta[],
) => Readonly<Record<string, number>>;

export interface EstimateOptions<Event, SimState> {
  readonly metrics?: EstimateMetrics<Event, SimState>;
}

/** Nearest-rank percentiles of a list of integers. */
export interface Percentiles {
  readonly min: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

/** Percentiles of one actor's net change of one asset across runs (runs where it did not change count as 0). */
export interface AssetEstimate extends Percentiles {
  readonly actorId: string;
  readonly asset: AssetRef;
}

/** Percentiles of one game metric across runs (runs without the key count as 0). */
export interface MetricEstimate extends Percentiles {
  readonly key: string;
}

export interface EstimateResult {
  readonly runs: number;
  /** Number of runs per outcome; sums to `runs`. */
  readonly outcomes: Readonly<Record<Outcome, number>>;
  /** `⌊count × 10 000 / runs⌋` per outcome (floored, so the rates may sum to slightly less than 10 000). */
  readonly outcomeRatesBp: Readonly<Record<Outcome, number>>;
  /** Sorted by actorId, then asset key. */
  readonly assets: readonly AssetEstimate[];
  /** Game metrics (`options.metrics`), sorted by key; `[]` without an extractor. */
  readonly metrics: readonly MetricEstimate[];
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

/** Percentiles of `values` padded with zeros up to `runs` entries (runs without a value count as 0). */
function percentiles(values: readonly number[], runs: number): Percentiles {
  const sorted = values.concat(new Array<number>(runs - values.length).fill(0)).sort((a, b) => a - b);
  return {
    min: sorted[0] as number,
    p10: nearestRank(sorted, 10),
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    max: sorted[sorted.length - 1] as number,
  };
}

/**
 * Runs `simulate` `runs` times with `estimateSeed(rootSeed, i)` (and the input's `areaId`/`activityId`), settles each
 * full timeline with reason `completed` (natural end; the timeline's own outcome decides what the simulator grants)
 * and aggregates net holdings, plus `options.metrics(timeline, settled)` per run with the same percentile rule.
 */
export function estimate<Config, Snapshot, Event = unknown, SimState = unknown>(
  simulator: ExpeditionSimulator<Config, Snapshot, Event, SimState, unknown, unknown>,
  input: EstimateInput<Config, Snapshot>,
  runs: number,
  rootSeed: Seed,
  options: EstimateOptions<Event, SimState> = {},
): EstimateResult {
  assertInt(runs, 'runs');
  if (runs <= 0) throw new RangeError('runs must be > 0');
  assertSeed(rootSeed, 'rootSeed');

  const outcomes: Record<Outcome, number> = { completed: 0, retreated: 0, failed: 0 };
  const samples = new Map<string, { actorId: string; asset: AssetRef; values: number[] }>();
  const metricSamples = new Map<string, number[]>();
  for (let i = 0; i < runs; i++) {
    const timeline = simulator.simulate({
      config: input.config,
      actors: input.actors,
      seed: estimateSeed(rootSeed, i),
      budget: input.budget,
      ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
      ...(input.activityId === undefined ? {} : { activityId: input.activityId }),
    });
    assertTimeline(timeline as Timeline<unknown, unknown>, 0, input.budget);
    outcomes[timeline.outcome] += 1;
    const settled = simulator.settle(timeline, timeline.segments.length - 1, 'completed');
    for (const h of netHoldings(settled)) {
      const key = JSON.stringify([h.actorId, assetKey(h.asset)]);
      let entry = samples.get(key);
      if (entry === undefined) {
        entry = { actorId: h.actorId, asset: h.asset, values: [] };
        samples.set(key, entry);
      }
      entry.values.push(h.qty);
    }
    if (options.metrics !== undefined) {
      for (const [key, value] of Object.entries(options.metrics(timeline, settled))) {
        assertInt(value, `metric ${key}`);
        let values = metricSamples.get(key);
        if (values === undefined) {
          values = [];
          metricSamples.set(key, values);
        }
        values.push(value);
      }
    }
  }

  const assets = [...samples.values()]
    .map((e): AssetEstimate => ({ actorId: e.actorId, asset: e.asset, ...percentiles(e.values, runs) }))
    .sort((a, b) => cmp(a.actorId, b.actorId) || cmp(assetKey(a.asset), assetKey(b.asset)));
  const metrics = [...metricSamples.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([key, values]): MetricEstimate => ({ key, ...percentiles(values, runs) }));

  const outcomeRatesBp = Object.fromEntries(
    OUTCOMES.map((o) => [o, mulDivFloor(outcomes[o], BP_SCALE, runs)]),
  ) as Record<Outcome, number>;
  return { runs, outcomes, outcomeRatesBp, assets, metrics };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
