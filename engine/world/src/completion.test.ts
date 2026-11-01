import { describe, expect, it } from 'vitest';

import { evaluateCompletion, requiredCountFor } from './completion.ts';
import type { Area, World } from './schemas.ts';
import {
  BOSS,
  R1,
  R1_SECRET,
  r1,
  rpgCtx,
  rpgRegistry,
  rpgWorld,
  survivalCtx,
  survivalRegistry,
  survivalWorld,
} from './testing/fixtures.ts';

const area = (world: World, id: string): Area => {
  const found = world.areas.find((a) => a.id === id);
  if (!found) throw new Error(id);
  return found;
};

const discoveredR1 = (n: number, extra: string[] = []) => ({
  [R1]: [...Array.from({ length: n }, (_, i) => r1(i)), ...extra] as `loc:${string}`[],
});

describe('requiredCountFor', () => {
  it.each([
    [10, 7000, 7],
    [11, 7000, 8],
    [3, 5000, 2],
    [0, 7000, 0],
    [7, 10_000, 7],
    [7, 0, 0],
    [1, 1, 1],
  ])('ceil(%i × %i bp) = %i', (pool, bp, expected) => {
    expect(requiredCountFor(pool, bp)).toBe(expected);
  });
});

describe('evaluateCompletion', () => {
  const world = rpgWorld();
  const region1 = area(world, R1);
  const registry = rpgRegistry();
  const boss = [`defeated:${BOSS}`];

  it('uses the frozen baseline and requires the objective', () => {
    const status = evaluateCompletion(region1, world.locations, rpgCtx({ discovered: discoveredR1(7) }), registry);
    expect(status).toEqual({
      hasRule: true,
      completed: false,
      recorded: false,
      discoveredInPool: 7,
      requiredCount: 7,
      poolSize: 10,
      requiredMet: false,
      requiredReasons: [`requires.game.defeated:${BOSS}`],
    });
    const done = evaluateCompletion(region1, world.locations, rpgCtx({ discovered: discoveredR1(7), objectives: boss }), registry);
    expect(done.completed).toBe(true);
  });

  it('does not count non-pool (secret) locations', () => {
    const ctx = rpgCtx({ discovered: discoveredR1(6, [R1_SECRET]), objectives: boss });
    const status = evaluateCompletion(region1, world.locations, ctx, registry);
    expect(status.discoveredInPool).toBe(6);
    expect(status.completed).toBe(false);
  });

  it('frozen baseline is unaffected by locations added later', () => {
    const grown: Area = { ...region1, locations: [...region1.locations, 'loc:region_1.new_a', 'loc:region_1.new_b'] };
    const locations = [
      ...world.locations,
      { id: 'loc:region_1.new_a' as const, tags: ['ordinary'], exits: [] },
      { id: 'loc:region_1.new_b' as const, tags: ['ordinary'], exits: [] },
    ];
    const ctx = rpgCtx({ discovered: discoveredR1(7), objectives: boss });
    const frozen = evaluateCompletion(grown, locations, ctx, registry);
    expect(frozen).toMatchObject({ poolSize: 10, requiredCount: 7, completed: true });

    const liveRule = { pool: { tag: 'ordinary' }, thresholdBp: 7000 };
    const live = evaluateCompletion({ ...grown, completion: liveRule }, locations, ctx, registry);
    expect(live).toMatchObject({ poolSize: 12, requiredCount: 9, completed: false });
  });

  it('a recorded completion is permanent', () => {
    const status = evaluateCompletion(region1, world.locations, rpgCtx({ completedAreas: [R1] }), registry);
    expect(status).toMatchObject({ completed: true, recorded: true, discoveredInPool: 0 });
  });

  it('areas without a rule only report recorded completion', () => {
    const hub = area(world, 'area:sanctuary');
    expect(evaluateCompletion(hub, world.locations, rpgCtx(), registry)).toMatchObject({ hasRule: false, completed: false });
  });

  it('evaluates a survival district with an item requirement', () => {
    const sw = survivalWorld();
    const docks = area(sw, 'area:docks');
    const reg = survivalRegistry();
    const ctx = (fuel: number) => survivalCtx({ discovered: { 'area:docks': ['loc:docks.pier', 'loc:docks.warehouse'] }, items: { 'item:fuel': fuel } });
    expect(evaluateCompletion(docks, sw.locations, ctx(1), reg)).toMatchObject({
      poolSize: 1,
      requiredCount: 1,
      discoveredInPool: 1,
      requiredMet: false,
      completed: false,
    });
    expect(evaluateCompletion(docks, sw.locations, ctx(2), reg).completed).toBe(true);
  });
});
