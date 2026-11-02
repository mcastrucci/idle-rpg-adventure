/**
 * Estimate cache key (idle-simulation §8): everything that determines an estimate result, canonicalized so that equal
 * inputs always produce the same key and any change of build, rules, target, duration, pace, configuration, content
 * or simulator/kernel version produces a different one.
 */
import { createHash } from 'node:crypto';

import { stableStringify } from '@engine/expedition-kernel';
import type { RpgActorSnapshot, RpgIdleConfig } from '@rpg/rpg-sim';

/**
 * Version of the server's estimate procedure (run count rule, chunking, root seed derivation, metrics, aggregation).
 * Part of the key: bump it whenever any of these change so stale cached results can never be served.
 */
export const ESTIMATE_MODEL_VERSION = 1;

/**
 * Cost ceiling of one estimate in simulated segments (`runs × budget`) and the run-count bounds. Region 1 hunts cost
 * about 0.3 ms per segment on the reference container, so 5 000 segments (about 1.6 s on one thread) stay below the 2 s spike-1 budget even
 * without parallel workers. Provisional, see the server README (Estimates).
 */
export const ESTIMATE_SEGMENT_BUDGET = 5_000;
export const ESTIMATE_MIN_RUNS = 60;
export const ESTIMATE_MAX_RUNS = 200;

/** Number of Monte Carlo runs for an expedition of `budget` segments: `clamp(⌊5000 / budget⌋, 60, 200)`. */
export function estimateRunsFor(budget: number): number {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError('budget must be a positive integer');
  return Math.min(ESTIMATE_MAX_RUNS, Math.max(ESTIMATE_MIN_RUNS, Math.floor(ESTIMATE_SEGMENT_BUDGET / budget)));
}

export interface EstimateKeyInput {
  readonly kernelVersion: string;
  readonly simulatorId: string;
  readonly simulatorVersion: string;
  readonly contentHash: string;
  readonly areaId: string;
  readonly activityId: string;
  readonly durationMin: number;
  readonly paceBp: number;
  readonly runs: number;
  readonly config: RpgIdleConfig;
  readonly snapshot: RpgActorSnapshot;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Canonical estimate configuration: consumables sorted by item (their order never changes a run) and the retreat
 * policy. Items with the same ID cannot repeat (the simulator rejects duplicates).
 */
export function canonicalEstimateConfig(config: RpgIdleConfig): RpgIdleConfig {
  const consumables = [...config.consumables].map(c => ({ item: c.item, qty: c.qty }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return { consumables, retreat: { belowHpBp: config.retreat.belowHpBp, onlyWhenNoHealing: config.retreat.onlyWhenNoHealing } };
}

/**
 * The canonical key document: separate hashes of the build (snapshot without rules), the automation rules and the
 * configuration, plus the target, duration, pace, run count, content hash and versions. Object keys are sorted by
 * `stableStringify`; array order is kept (equipment order follows the ledger's sorted holdings, skill order is
 * meaningful for the combat engine).
 */
export function canonicalEstimateKey(input: EstimateKeyInput): string {
  const { rules, ...build } = input.snapshot;
  return stableStringify({
    model: ESTIMATE_MODEL_VERSION,
    kernelVersion: input.kernelVersion,
    simulatorId: input.simulatorId,
    simulatorVersion: input.simulatorVersion,
    contentHash: input.contentHash,
    areaId: input.areaId,
    activityId: input.activityId,
    durationMin: input.durationMin,
    paceBp: input.paceBp,
    runs: input.runs,
    buildHash: sha256(stableStringify(build)),
    rulesHash: sha256(stableStringify(rules)),
    configHash: sha256(stableStringify(canonicalEstimateConfig(input.config))),
  });
}

/** SHA-256 (hex) of the canonical key document; used as the cache key. */
export function estimateCacheKey(input: EstimateKeyInput): string {
  return sha256(canonicalEstimateKey(input));
}

/**
 * Root seed of the Monte Carlo runs: a 32-bit value derived from the cache key, so a cached and a recomputed estimate
 * are identical. It is unrelated to any real start seed, which the server draws from `crypto.randomBytes` at start.
 */
export function estimateRootSeed(cacheKey: string): number {
  return Number.parseInt(sha256(`estimate-seed:${cacheKey}`).slice(0, 8), 16);
}
