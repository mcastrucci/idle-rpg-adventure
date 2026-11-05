/**
 * Expedition estimates (idle-simulation §8, concept §6.3, #53): read-only Monte Carlo over the same server-derived
 * snapshot and start gate as a real start, cached per canonical key and computed off the event loop.
 *
 * Flow: a short database transaction checks ownership and reads the build/rules/inventory snapshot exactly as `start`
 * does (`readStartSnapshot`, `gateStart`); it writes nothing (no ledger, activity or expedition rows). The CPU work runs
 * after the transaction on the estimate runner (worker pool by default), behind the LRU cache.
 */
import { KERNEL_VERSION } from '@engine/expedition-kernel';
import { requireOwnedActor } from '@engine/server-kit';
import type { ActorTransaction, Database, LoadedContent } from '@engine/server-kit';
import { parseExpeditionEstimateDto } from '@rpg/protocol';
import type { ExpeditionEstimateDto, ExpeditionEstimateRequest } from '@rpg/protocol';
import type { RpgIdleConfig } from '@rpg/rpg-sim';

import { RPG_GAME_ID } from '../characters/service.ts';
import { EstimateBusyError, EstimateCache } from './estimate-cache.ts';
import { estimateCacheKey, estimateRootSeed, estimateRunsFor } from './estimate-key.ts';
import { createWorkerEstimateRunner } from './estimate-runner.ts';
import type { EstimateRunner } from './estimate-runner.ts';
import { aggregateSamples } from './estimate-samples.ts';
import type { EstimateAggregate, EstimateJob } from './estimate-samples.ts';
import { ExpeditionError, gateStart, readStartSnapshot } from './service.ts';

export interface EstimateServiceOptions {
  /** Where samples are computed; default: a worker-thread pool (`createWorkerEstimateRunner`). */
  readonly createRunner?: (content: LoadedContent) => EstimateRunner;
  /** LRU capacity (finished results). Default 512 (each entry is well under 1 KiB). */
  readonly cacheEntries?: number;
  /** Distinct estimates computing at once before new ones get `503 estimate_busy`. Default 8. */
  readonly maxPending?: number;
  /** An existing cache to use instead of a new one (tests share one across content versions). */
  readonly cache?: EstimateCache<EstimateAggregate>;
  /** Staging only (debug tools enabled): technical seed areas may be estimated. Default false. */
  readonly exposeTechnicalAreas?: boolean;
}

/** Validates a candidate start like `start` does and returns the job inputs, without any write. */
async function prepareEstimate(tx: ActorTransaction, content: LoadedContent, accountId: string, actorId: string, body: ExpeditionEstimateRequest,
  exposeTechnicalAreas = false) {
  if (body.request.paceBp !== 10_000) throw new ExpeditionError('invalid_pace', 400);
  await requireOwnedActor(tx, actorId, accountId, RPG_GAME_ID);
  const { snapshot, context, holdings } = await readStartSnapshot(tx, actorId, content);
  const { simulator, gate } = gateStart(content, body.request, body.config, snapshot, context, undefined, exposeTechnicalAreas);
  // A real start escrows these from the inventory; estimate only what the character could actually bring.
  for (const delta of gate.escrow) {
    if (delta.asset.kind !== 'stack') continue;
    const item = delta.asset.item;
    const owned = holdings.filter(h => h.container === 'inventory' && h.asset.kind === 'stack' && h.asset.item === item).reduce((n, h) => n + h.qty, 0);
    if (owned < delta.qty) throw new ExpeditionError('insufficient_consumables', 409);
  }
  return { snapshot, config: gate.config as RpgIdleConfig, budget: gate.budget, simulatorId: simulator.id, simulatorVersion: simulator.version };
}

export function createEstimateService(content: LoadedContent, options: EstimateServiceOptions = {}) {
  const runner = (options.createRunner ?? (bundle => createWorkerEstimateRunner(bundle)))(content);
  // Start the worker threads (module loading, content parsing) at boot so the first estimate does not pay for it.
  void runner.warmUp?.();
  const cache = options.cache ?? new EstimateCache<EstimateAggregate>({ maxEntries: options.cacheEntries ?? 512, maxPending: options.maxPending ?? 8 });
  return {
    cache,
    async estimate(database: Database, accountId: string, actorId: string, body: ExpeditionEstimateRequest): Promise<ExpeditionEstimateDto> {
      const prepared = await database.db.transaction(tx => prepareEstimate(tx, content, accountId, actorId, body, options.exposeTechnicalAreas ?? false));
      const { areaId, activityId, durationMin, paceBp } = body.request;
      const runs = estimateRunsFor(prepared.budget);
      const key = estimateCacheKey({ kernelVersion: KERNEL_VERSION, simulatorId: prepared.simulatorId, simulatorVersion: prepared.simulatorVersion,
        contentHash: content.contentHash, areaId, activityId, durationMin, paceBp, runs, config: prepared.config, snapshot: prepared.snapshot });
      const job: EstimateJob = { areaId, activityId, budget: prepared.budget, config: prepared.config, snapshot: prepared.snapshot,
        runs, rootSeed: estimateRootSeed(key) };
      let result: { value: EstimateAggregate; cached: boolean };
      try {
        result = await cache.getOrCompute(key, async () => aggregateSamples(await runner.run(job), prepared.config));
      } catch (error) {
        if (error instanceof EstimateBusyError) throw new ExpeditionError('estimate_busy', 503);
        throw error;
      }
      return parseExpeditionEstimateDto({ estimate: true, actorId, areaId, activityId, durationMin, paceBp, ...result.value, cached: result.cached });
    },
    close: () => runner.close(),
  };
}
export type EstimateService = ReturnType<typeof createEstimateService>;
