/**
 * Monte Carlo sampling and aggregation of expedition estimates (idle-simulation §8, ADR-0019 `estimate`).
 *
 * A job of `runs` runs is split into a fixed number of chunks ({@link ESTIMATE_CHUNKS}); chunk `k` calls the kernel's
 * `estimate` with root seed `deriveSeed(rootSeed, 'estimate-chunk', k)` and a metrics extractor that records each
 * run's raw values. The chunks can run on different worker threads in any order; the merged samples, and therefore
 * the result, depend only on the job. Percentiles use the kernel's nearest-rank rule.
 */
import type { LedgerDelta } from '@engine/economy';
import { estimate, nearestRank } from '@engine/expedition-kernel';
import type { ActivityRegistry, Outcome, Timeline } from '@engine/expedition-kernel';
import { deriveSeed } from '@engine/sim-core';
import type { AreaId } from '@engine/world';
import { ESCROW, GOLD_CURRENCY, rpgIdleMetrics } from '@rpg/rpg-sim';
import type { RpgActorSnapshot, RpgIdleConfig, RpgIdleEvent, RpgIdleState } from '@rpg/rpg-sim';

/** Fixed chunk count: independent of the worker count, so results never depend on the pool size. */
export const ESTIMATE_CHUNKS = 4;

/** Everything a worker needs to run a job; plain data (structured-clone safe). */
export interface EstimateJob {
  readonly areaId: string;
  readonly activityId: string;
  readonly budget: number;
  readonly config: RpgIdleConfig;
  readonly snapshot: RpgActorSnapshot;
  readonly runs: number;
  readonly rootSeed: number;
}

/** Raw values of one simulated run, for the hero of the snapshot. */
export interface RunSample {
  readonly outcome: Outcome;
  /** Gross XP earned (a death penalty is applied by the server at settlement, not here). */
  readonly xp: number;
  /** Gold the natural-end settlement grants (after the death bag loss). */
  readonly gold: number;
  /** Consumables burned from escrow, by item. */
  readonly used: Readonly<Record<string, number>>;
}

/** Runs of chunk `chunk`: `runs` split as evenly as possible, earlier chunks taking the remainder. */
export function chunkRuns(runs: number, chunk: number): number {
  return Math.floor(runs / ESTIMATE_CHUNKS) + (chunk < runs % ESTIMATE_CHUNKS ? 1 : 0);
}

/** Runs one chunk of `job` through the kernel's `estimate` and returns its raw per-run samples (in run order). */
export function sampleChunk(registry: ActivityRegistry, job: EstimateJob, chunk: number): RunSample[] {
  if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= ESTIMATE_CHUNKS) throw new RangeError('invalid estimate chunk');
  const runs = chunkRuns(job.runs, chunk);
  if (runs === 0) return [];
  const simulator = registry.get(job.activityId);
  if (!simulator) throw new Error(`no simulator for ${job.activityId}`);
  const actorId = job.snapshot.actorId;
  const samples: RunSample[] = [];
  estimate(simulator, { config: job.config, actors: [job.snapshot], budget: job.budget, areaId: job.areaId as AreaId, activityId: job.activityId },
    runs, deriveSeed(job.rootSeed, 'estimate-chunk', chunk), {
      metrics: (timeline, settled) => {
        const metrics = rpgIdleMetrics(timeline as Timeline<RpgIdleEvent, RpgIdleState>);
        samples.push({ outcome: timeline.outcome, xp: metrics[`xp:${actorId}`] ?? 0, ...settledTotals(settled, actorId) });
        return metrics;
      },
    });
  return samples;
}

function settledTotals(settled: readonly LedgerDelta[], actorId: string): { gold: number; used: Record<string, number> } {
  let gold = 0;
  const used: Record<string, number> = {};
  for (const delta of settled) {
    if (delta.actorId !== actorId) continue;
    if (delta.asset.kind === 'currency' && delta.asset.currency === GOLD_CURRENCY && delta.from === undefined) gold += delta.qty;
    if (delta.asset.kind === 'stack' && delta.from === ESCROW && delta.to === undefined) used[delta.asset.item] = (used[delta.asset.item] ?? 0) + delta.qty;
  }
  return { gold, used };
}

export interface EstimateRange { readonly p10: number; readonly p50: number; readonly p90: number }

export interface EstimateAggregate {
  readonly n: number;
  readonly xp: EstimateRange;
  readonly gold: EstimateRange;
  /** One row per consumable brought (zero use included) or used, sorted by item. */
  readonly consumablesUsed: readonly (EstimateRange & { readonly item: string })[];
  /** `⌊count × 10 000 / n⌋` per outcome; `died` is the simulator's `failed` outcome. */
  readonly outcomeRatesBp: { readonly completed: number; readonly retreated: number; readonly died: number };
}

/** p10/p50/p90 with the kernel's nearest-rank rule (same as `estimate`'s percentiles). */
export function percentileRange(values: readonly number[]): EstimateRange {
  if (values.length === 0) throw new RangeError('no samples');
  const sorted = [...values].sort((a, b) => a - b);
  return { p10: nearestRank(sorted, 10), p50: nearestRank(sorted, 50), p90: nearestRank(sorted, 90) };
}

/** Aggregates merged samples (all chunks of one job, in chunk order) into the client-facing estimate figures. */
export function aggregateSamples(samples: readonly RunSample[], config: RpgIdleConfig): EstimateAggregate {
  const n = samples.length;
  if (n === 0) throw new RangeError('no samples');
  const items = new Set(config.consumables.map(c => c.item));
  for (const sample of samples) for (const item of Object.keys(sample.used)) items.add(item);
  const rate = (outcome: Outcome) => Math.floor(samples.filter(s => s.outcome === outcome).length * 10_000 / n);
  return {
    n,
    xp: percentileRange(samples.map(s => s.xp)),
    gold: percentileRange(samples.map(s => s.gold)),
    consumablesUsed: [...items].sort().map(item => ({ item, ...percentileRange(samples.map(s => s.used[item] ?? 0)) })),
    outcomeRatesBp: { completed: rate('completed'), retreated: rate('retreated'), died: rate('failed') },
  };
}
