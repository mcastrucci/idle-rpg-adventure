/**
 * Estimate latency (#53, spike-1 budget: a 200-run estimate < 2 s, or cacheable). Opt-in, not part of `pnpm check`:
 *
 *   RPG_ESTIMATE_BENCH=1 pnpm exec vitest run --project @rpg/server expeditions/estimate.bench --silent=false
 *
 * Measures, for the Region 1 reference build Bulwark L4 (survives the full timeline, so every run costs the whole
 * budget), the cold time of one estimate on the inline runner and on the worker pool (each with its own fresh pool,
 * including worker start-up), and a cache hit. Wall-clock timing is test-only.
 */
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { LoadedContent } from '@engine/server-kit';
import type { AreaId } from '@engine/world';
import { createRpgActivityRegistry } from '@rpg/rpg-sim';
import type { RpgActorSnapshot, RpgIdleConfig } from '@rpg/rpg-sim';
import plugin from '@rpg/content-plugin';
import { describe, expect, it } from 'vitest';

import { EstimateCache } from './estimate-cache.ts';
import { estimateRunsFor } from './estimate-key.ts';
import { createInlineEstimateRunner, createWorkerEstimateRunner, defaultEstimateWorkers } from './estimate-runner.ts';
import { aggregateSamples } from './estimate-samples.ts';
import type { EstimateAggregate, EstimateJob } from './estimate-samples.ts';

const POTION = 'item:minor_healing_potion';
const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

describe.runIf(process.env['RPG_ESTIMATE_BENCH'] === '1')('estimate latency', () => {
  const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const content = compiled.bundle as unknown as LoadedContent;
  const items = (content.collections['items'] ?? []) as { id: string; stats?: Record<string, number> }[];
  const stats = (id: string) => ({ stats: items.find(item => item.id === id)?.stats ?? {} });
  const bulwark: RpgActorSnapshot = {
    actorId: '9d1c321a-2f34-46bc-8e54-c5618a8368fa',
    build: { level: 4, attributes: { STR: 12, AGI: 4, INT: 2, VIT: 16, SPI: 8 },
      equipment: [stats('item:rusty_sword'), stats('item:boar_hide_jerkin'), stats('item:tiller_plate_buckler')] } as RpgActorSnapshot['build'],
    skills: ['skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
    rules: [
      { when: { selfHpBelowBp: 4000, hasConsumable: POTION }, do: { useConsumable: POTION } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ] as unknown as RpgActorSnapshot['rules'],
  };
  const config: RpgIdleConfig = { consumables: [{ item: POTION, qty: 5 }], retreat: { belowHpBp: 0, onlyWhenNoHealing: true } };
  const hunt = createRpgActivityRegistry(content).get('idle:region_1.hunt');

  it('cold (inline vs worker pool) and cached estimate times per duration', async () => {
    if (!hunt) throw new Error('hunt simulator missing');
    for (const durationMin of [15, 30, 60, 180]) {
      const budget = hunt.budget(config, durationMin, 10_000, { areaId: 'area:region_1' as AreaId, activityId: 'idle:region_1.hunt' });
      const runs = estimateRunsFor(budget);
      const job: EstimateJob = { areaId: 'area:region_1', activityId: 'idle:region_1.hunt', budget, config, snapshot: bulwark, runs, rootSeed: 7 };
      const inline = createInlineEstimateRunner(content);
      await inline.run({ ...job, runs: 8, rootSeed: 1 }); // JIT warm-up of this thread
      let t = process.hrtime.bigint();
      const fromInline = aggregateSamples(await inline.run(job), config);
      const inlineMs = ms(t);
      const pool = createWorkerEstimateRunner(content);
      const cache = new EstimateCache<EstimateAggregate>({ maxEntries: 8, maxPending: 8 });
      t = process.hrtime.bigint();
      const cold = await cache.getOrCompute('k', async () => aggregateSamples(await pool.run(job), config));
      const poolColdMs = ms(t);
      t = process.hrtime.bigint();
      const warm = await pool.run({ ...job, rootSeed: 8 });
      const poolWarmMs = ms(t);
      t = process.hrtime.bigint();
      const hit = await cache.getOrCompute('k', async () => { throw new Error('miss'); });
      const cachedMs = ms(t);
      await pool.close();
      expect(cold.value).toEqual(fromInline);
      expect(hit.cached).toBe(true);
      expect(warm).toHaveLength(runs);
      console.log(JSON.stringify({ durationMin, budget, runs, workers: defaultEstimateWorkers(), inlineMs: Math.round(inlineMs),
        poolColdMs: Math.round(poolColdMs), poolWarmMs: Math.round(poolWarmMs), cachedMs: cachedMs.toFixed(3),
        died: fromInline.outcomeRatesBp.died, xp: fromInline.xp, node: process.version }));
    }
  }, 180_000);
});
