import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { KERNEL_VERSION } from '@engine/expedition-kernel';
import type { LoadedContent } from '@engine/server-kit';
import { deriveSeed } from '@engine/sim-core';
import type { AreaId } from '@engine/world';
import { createRpgActivityRegistry, rpgIdleMetrics, RPG_IDLE_SIMULATOR_VERSION } from '@rpg/rpg-sim';
import type { RpgActorSnapshot, RpgIdleConfig, RpgIdleEvent, RpgIdleState } from '@rpg/rpg-sim';
import type { Timeline } from '@engine/expedition-kernel';
import plugin from '@rpg/content-plugin';
import { describe, expect, it } from 'vitest';

import type { Character } from '../characters/schema.ts';
import { PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS } from '../characters/validation.ts';
import { EstimateBusyError, EstimateCache } from './estimate-cache.ts';
import { canonicalEstimateKey, estimateCacheKey, estimateRootSeed, estimateRunsFor } from './estimate-key.ts';
import type { EstimateKeyInput } from './estimate-key.ts';
import { createInlineEstimateRunner, createWorkerEstimateRunner } from './estimate-runner.ts';
import { aggregateSamples, chunkRuns, ESTIMATE_CHUNKS, percentileRange } from './estimate-samples.ts';
import type { EstimateJob, RunSample } from './estimate-samples.ts';
import { snapshotRpgActor } from './service.ts';

const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const content = compiled.bundle as unknown as LoadedContent;
const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';

function starter(over: Partial<Character> = {}): RpgActorSnapshot {
  return snapshotRpgActor({ actorId: '9d1c321a-2f34-46bc-8e54-c5618a8368fa', level: 1, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES },
    skillLoadout: [...PROVISIONAL_STARTER_SKILLS], automationRules: structuredClone(PROVISIONAL_STARTER_RULES), ...over } as unknown as Character, [], content);
}
const config = (potions = 0, belowHpBp = 0): RpgIdleConfig => ({
  consumables: potions > 0 ? [{ item: POTION, qty: potions }] : [], retreat: { belowHpBp, onlyWhenNoHealing: false } });
const keyInput = (over: Partial<EstimateKeyInput> = {}): EstimateKeyInput => ({ kernelVersion: KERNEL_VERSION, simulatorId: 'rpg.hunt',
  simulatorVersion: RPG_IDLE_SIMULATOR_VERSION, contentHash: content.contentHash, areaId: REGION, activityId: HUNT, durationMin: 30, paceBp: 10_000,
  runs: 200, config: config(), snapshot: starter(), ...over });

