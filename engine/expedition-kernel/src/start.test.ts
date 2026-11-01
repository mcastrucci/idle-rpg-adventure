import { PredicateRegistry, createActorWorldState, validateWorld } from '@engine/world';
import type { EvalContext, World } from '@engine/world';
import { describe, expect, it } from 'vitest';

import { coinCollector } from './__tests__/coin-collector.ts';
import type { CoinActor, CoinConfig, CoinEvent, CoinReport, CoinState } from './__tests__/coin-collector.ts';
import { TORCHES, torchCollector } from './__tests__/torch-collector.ts';
import { ActivityRegistry, checkStart, unregisteredActivities } from './index.ts';
import type { ExpeditionSimulator, StartContext, StartRequest } from './index.ts';

type Game = { readonly lanterns: number };

const predicates = new PredicateRegistry<Game>().register('lanternsAtLeast', {
  args: (input: unknown) => {
    const n = (input as { n?: unknown } | null)?.n;
    if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new TypeError('n');
    return { n };
  },
  evaluate: ({ n }, ctx) => ctx.game.lanterns >= n,
});

const world: World = (() => {
  const result = validateWorld(
    {
      areas: [
        { id: 'area:hub', kind: 'hub', locations: ['loc:hub.gate'], startLocation: 'loc:hub.gate', activities: ['activity:dig'] },
        {
          id: 'area:mine',
          kind: 'explorable',
          locations: ['loc:mine.a', 'loc:mine.b'],
          startLocation: 'loc:mine.a',
          completion: { pool: { tag: 'room' }, thresholdBp: 10_000, required: { game: 'lanternsAtLeast', n: 1 } },
          activities: ['activity:dig', 'activity:torches'],
        },
      ],
      routes: [{ id: 'route:hub_mine', from: 'area:hub', to: 'area:mine', travel: { mode: 'instant' } }],
      locations: [
        { id: 'loc:hub.gate' },
        { id: 'loc:mine.a', tags: ['room'], exits: [{ id: 'exit:mine.ab', to: 'loc:mine.b' }] },
        { id: 'loc:mine.b', tags: ['room'] },
      ],
    },
    predicates,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.world;
})();

const done = (lanterns = 1): EvalContext<Game> => ({
  actor: createActorWorldState({ discovered: { 'area:mine': ['loc:mine.a', 'loc:mine.b'] } }),
  game: { lanterns },
});
const fresh = (): EvalContext<Game> => ({ actor: createActorWorldState(), game: { lanterns: 0 } });

const seen: StartContext<CoinConfig, CoinActor, Game>[] = [];
const digger: ExpeditionSimulator<CoinConfig, CoinActor, CoinEvent, CoinState, CoinReport, Game> = {
  ...coinCollector,
  id: 'test.dig',
  canStart(ctx) {
    seen.push(ctx);
    return (ctx.evalContexts ?? []).every((c) => c.game.lanterns >= 2) ? { ok: true } : { ok: false, code: 'dig.needs_two_lanterns' };
  },
};

const activities = new ActivityRegistry().register('activity:dig', digger).register('activity:torches', torchCollector);
const config: CoinConfig = { maxCoins: 3, hazardBp: 0 };
const req = (over: Partial<StartRequest> = {}): StartRequest => ({ areaId: 'area:mine', activityId: 'activity:dig', durationMin: 60, paceBp: 10_000, ...over });
const gate = (request: StartRequest, evalContexts: EvalContext<Game>[], actors: CoinActor[] = [{ id: 'a' }]) =>
  checkStart({ world, request, activities, simulator: digger, config, actors, evalContexts, predicates });

describe('ActivityRegistry', () => {
  it('maps activity IDs (content) to simulators (code) and validates both ID formats', () => {
    expect(activities.activityIds()).toEqual(['activity:dig', 'activity:torches']);
    expect(activities.get('activity:dig')?.id).toBe('test.dig');
    expect(() => new ActivityRegistry().register('dig', digger)).toThrow(/activity ID/);
    expect(() => new ActivityRegistry().register('activity:dig', { ...digger, id: 'activity:dig' })).toThrow(/simulator ID/);
    expect(() => new ActivityRegistry().register('activity:dig', { ...digger, version: '' })).toThrow(/version/);
    expect(() => new ActivityRegistry().register('activity:dig', digger).register('activity:dig', digger)).toThrow(/already/);
  });

  it('lists activities without a simulator', () => {
    expect(unregisteredActivities(world, activities)).toEqual([]);
    expect(unregisteredActivities(world, new ActivityRegistry().register('activity:dig', digger))).toEqual([
      { areaId: 'area:mine', activityId: 'activity:torches' },
    ]);
  });
});

describe('checkStart', () => {
  it('passes the gates and hands world, area, contexts and predicates to canStart', () => {
    seen.length = 0;
    const result = gate(req(), [done(2)]);
    expect(result).toEqual({ ok: true, budget: 12, escrow: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.area?.id).toBe('area:mine');
    expect(seen[0]?.world).toBe(world);
    expect(seen[0]?.predicates).toBe(predicates);
    expect(seen[0]).toMatchObject({ durationMin: 60, paceBp: 10_000, config });
  });

  it('returns the simulator verdict last', () => {
    expect(gate(req(), [done(1)])).toEqual({ ok: false, code: 'dig.needs_two_lanterns' });
  });

  it('enforces area, activity, registration and request validity', () => {
    expect(gate(req({ areaId: 'area:nowhere' }), [done(2)])).toMatchObject({ ok: false, code: 'start.unknownArea' });
    expect(gate(req({ activityId: 'activity:fish' }), [done(2)])).toMatchObject({ ok: false, code: 'start.activityNotInArea' });
    expect(gate(req({ activityId: 'activity:torches' }), [done(2)])).toMatchObject({ ok: false, code: 'start.simulatorMismatch' });
    const empty = new ActivityRegistry();
    expect(checkStart({ world, request: req(), activities: empty, simulator: digger, config, actors: [{ id: 'a' }], evalContexts: [done(2)], predicates })).toMatchObject({
      ok: false,
      code: 'start.unknownActivity',
    });
    expect(gate(req({ durationMin: 0 }), [done(2)])).toMatchObject({ ok: false, code: 'start.invalidDuration' });
    expect(gate(req({ paceBp: 1.5 }), [done(2)])).toMatchObject({ ok: false, code: 'start.invalidDuration' });
    expect(gate(req(), [], [])).toMatchObject({ ok: false, code: 'start.noActors' });
    expect(gate(req(), [done(2)], [{ id: 'a' }, { id: 'b' }])).toMatchObject({ ok: false, code: 'start.contextMismatch' });
  });

  it('requires every actor to have completed the area (areas without a rule need none)', () => {
    expect(gate(req(), [done(2), fresh()], [{ id: 'a' }, { id: 'b' }])).toEqual({
      ok: false,
      code: 'start.areaNotCompleted',
      message: 'actors 1 have not completed area:mine',
      reasons: ['completion.discoveries:area:mine', 'requires.game.lanternsAtLeast'],
    });
    const recorded: EvalContext<Game> = { actor: createActorWorldState({ completedAreas: ['area:mine'] }), game: { lanterns: 2 } };
    expect(gate(req(), [recorded]).ok).toBe(true);
    expect(gate(req({ areaId: 'area:hub' }), [{ actor: createActorWorldState(), game: { lanterns: 2 } }]).ok).toBe(true);
  });

  it('validates and returns the escrow', () => {
    const ok = checkStart({
      world,
      request: req({ activityId: 'activity:torches' }),
      activities,
      simulator: torchCollector,
      config,
      actors: [{ id: 'a' }],
      evalContexts: [done(1)],
      predicates,
    });
    expect(ok).toMatchObject({ ok: true, escrow: [{ actorId: 'a', qty: TORCHES, from: 'inventory', to: 'escrow' }] });

    const broken = { ...digger, escrow: () => [{ actorId: 'a', asset: { kind: 'stack', item: 'x' }, qty: 1, to: 'escrow' }] } as typeof digger;
    const reg = new ActivityRegistry().register('activity:dig', broken);
    expect(
      checkStart({ world, request: req(), activities: reg, simulator: broken, config, actors: [{ id: 'a' }], evalContexts: [done(2)], predicates }),
    ).toMatchObject({ ok: false, code: 'start.invalidEscrow' });
  });
});
