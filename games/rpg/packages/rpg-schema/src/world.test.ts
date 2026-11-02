import {
  AreaSchema,
  LocationSchema,
  createActorWorldState,
  evaluateRequirement,
  validateWorld,
  type EvalContext,
  type Requirement,
} from '@engine/world';
import { describe, expect, it } from 'vitest';

import { RpgAreaSchema, RpgLocationSchema, createRpgPredicateRegistry, rpgCollections, rpgJsonSchemas, type RpgGameContext } from './index.ts';
import { issuePaths, oldWell, verdantHollow } from './testing/examples.ts';

describe('area and location extensions', () => {
  it('parses the migrated spec examples with both the RPG and the engine schemas', () => {
    const area = RpgAreaSchema.parse(verdantHollow);
    expect(area.recommendedLevel).toEqual([1, 6]);
    expect(AreaSchema.parse(verdantHollow).id).toBe('area:verdant_hollow');

    const location = RpgLocationSchema.parse(oldWell);
    expect(location.hotspots[0]).toEqual({ id: 'inscription', type: 'lore', textKey: 'lore.old_well.inscription' });
    expect(location.exits[1]?.tags).toEqual([]);
    // The engine's loose schema keeps the RPG fields untouched.
    expect(LocationSchema.parse(oldWell)).toMatchObject({ encounters: 'enc:verdant_hollow.well' });
  });

  it('accepts a hub without RPG difficulty fields', () => {
    expect(RpgAreaSchema.safeParse({ id: 'area:sanctuary', kind: 'hub' }).success).toBe(true);
  });

  it('rejects invalid RPG fields with useful paths', () => {
    expect(issuePaths(RpgAreaSchema, { ...verdantHollow, difficulty: undefined })).toEqual(['difficulty']);
    expect(issuePaths(RpgAreaSchema, { ...verdantHollow, recommendedLevel: [6, 1] })).toEqual(['recommendedLevel']);
    expect(issuePaths(RpgAreaSchema, { ...verdantHollow, activities: ['hunt:x'] })).toEqual(['activities.0']);
    expect(issuePaths(RpgAreaSchema, { ...verdantHollow, mandatoryBosses: [] })).toEqual(['']);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, encounters: 'loot:well' })).toEqual(['encounters']);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, resources: [{ node: 'item:glowcap', lootTable: 'loot:x' }] })).toEqual([
      'resources.0.node',
    ]);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, hotspots: [{ id: 'a', type: 'portal', textKey: 'x.y' }] })).toEqual([
      'hotspots.0.type',
    ]);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, hotspots: [...oldWell.hotspots, ...oldWell.hotspots] })).toEqual([
      'hotspots.1.id',
    ]);
    // Declarative hotspot effects (#38): flag names are validated, lore hotspots stay read-only.
    const lever = { id: 'lever', type: 'interact', textKey: 'x.y', effects: [{ setFlag: 'area_1.gate_open' }] };
    expect(RpgLocationSchema.parse({ ...oldWell, hotspots: [lever] }).hotspots[0]?.effects).toEqual([{ setFlag: 'area_1.gate_open' }]);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, hotspots: [{ ...lever, effects: [{ setFlag: 'Gate Open' }] }] })).toEqual([
      'hotspots.0.effects.0.setFlag',
    ]);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, hotspots: [{ ...lever, type: 'lore' }] })).toEqual(['hotspots.0.effects']);
    expect(issuePaths(RpgLocationSchema, { ...oldWell, hotspots: [{ ...lever, effects: [] }] })).toEqual(['hotspots.0.effects']);
    // Engine fields are still validated (and strict at the engine level).
    expect(issuePaths(RpgLocationSchema, { ...oldWell, exits: [{ id: 'exit:a', to: 'area:x' }] })).toEqual(['exits.0.to']);
  });
});

describe('RPG requirement predicates', () => {
  const registry = createRpgPredicateRegistry();
  const ctx = (game: Partial<RpgGameContext> = {}): EvalContext<RpgGameContext> => ({
    actor: createActorWorldState(),
    game: { defeatedEnemies: new Set(), level: 1, ...game },
  });
  const evaluate = (req: Requirement, c = ctx()) => evaluateRequirement(req, c, registry);

  it('registers defeated and levelAtLeast', () => {
    expect(registry.names()).toEqual(['defeated', 'levelAtLeast']);
  });

  it('defeated', () => {
    const req = { game: 'defeated', enemy: 'enemy:hollow_matriarch' };
    expect(evaluate(req)).toEqual({ ok: false, reasons: ['requires.game.defeated:enemy:hollow_matriarch'] });
    expect(evaluate(req, ctx({ defeatedEnemies: new Set(['enemy:hollow_matriarch']) }))).toEqual({ ok: true, reasons: [] });
  });

  it('levelAtLeast', () => {
    const req = { game: 'levelAtLeast', level: 5 };
    expect(evaluate(req, ctx({ level: 4 }))).toEqual({ ok: false, reasons: ['requires.game.levelAtLeast:5'] });
    expect(evaluate(req, ctx({ level: 5 })).ok).toBe(true);
  });

  it('composes with engine predicates and fails closed on bad arguments', () => {
    const req = { all: [{ game: 'levelAtLeast', level: 3 }, { flag: 'met_guide' }] };
    expect(evaluate(req, ctx({ level: 3 }))).toEqual({ ok: false, reasons: ['requires.flag:met_guide'] });
    expect(evaluate({ game: 'defeated', enemy: 'skill:boar' })).toEqual({ ok: false, reasons: ['requires.invalidArgs:defeated'] });
    expect(evaluate({ game: 'levelAtLeast', level: 2.5 }, ctx({ level: 9 })).ok).toBe(false);
  });

  it('lets the engine validate an RPG world whose completion requires a defeated boss', () => {
    const portal = 'loc:verdant_hollow.portal_clearing';
    const result = validateWorld(
      {
        areas: [{ id: 'area:sanctuary', kind: 'hub' }, {
            ...verdantHollow,
            locations: [portal, oldWell.id],
            completion: { pool: { tag: 'ordinary' }, thresholdBp: 7000, required: { game: 'defeated', enemy: 'enemy:hollow_matriarch' } },
          },],
        routes: [{ id: 'route:to_vh', from: 'area:sanctuary', to: 'area:verdant_hollow', travel: { mode: 'instant' } }],
        locations: [
          { id: portal, tags: ['ordinary'], exits: [{ id: 'exit:vh.portal.well', to: oldWell.id, requires: { game: 'levelAtLeast', level: 2 } }] },
          { ...oldWell, exits: [{ id: 'exit:vh.well.portal', to: portal }] },
        ],
      },
      registry,
    );
    expect(result).toMatchObject({ ok: true, errors: [] });
  });
});

describe('plugin-ready exports', () => {
  it('declares collections with schemas and ID prefixes', () => {
    expect(Object.fromEntries(Object.entries(rpgCollections).map(([name, def]) => [name, def.idPrefix]))).toEqual({
      enemies: 'enemy:',
      skills: 'skill:',
      items: 'item:',
      lootTables: 'loot:',
      encounterTables: 'enc:',
      resourceNodes: 'res:',
      idleActivities: 'idle:',
    });
  });

  it('exports JSON Schemas for every document type', () => {
    const schemas = rpgJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual(
      ['area', 'encounterTables', 'enemies', 'idleActivities', 'items', 'location', 'lootTables', 'resourceNodes', 'skills', 'xpCurve'].sort(),
    );
    expect(JSON.stringify(schemas.skills)).toContain('"cooldownTicks"');
  });
});
