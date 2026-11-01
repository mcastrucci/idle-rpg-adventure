import { describe, expect, it } from 'vitest';

import type { WorldInput } from './schemas.ts';
import { validateWorld, type ValidationCode } from './validate.ts';
import { R1, r1, rpgRegistry, rpgWorldInput, survivalRegistry, survivalWorldInput } from './testing/fixtures.ts';

/** Plain mutable JSON view of the fixture, to break it in tests. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function broken(mutate: (w: Json) => void): Json {
  const world = structuredClone(rpgWorldInput()) as Json;
  mutate(world);
  return world;
}

const byId = (list: Json[], id: string): Json => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(id);
  return found;
};

function errorsOf(input: unknown) {
  const result = validateWorld(input, rpgRegistry());
  return result.errors.map((e) => ({ code: e.code, path: e.path.join('.') }));
}

describe('validateWorld', () => {
  it('accepts the RPG and the survival worlds with the same code', () => {
    expect(validateWorld(rpgWorldInput(), rpgRegistry())).toMatchObject({ ok: true, errors: [] });
    expect(validateWorld(survivalWorldInput(), survivalRegistry())).toMatchObject({ ok: true, errors: [] });
  });

  it('keeps game extension fields', () => {
    const result = validateWorld(rpgWorldInput(), rpgRegistry());
    expect(result.world?.locations[0]?.['encounters']).toEqual(['enemy:wolf']);
  });

  it('rejects predicates the world registry does not know (cross-game)', () => {
    expect(validateWorld(survivalWorldInput(), rpgRegistry()).errors.map((e) => e.code)).toContain('requirement.unknownPredicate');
  });

  const cases: [ValidationCode, (w: Json) => void, string][] = [
    ['schema.invalid', (w) => (byId(w.areas, R1).id = 'Region 1'), 'areas.1.id'],
    ['id.duplicate', (w) => w.routes.push({ ...w.routes[0], to: 'area:region_2' }), 'routes.2.id'],
    ['ref.unknownArea', (w) => (w.routes[0].to = 'area:nowhere'), 'routes.0.to'],
    ['ref.unknownArea', (w) => (w.routes[1].requires = { areaCompleted: 'area:nowhere' }), 'routes.1.requires.areaCompleted'],
    ['ref.unknownLocation', (w) => byId(w.locations, r1(9)).exits.push({ id: 'exit:x', to: 'loc:region_1.nowhere' }), 'locations.9.exits.1.to'],
    ['ref.unknownLocation', (w) => (w.routes[1].requires = { not: { discovered: 'loc:nowhere' } }), 'routes.1.requires.not.discovered'],
    ['world.noHub', (w) => (byId(w.areas, 'area:sanctuary').kind = 'safe_zone'), 'areas'],
    ['area.missingStartLocation', (w) => delete byId(w.areas, 'area:region_2').startLocation, 'areas.2.startLocation'],
    [
      'area.startLocationOutsideArea',
      (w) => (byId(w.areas, 'area:region_2').startLocation = r1(0)),
      'areas.2.startLocation',
    ],
    [
      'area.unreachableFromHub',
      (w) => w.routes.splice(0, 1),
      'areas.1.id',
    ],
    [
      'location.unassigned',
      (w) => w.locations.push({ id: 'loc:region_1.orphan', tags: ['ordinary'] }),
      'locations.12.id',
    ],
    [
      'location.multipleAreas',
      (w) => byId(w.areas, 'area:region_2').locations.push(r1(0)),
      'areas.2.locations.1',
    ],
    [
      'exit.crossArea',
      (w) => (byId(w.locations, 'loc:region_2.gate').exits = [{ id: 'exit:region_2.back', to: r1(0) }]),
      'locations.11.exits.0.to',
    ],
    [
      'completion.infeasible',
      (w) => (byId(w.locations, r1(5)).exits[0].tags = ['secret']),
      'areas.1.completion',
    ],
    [
      'completion.frozenInconsistent',
      (w) => (byId(w.areas, R1).completion.frozen.requiredCount = 6),
      'areas.1.completion.frozen.requiredCount',
    ],
    [
      'completion.poolShrunk',
      (w) => Object.assign(byId(w.areas, R1).completion.frozen, { poolSize: 11, requiredCount: 8 }),
      'areas.1.completion.frozen.poolSize',
    ],
    [
      'requirement.unknownPredicate',
      (w) => (w.routes[1].requires = { any: [{ flag: 'x' }, { game: 'hasTool', tool: 'tool:saw' }] }),
      'routes.1.requires.any.1.game',
    ],
    [
      'requirement.invalidArgs',
      (w) => (byId(w.areas, R1).completion.required = { all: [{ game: 'defeated', enemy: 'boss' }] }),
      'areas.1.completion.required.all.0',
    ],
  ];

  it.each(cases)('reports %s', (code, mutate, path) => {
    const errors = errorsOf(broken(mutate));
    expect(errors).toContainEqual({ code, path });
  });

  it('reports exactly the expected errors for a single problem', () => {
    expect(errorsOf(broken((w) => (byId(w.areas, R1).completion.frozen.requiredCount = 6)))).toEqual([
      { code: 'completion.frozenInconsistent', path: 'areas.1.completion.frozen.requiredCount' },
    ]);
  });

  it('reports unreachable locations and the resulting infeasibility', () => {
    const errors = errorsOf(broken((w) => byId(w.locations, r1(3)).exits.shift()));
    expect(errors.filter((e) => e.code === 'area.locationUnreachable').map((e) => e.path)).toEqual([
      'locations.4.id',
      'locations.5.id',
      'locations.6.id',
      'locations.7.id',
      'locations.8.id',
      'locations.9.id',
      'locations.10.id',
    ]);
    expect(errors.map((e) => e.code)).toContain('completion.infeasible');
  });

  it('secret exits count for connectivity but not for completion feasibility', () => {
    // c6 is only reachable through a secret exit: connected, but only 6 pool locations remain reachable.
    const errors = errorsOf(broken((w) => (byId(w.locations, r1(5)).exits[0].tags = ['secret'])));
    expect(errors).toEqual([{ code: 'completion.infeasible', path: 'areas.1.completion' }]);
  });

  it('accepts an unfrozen rule whose pool is reachable without secrets', () => {
    const input = broken((w) => delete byId(w.areas, R1).completion.frozen) as WorldInput;
    expect(validateWorld(input, rpgRegistry()).ok).toBe(true);
  });
});