describe('estimate cache key', () => {
  it('is canonical: key order, consumable order and object identity do not change it', () => {
    const a = keyInput({ config: { consumables: [{ item: POTION, qty: 2 }, { item: 'item:a_tonic', qty: 1 }], retreat: { belowHpBp: 2000, onlyWhenNoHealing: true } } });
    const b = keyInput({ config: { retreat: { onlyWhenNoHealing: true, belowHpBp: 2000 }, consumables: [{ qty: 1, item: 'item:a_tonic' }, { qty: 2, item: POTION }] } as RpgIdleConfig,
      snapshot: structuredClone(a.snapshot) });
    expect(canonicalEstimateKey(a)).toBe(canonicalEstimateKey(b));
    expect(estimateCacheKey(a)).toBe(estimateCacheKey(b));
    expect(estimateCacheKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(canonicalEstimateKey(a))).toMatchObject({ model: 1, kernelVersion: KERNEL_VERSION, durationMin: 30, runs: 200 });
  });

  it('changes with every input the spec lists (build, rules, target, duration, pace, config, content, versions)', () => {
    const base = estimateCacheKey(keyInput());
    const snapshot = starter();
    const variants: Partial<EstimateKeyInput>[] = [
      { snapshot: { ...snapshot, build: { ...snapshot.build, level: 2 } } },
      { snapshot: { ...snapshot, rules: [] } },
      { snapshot: { ...snapshot, skills: [...snapshot.skills].reverse() } },
      { areaId: 'area:other' }, { activityId: 'idle:region_1.gather' }, { durationMin: 60 }, { paceBp: 12_000 }, { runs: 100 },
      { config: config(1) }, { config: config(2) }, { config: config(0, 1000) }, { contentHash: 'other' },
      { kernelVersion: '9.9.9' }, { simulatorVersion: 'rpg-idle@9.9.9+rpg-sim@1.1.0' }, { simulatorId: 'rpg.gather' },
    ];
    const keys = variants.map(over => estimateCacheKey(keyInput(over)));
    expect(new Set([base, ...keys]).size).toBe(variants.length + 1);
  });

  it('derives an estimate root seed only from the key', () => {
    const key = estimateCacheKey(keyInput());
    expect(estimateRootSeed(key)).toBe(estimateRootSeed(key));
    expect(estimateRootSeed(key)).not.toBe(estimateRootSeed(estimateCacheKey(keyInput({ durationMin: 60 }))));
    expect(Number.isSafeInteger(estimateRootSeed(key)) && estimateRootSeed(key) >= 0 && estimateRootSeed(key) <= 0xffff_ffff).toBe(true);
  });

  it('bounds the run count by the segment budget', () => {
    expect(estimateRunsFor(8)).toBe(200);
    expect(estimateRunsFor(30)).toBe(166);
    expect(estimateRunsFor(36)).toBe(138);
    expect(estimateRunsFor(90)).toBe(60);
    expect(estimateRunsFor(500)).toBe(60);
    expect(() => estimateRunsFor(0)).toThrow(RangeError);
  });
});

describe('estimate percentiles and aggregation', () => {
  const sample = (xp: number, over: Partial<RunSample> = {}): RunSample => ({ outcome: 'completed', xp, gold: xp * 2, used: {}, ...over });

  it('maps samples to nearest-rank p10/p50/p90', () => {
    const values = Array.from({ length: 10 }, (_, i) => 10 - i);
    expect(percentileRange(values)).toEqual({ p10: 1, p50: 5, p90: 9 });
    expect(percentileRange([7])).toEqual({ p10: 7, p50: 7, p90: 7 });
    expect(percentileRange(Array.from({ length: 200 }, (_, i) => i))).toEqual({ p10: 19, p50: 99, p90: 179 });
  });

  it('reports consumables brought but unused as zero, rates in floored basis points', () => {
    const samples = [sample(10), sample(20, { outcome: 'failed', used: { [POTION]: 3 } }), sample(30, { outcome: 'retreated', used: { [POTION]: 1 } })];
    expect(aggregateSamples(samples, config(5))).toEqual({
      n: 3, xp: { p10: 10, p50: 20, p90: 30 }, gold: { p10: 20, p50: 40, p90: 60 },
      consumablesUsed: [{ item: POTION, p10: 0, p50: 1, p90: 3 }],
      outcomeRatesBp: { completed: 3333, retreated: 3333, died: 3333 },
    });
    expect(aggregateSamples([sample(1)], config()).consumablesUsed).toEqual([]);
  });

  it('splits runs into fixed chunks', () => {
    expect(Array.from({ length: ESTIMATE_CHUNKS }, (_, k) => chunkRuns(66, k))).toEqual([17, 17, 16, 16]);
    expect(Array.from({ length: ESTIMATE_CHUNKS }, (_, k) => chunkRuns(200, k)).reduce((a, b) => a + b)).toBe(200);
  });
});

