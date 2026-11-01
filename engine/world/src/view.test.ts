import { describe, expect, it } from 'vitest';

import { WorldSchema, type Area } from './schemas.ts';
import { computeAreaView, computeWorldView, NO_ROUTE_REASON, type WorldView } from './view.ts';
import {
  R1,
  R1_SECRET,
  r1,
  rpgCtx,
  rpgRegistry,
  rpgWorldInput,
  survivalCtx,
  survivalRegistry,
  survivalWorld,
} from './testing/fixtures.ts';

const visibility = (view: WorldView) => Object.fromEntries(view.areas.map((a) => [a.id, a.visibility]));
const areaView = (view: WorldView, id: string) => view.areas.find((a) => a.id === id);

/** RPG world plus an area behind Region 1 and an area revealed only by a flag. */
function extendedRpgWorld() {
  const input = rpgWorldInput();
  return WorldSchema.parse({
    ...input,
    areas: [
      ...input.areas,
      { id: 'area:deep', kind: 'explorable' },
      { id: 'area:vault', kind: 'explorable', revealedBy: { flag: 'heard_of_vault' } },
    ],
    routes: [
      ...(input.routes ?? []),
      { id: 'route:region_1_to_deep', from: R1, to: 'area:deep', travel: { mode: 'instant' } },
    ],
  });
}

describe('computeWorldView', () => {
  const world = extendedRpgWorld();
  const registry = rpgRegistry();

  it('fresh actor: hub and adjacent areas known, gated area locked, the rest hidden', () => {
    const view = computeWorldView(world, rpgCtx(), registry);
    expect(visibility(view)).toEqual({
      'area:sanctuary': 'known',
      [R1]: 'known',
      'area:region_2': 'locked',
      'area:deep': 'hidden',
      'area:vault': 'hidden',
    });
    expect(areaView(view, 'area:region_2')?.reasons).toEqual([`requires.areaCompleted:${R1}`]);
    expect(areaView(view, 'area:deep')?.reasons).toEqual([]);
  });

  it('visiting an area reveals its neighbours; completing it unlocks the gated route', () => {
    const visited = computeWorldView(world, rpgCtx({ discovered: { [R1]: [r1(0)] } }), registry);
    expect(visibility(visited)['area:deep']).toBe('known');
    expect(visibility(visited)['area:region_2']).toBe('locked');

    const completed = computeWorldView(world, rpgCtx({ completedAreas: [R1] }), registry);
    expect(visibility(completed)['area:region_2']).toBe('known');
    expect(areaView(completed, R1)?.completion.completed).toBe(true);
    expect(completed.routes.find((r) => r.id === 'route:sanctuary_to_region_2')).toMatchObject({ unlocked: true, reasons: [] });
  });

  it('revealedBy shows an area; with no route from a reachable area it is locked', () => {
    const view = computeWorldView(world, rpgCtx({ flags: ['heard_of_vault'] }), registry);
    expect(areaView(view, 'area:vault')).toMatchObject({ visibility: 'locked', reasons: [NO_ROUTE_REASON] });
  });

  it('route views carry lock reasons and hide routes touching hidden areas', () => {
    const view = computeWorldView(world, rpgCtx(), registry);
    expect(view.routes).toEqual([
      { id: 'route:sanctuary_to_region_1', from: 'area:sanctuary', to: R1, visible: true, unlocked: true, reasons: [] },
      {
        id: 'route:sanctuary_to_region_2',
        from: 'area:sanctuary',
        to: 'area:region_2',
        visible: true,
        unlocked: false,
        reasons: [`requires.areaCompleted:${R1}`],
      },
      { id: 'route:region_1_to_deep', from: R1, to: 'area:deep', visible: false, unlocked: true, reasons: [] },
    ]);
  });

  it('same code drives the survival world', () => {
    const sw = survivalWorld();
    const reg = survivalRegistry();
    const fresh = computeWorldView(sw, survivalCtx(), reg);
    expect(visibility(fresh)).toEqual({ 'area:shelter': 'known', 'area:market': 'known', 'area:docks': 'hidden' });

    const visited = { visitedAreas: ['area:market' as const] };
    const locked = computeWorldView(sw, survivalCtx(visited), reg);
    expect(areaView(locked, 'area:docks')).toMatchObject({
      visibility: 'locked',
      reasons: ['requires.game.hasTool:tool:bolt_cutter', 'requires.flag:bridge_repaired'],
    });
    expect(visibility(computeWorldView(sw, survivalCtx(visited, ['tool:bolt_cutter']), reg))['area:docks']).toBe('known');
    expect(visibility(computeWorldView(sw, survivalCtx({ ...visited, flags: ['bridge_repaired'] }), reg))['area:docks']).toBe('known');
  });
});

describe('computeAreaView', () => {
  const world = extendedRpgWorld();
  const region1 = world.areas.find((a) => a.id === R1) as Area;

  it('shows discovered locations, known exits and unknown exits, omitting secret ones', () => {
    const view = computeAreaView(region1, world.locations, rpgCtx({ discovered: { [R1]: [r1(4), r1(5)] } }), rpgRegistry());
    expect(view.locations).toEqual([
      { id: r1(4), tags: ['ordinary'], isStart: false },
      { id: r1(5), tags: ['ordinary'], isStart: false },
    ]);
    expect(view.exits.map((e) => [e.from, e.to])).toEqual([
      [r1(4), r1(5)],
      [r1(5), r1(4)],
    ]);
    expect(view.unknownExits.map((e) => e.id)).toEqual(['exit:region_1.c4_back', 'exit:region_1.c5_fwd']);
    expect(view.unknownExits[0]).not.toHaveProperty('to');
    expect(view.completion.discoveredInPool).toBe(2);
  });

  it('shows a secret exit once its target is discovered', () => {
    const view = computeAreaView(region1, world.locations, rpgCtx({ discovered: { [R1]: [r1(5), R1_SECRET] } }), rpgRegistry());
    expect(view.exits.map((e) => e.id)).toContain('exit:region_1.c5_secret');
  });

  it('reports locked exits with reasons', () => {
    const sw = survivalWorld();
    const market = sw.areas.find((a) => a.id === 'area:market') as Area;
    const view = computeAreaView(market, sw.locations, survivalCtx({ discovered: { 'area:market': ['loc:market.square'] } }), survivalRegistry());
    expect(view.locations).toEqual([{ id: 'loc:market.square', tags: ['street'], isStart: true }]);
    expect(view.unknownExits).toEqual([
      { id: 'exit:market.square_pharmacy', from: 'loc:market.square', unlocked: true, reasons: [], tags: [] },
      {
        id: 'exit:market.square_depot',
        from: 'loc:market.square',
        unlocked: false,
        reasons: ['requires.game.hasTool:tool:crowbar'],
        tags: [],
      },
    ]);
  });
});
