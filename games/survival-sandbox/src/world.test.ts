import { computeAreaView, computeWorldView, evaluateCompletion, evaluateRequirement, validateWorld } from '@engine/world';
import type { Area, AreaId, LocationId, World } from '@engine/world';
import { describe, expect, it } from 'vitest';

import { OLD_MARKET, RAIL_YARD, SHELTER, loadWorld, survivalContext, survivalRegistry, worldInput } from './world.ts';

const registry = survivalRegistry();
const world: World = loadWorld(registry);
const area = (id: string): Area => {
  const a = world.areas.find((x) => x.id === id);
  if (a === undefined) throw new Error(`missing ${id}`);
  return a;
};
const disc = (areaId: AreaId, ...ids: LocationId[]): Record<AreaId, LocationId[]> => ({ [areaId]: ids });
const visibility = (tools: readonly string[], flags: readonly string[] = []) =>
  Object.fromEntries(computeWorldView(world, survivalContext({ flags }, tools), registry).areas.map((a) => [a.id, a.visibility]));

describe('survival world content', () => {
  it('validates with @engine/world', () => {
    const result = validateWorld(worldInput(), registry);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('has a shelter hub, two districts and a timed route', () => {
    expect(area(SHELTER).kind).toBe('hub');
    expect([area(OLD_MARKET).kind, area(RAIL_YARD).kind]).toEqual(['district', 'district']);
    expect(world.routes.some((r) => r.travel.mode === 'timed')).toBe(true);
    for (const id of [OLD_MARKET, RAIL_YARD]) {
      const locs = world.locations.filter((l) => area(id).locations.includes(l.id));
      expect(locs.length).toBeGreaterThanOrEqual(4);
      expect(locs.length).toBeLessThanOrEqual(6);
      expect(locs.some((l) => l.tags.includes('ordinary'))).toBe(true);
      expect(locs.some((l) => l.tags.includes('secret'))).toBe(true);
    }
  });

  it('rejects malformed hasTool arguments and unknown predicates', () => {
    const input = worldInput() as { routes: { requires?: unknown }[] };
    (input.routes[0] as { requires?: unknown }).requires = { game: 'hasTool', tool: 'bolt cutters' };
    (input.routes[1] as { requires?: unknown }).requires = { game: 'dayAtLeast', day: 3 };
    const result = validateWorld(input, registry);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code).sort()).toEqual(['requirement.invalidArgs', 'requirement.unknownPredicate']);
  });
});

describe('hasTool predicate', () => {
  const req = { game: 'hasTool', tool: 'tool:bolt_cutters' } as const;

  it('evaluates against the typed game context', () => {
    expect(evaluateRequirement(req, survivalContext({}, ['tool:bolt_cutters']), registry)).toEqual({ ok: true, reasons: [] });
    expect(evaluateRequirement(req, survivalContext({}, ['tool:crowbar']), registry)).toEqual({
      ok: false,
      reasons: ['requires.game.hasTool:tool:bolt_cutters'],
    });
  });

  it('gates the rail yard route: tool OR flag (any)', () => {
    expect(visibility([])).toEqual({ [SHELTER]: 'known', [OLD_MARKET]: 'known', [RAIL_YARD]: 'locked' });
    expect(visibility(['tool:bolt_cutters'])[RAIL_YARD]).toBe('known');
    expect(visibility([], ['rail_yard.fence_cut'])[RAIL_YARD]).toBe('known');
    const locked = computeWorldView(world, survivalContext(), registry).areas.find((a) => a.id === RAIL_YARD);
    expect(locked?.reasons).toEqual(['requires.game.hasTool:tool:bolt_cutters', 'requires.flag:rail_yard.fence_cut']);
  });

  it('gates an exit inside a district', () => {
    const ctx = (tools: readonly string[]) =>
      survivalContext({ discovered: { [RAIL_YARD]: ['loc:rail_yard.fence', 'loc:rail_yard.platform'] } }, tools);
    const depotExit = (tools: readonly string[]) =>
      computeAreaView(area(RAIL_YARD), world.locations, ctx(tools), registry).unknownExits.find(
        (e) => e.id === 'exit:rail_yard.platform_depot',
      );
    expect(depotExit([])?.unlocked).toBe(false);
    expect(depotExit(['tool:crowbar'])?.unlocked).toBe(true);
    // The secret tunnel exit is not advertised as an unknown exit.
    const unknown = computeAreaView(area(RAIL_YARD), world.locations, ctx([]), registry).unknownExits.map((e) => e.id);
    expect(unknown).not.toContain('exit:rail_yard.platform_tunnel');
  });
});

describe('district completion', () => {
  it('old market: 60% of ordinary locations plus the generator flag; secret locations do not count', () => {
    const discovered = disc(OLD_MARKET, 'loc:old_market.gate', 'loc:old_market.stalls', 'loc:old_market.cold_cellar');
    const partial = evaluateCompletion(area(OLD_MARKET), world.locations, survivalContext({ discovered, flags: ['old_market.generator_restored'] }), registry);
    expect(partial).toMatchObject({ completed: false, discoveredInPool: 2, poolSize: 5, requiredCount: 3, requiredMet: true });

    const three = disc(OLD_MARKET, 'loc:old_market.gate', 'loc:old_market.stalls', 'loc:old_market.cold_cellar', 'loc:old_market.pharmacy');
    const noFlag = evaluateCompletion(area(OLD_MARKET), world.locations, survivalContext({ discovered: three }), registry);
    expect(noFlag).toMatchObject({ completed: false, discoveredInPool: 3, requiredReasons: ['requires.flag:old_market.generator_restored'] });

    const done = evaluateCompletion(
      area(OLD_MARKET),
      world.locations,
      survivalContext({ discovered: three, flags: ['old_market.generator_restored'] }),
      registry,
    );
    expect(done.completed).toBe(true);
  });

  it('rail yard: 60% plus the signal box and the signal key (game predicate)', () => {
    const discovered = disc(RAIL_YARD, 'loc:rail_yard.fence', 'loc:rail_yard.platform', 'loc:rail_yard.signal_box');
    const noKey = evaluateCompletion(area(RAIL_YARD), world.locations, survivalContext({ discovered }), registry);
    expect(noKey).toMatchObject({ completed: false, requiredCount: 3, discoveredInPool: 3 });
    expect(noKey.requiredReasons).toEqual(['requires.game.hasTool:tool:signal_key']);
    const done = evaluateCompletion(area(RAIL_YARD), world.locations, survivalContext({ discovered }, ['tool:signal_key']), registry);
    expect(done.completed).toBe(true);
  });
});