describe('estimate cache', () => {
  it('serves hits, de-duplicates in-flight work, evicts the least recently used entry and refuses when busy', async () => {
    const cache = new EstimateCache<number>({ maxEntries: 2, maxPending: 1 });
    let calls = 0;
    let release: (value: number) => void = () => {};
    const slow = () => { calls++; return new Promise<number>(resolve => { release = resolve; }); };
    const first = cache.getOrCompute('a', slow);
    const second = cache.getOrCompute('a', slow);
    await expect(cache.getOrCompute('b', async () => 2)).rejects.toBeInstanceOf(EstimateBusyError);
    release(1);
    expect(await first).toEqual({ value: 1, cached: false });
    expect(await second).toEqual({ value: 1, cached: false });
    expect(calls).toBe(1);
    expect(await cache.getOrCompute('a', slow)).toEqual({ value: 1, cached: true });
    await cache.getOrCompute('b', async () => 2);
    cache.get('a');
    await cache.getOrCompute('c', async () => 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    await expect(cache.getOrCompute('d', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cache.get('d')).toBeUndefined();
    expect(cache.pending).toBe(0);
  });
});

describe('estimate runners', () => {
  const job: EstimateJob = { areaId: REGION, activityId: HUNT, budget: 8, config: config(2), snapshot: starter(), runs: 61, rootSeed: 12345 };

  it('worker pool and inline runner produce identical samples for a job', async () => {
    const inline = createInlineEstimateRunner(content);
    const pool = createWorkerEstimateRunner(content, { workers: 2 });
    try {
      const [a, b] = await Promise.all([inline.run(job), pool.run(job)]);
      expect(a).toHaveLength(61);
      expect(b).toEqual(a);
      expect(await pool.run(job)).toEqual(a);
    } finally { await pool.close(); await inline.close(); }
  }, 30_000);
});

/**
 * Validation (#53 acceptance): observed outcomes of independent real runs (fresh seeds, unrelated to the estimate's
 * seeds) fall within the estimated p10–p90 range at about the expected 80 % rate, and the death rate matches.
 */
describe('estimate validation against independent runs', () => {
  it('real XP and gold fall within [p10, p90] at roughly the expected rate', async () => {
    const registry = createRpgActivityRegistry(content);
    const simulator = registry.get(HUNT);
    if (!simulator) throw new Error('hunt simulator missing');
    const snapshot = starter();
    const cfg = config(3, 2500);
    const budget = simulator.budget(cfg, 30, 10_000, { areaId: REGION as AreaId, activityId: HUNT });
    const runs = estimateRunsFor(budget);
    const job: EstimateJob = { areaId: REGION, activityId: HUNT, budget, config: cfg, snapshot, runs, rootSeed: 4242 };
    const runner = createInlineEstimateRunner(content);
    const estimated = aggregateSamples(await runner.run(job), cfg);

    const M = 200;
    let xpInside = 0;
    let goldInside = 0;
    let died = 0;
    for (let i = 0; i < M; i++) {
      const timeline = simulator.simulate({ config: cfg, actors: [snapshot], seed: deriveSeed(987_654, 'validation', i), budget,
        areaId: REGION as AreaId, activityId: HUNT }) as Timeline<RpgIdleEvent, RpgIdleState>;
      const xp = rpgIdleMetrics(timeline)[`xp:${snapshot.actorId}`] ?? 0;
      const settled = simulator.settle(timeline, timeline.segments.length - 1, 'completed');
      const gold = settled.filter(d => d.asset.kind === 'currency' && d.from === undefined).reduce((n, d) => n + d.qty, 0);
      if (xp >= estimated.xp.p10 && xp <= estimated.xp.p90) xpInside++;
      if (gold >= estimated.gold.p10 && gold <= estimated.gold.p90) goldInside++;
      if (timeline.outcome === 'failed') died++;
    }
    // Inclusive bounds on integer outcomes cover at least 80 % in expectation; allow sampling noise either way.
    expect(xpInside / M).toBeGreaterThanOrEqual(0.7);
    expect(xpInside / M).toBeLessThanOrEqual(0.95);
    expect(goldInside / M).toBeGreaterThanOrEqual(0.7);
    expect(goldInside / M).toBeLessThanOrEqual(0.95);
    expect(Math.abs(died / M - estimated.outcomeRatesBp.died / 10_000)).toBeLessThanOrEqual(0.08);
    console.info(JSON.stringify({ n: estimated.n, xp: estimated.xp, gold: estimated.gold, xpInside: xpInside / M, goldInside: goldInside / M,
      diedActual: died / M, diedEstimated: estimated.outcomeRatesBp.died / 10_000 }));
  }, 60_000);
});
