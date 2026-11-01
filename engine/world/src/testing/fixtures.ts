/**
 * Test fixtures: two unrelated game configurations validated and evaluated by the same engine code.
 * Game terms live only here, in test data, never in engine code.
 */
import { z } from 'zod';

import type { ActorWorldStateInit } from '../actor.ts';
import { createActorWorldState, type EvalContext } from '../actor.ts';
import { PredicateRegistry } from '../registry.ts';
import { WorldSchema, type LocationId, type World, type WorldInput } from '../schemas.ts';

// ---------------------------------------------------------------------------------------------------------------------
// (a) RPG-like world: Sanctuary hub → Region 1 → Region 2
// ---------------------------------------------------------------------------------------------------------------------

export interface RpgGameState {
  readonly level: number;
}

export function rpgRegistry(): PredicateRegistry<RpgGameState> {
  return new PredicateRegistry<RpgGameState>()
    .register('defeated', {
      args: z.strictObject({ enemy: z.string().regex(/^enemy:[a-z0-9_]+$/) }),
      evaluate: ({ enemy }, ctx) => ctx.actor.objectives.has(`defeated:${enemy}`),
      reason: ({ enemy }) => `requires.game.defeated:${enemy}`,
    })
    .register('levelAtLeast', {
      args: z.strictObject({ level: z.int().positive() }),
      evaluate: ({ level }, ctx) => ctx.game.level >= level,
    });
}

export const R1 = 'area:region_1';
export const BOSS = 'enemy:hollow_matriarch';

/** `loc:region_1.c0` … `loc:region_1.c9`. */
export const r1 = (i: number): LocationId => `loc:region_1.c${i}`;
export const R1_SECRET: LocationId = 'loc:region_1.hidden_grotto';

export function rpgWorldInput(): WorldInput {
  const chain = Array.from({ length: 10 }, (_, i) => ({
    id: r1(i),
    tags: ['ordinary'],
    exits: [
      ...(i < 9 ? [{ id: `exit:region_1.c${i}_fwd`, to: r1(i + 1) }] : []),
      ...(i > 0 ? [{ id: `exit:region_1.c${i}_back`, to: r1(i - 1) }] : []),
      ...(i === 5 ? [{ id: 'exit:region_1.c5_secret', to: R1_SECRET, tags: ['secret'] }] : []),
    ],
    // Game extension field, ignored by the engine.
    encounters: ['enemy:wolf'],
  }));
  return {
    areas: [
      { id: 'area:sanctuary', kind: 'hub' },
      {
        id: R1,
        kind: 'explorable',
        startLocation: r1(0),
        locations: [...chain.map((l) => l.id), R1_SECRET],
        completion: {
          pool: { tag: 'ordinary' },
          thresholdBp: 7000,
          required: { all: [{ game: 'defeated', enemy: BOSS }] },
          frozen: { poolSize: 10, requiredCount: 7, at: '2026-12-01' },
        },
        activities: ['idle:hunt', 'idle:gather'],
      },
      {
        id: 'area:region_2',
        kind: 'explorable',
        startLocation: 'loc:region_2.gate',
        locations: ['loc:region_2.gate'],
        completion: { pool: { tag: 'ordinary' }, thresholdBp: 7000 },
      },
    ],
    routes: [
      { id: 'route:sanctuary_to_region_1', from: 'area:sanctuary', to: R1, travel: { mode: 'instant' } },
      {
        id: 'route:sanctuary_to_region_2',
        from: 'area:sanctuary',
        to: 'area:region_2',
        requires: { areaCompleted: R1 },
        travel: { mode: 'instant' },
      },
    ],
    locations: [
      ...chain,
      { id: R1_SECRET, tags: ['secret'], exits: [{ id: 'exit:region_1.grotto_back', to: r1(5) }] },
      { id: 'loc:region_2.gate', tags: ['ordinary'] },
    ],
  };
}

export const rpgWorld = (): World => WorldSchema.parse(rpgWorldInput());

export const rpgCtx = (init: ActorWorldStateInit = {}, level = 1): EvalContext<RpgGameState> => ({
  actor: createActorWorldState(init),
  game: { level },
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) Survival-like world: Shelter hub → two districts
// ---------------------------------------------------------------------------------------------------------------------

export interface SurvivalGameState {
  readonly tools: ReadonlySet<string>;
}

export function survivalRegistry(): PredicateRegistry<SurvivalGameState> {
  return new PredicateRegistry<SurvivalGameState>().register('hasTool', {
    args: z.strictObject({ tool: z.string().regex(/^tool:[a-z0-9_]+$/) }),
    evaluate: ({ tool }, ctx) => ctx.game.tools.has(tool),
    reason: ({ tool }) => `requires.game.hasTool:${tool}`,
  });
}

export function survivalWorldInput(): WorldInput {
  return {
    areas: [
      { id: 'area:shelter', kind: 'hub', locations: ['loc:shelter.yard'], startLocation: 'loc:shelter.yard' },
      {
        id: 'area:market',
        kind: 'district',
        startLocation: 'loc:market.square',
        locations: ['loc:market.square', 'loc:market.pharmacy', 'loc:market.depot'],
        completion: { pool: { tag: 'building' }, thresholdBp: 5000 },
        activities: ['run:scavenge'],
      },
      {
        id: 'area:docks',
        kind: 'district',
        startLocation: 'loc:docks.pier',
        locations: ['loc:docks.pier', 'loc:docks.warehouse'],
        completion: {
          pool: { tag: 'building' },
          thresholdBp: 10_000,
          required: { hasItem: { item: 'item:fuel', qty: 2 } },
        },
      },
    ],
    routes: [
      { id: 'route:shelter_to_market', from: 'area:shelter', to: 'area:market', travel: { mode: 'timed', durationMin: 15 } },
      {
        id: 'route:market_to_docks',
        from: 'area:market',
        to: 'area:docks',
        requires: { any: [{ game: 'hasTool', tool: 'tool:bolt_cutter' }, { flag: 'bridge_repaired' }] },
        travel: { mode: 'instant' },
      },
    ],
    locations: [
      { id: 'loc:shelter.yard', tags: ['safe'] },
      {
        id: 'loc:market.square',
        tags: ['street'],
        exits: [
          { id: 'exit:market.square_pharmacy', to: 'loc:market.pharmacy' },
          { id: 'exit:market.square_depot', to: 'loc:market.depot', requires: { game: 'hasTool', tool: 'tool:crowbar' } },
        ],
      },
      { id: 'loc:market.pharmacy', tags: ['building'], exits: [{ id: 'exit:market.pharmacy_square', to: 'loc:market.square' }] },
      { id: 'loc:market.depot', tags: ['building'], exits: [{ id: 'exit:market.depot_square', to: 'loc:market.square' }] },
      { id: 'loc:docks.pier', tags: ['street'], exits: [{ id: 'exit:docks.pier_warehouse', to: 'loc:docks.warehouse' }] },
      { id: 'loc:docks.warehouse', tags: ['building'] },
    ],
  };
}

export const survivalWorld = (): World => WorldSchema.parse(survivalWorldInput());

export const survivalCtx = (init: ActorWorldStateInit = {}, tools: readonly string[] = []): EvalContext<SurvivalGameState> => ({
  actor: createActorWorldState(init),
  game: { tools: new Set(tools) },
});
