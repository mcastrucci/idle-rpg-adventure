import { fileURLToPath } from 'node:url';

import { compileContent, loadContentFiles, type CompileResult, type ContentFile } from '@engine/content-compiler';
import { describe, expect, it } from 'vitest';

import plugin, { rpgContentPlugin, RPG_ISSUE_CODES } from './index.ts';

const SEED_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
const SEED = loadContentFiles(SEED_ROOT);

/** In-memory edits of the seed content: text replacements in a file, new files, removed files. */
interface Edits {
  readonly replace?: readonly (readonly [file: string, from: string, to: string])[];
  readonly add?: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
}

function compileSeed(edits: Edits = {}): CompileResult {
  const files = new Map(SEED.map((f) => [f.file, f.text]));
  for (const [file, from, to] of edits.replace ?? []) {
    const text = files.get(file);
    if (text === undefined || !text.includes(from)) throw new Error(`fixture: "${from}" not found in ${file}`);
    files.set(file, text.replace(from, to));
  }
  for (const [file, value] of Object.entries(edits.add ?? {})) files.set(file, JSON.stringify(value));
  for (const file of edits.remove ?? []) {
    if (!files.delete(file)) throw new Error(`fixture: no file ${file}`);
  }
  const list: ContentFile[] = [...files].map(([file, text]) => ({ file, text }));
  return compileContent(list, plugin);
}

/** `code file $path` of every error, for compact assertions. */
function errorsOf(result: CompileResult): string[] {
  return result.errors.map((e) => `${e.code} ${e.file ?? '-'} ${e.path.join('.')}`);
}

describe('rpgContentPlugin', () => {
  it('is the default export', () => {
    expect(plugin).toBe(rpgContentPlugin);
    expect(plugin.id).toBe('rpg');
  });

  it('registers every RPG collection under the content-format directories', () => {
    const dirs = Object.fromEntries(Object.entries(plugin.collections).map(([name, def]) => [name, `${def.dir} ${def.idPrefix}`]));
    expect(dirs).toEqual({
      enemies: 'enemies enemy',
      skills: 'skills skill',
      items: 'items item',
      lootTables: 'loot-tables loot',
      encounterTables: 'encounter-tables enc',
      resourceNodes: 'resource-nodes res',
      idleActivities: 'idle-activities idle',
      progression: 'progression progression',
    });
  });
});

describe('seed content (games/rpg/content)', () => {
  it('compiles without errors', () => {
    const result = compileSeed();
    expect(errorsOf(result)).toEqual([]);
    if (!result.ok) return;
    const { bundle } = result;
    expect(bundle.game).toBe('rpg');
    expect(bundle.world.areas.map((a) => `${a.id} ${a.kind}`)).toEqual(['area:sanctuary hub', 'area:test_grove explorable']);
    expect(bundle.world.routes.map((r) => r.id)).toEqual(['route:sanctuary_to_test_grove']);
    expect(bundle.world.locations).toHaveLength(5);
    expect(Object.fromEntries(Object.entries(bundle.collections).map(([name, list]) => [name, list.length]))).toEqual({
      encounterTables: 3,
      enemies: 2,
      idleActivities: 1,
      items: 2,
      lootTables: 3,
      progression: 1,
      resourceNodes: 1,
      skills: 2,
    });
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies RPG field defaults to compiled locations', () => {
    const result = compileSeed();
    if (!result.ok) throw new Error('seed must compile');
    const plaza = result.bundle.world.locations.find((l) => l.id === 'loc:sanctuary.plaza');
    expect(plaza).toMatchObject({ resources: [], hotspots: [] });
  });
});

describe('world extensions', () => {
  it('rejects unknown fields on locations (typos) once', () => {
    const result = compileSeed({
      replace: [['world/locations/test_grove/glade.json', '"encounters":', '"encounter":']],
    });
    expect(errorsOf(result)).toEqual(['schema.invalid world/locations/test_grove/glade.json ']);
  });

  it('requires difficulty on explorable areas', () => {
    const result = compileSeed({ replace: [['world/areas/test_grove.json', '"difficulty": 1,', '']] });
    expect(errorsOf(result)).toEqual(['schema.invalid world/areas/test_grove.json difficulty']);
  });

  it('does not report engine field errors twice', () => {
    const result = compileSeed({ replace: [['world/areas/test_grove.json', '"startLocation": "loc:', '"startLocation": "bad:']] });
    expect(errorsOf(result)).toEqual(['schema.invalid world/areas/test_grove.json startLocation']);
  });

  it('restricts area activities to idle activity IDs', () => {
    const result = compileSeed({ replace: [['world/areas/test_grove.json', '"idle:test_grove.hunt"', '"enc:test_grove.hunt"']] });
    expect(errorsOf(result)).toEqual(['schema.invalid world/areas/test_grove.json activities.0']);
  });
});

describe('references', () => {
  const cases: [name: string, edits: Edits, expected: string][] = [
    [
      'loot entry → item',
      { replace: [['loot-tables/test_grove.json', '"item": "item:test_tonic",\n        "weight"', '"item": "item:nope",\n        "weight"']] },
      'ref.unknown loot-tables/test_grove.json 0.entries.1.item',
    ],
    [
      'guaranteed drop → item',
      { replace: [['loot-tables/test_grove.json', '"item": "item:test_tonic",\n        "qty"', '"item": "item:nope",\n        "qty"']] },
      'ref.unknown loot-tables/test_grove.json 1.guaranteed.0.item',
    ],
    [
      'encounter group → enemy',
      { replace: [['encounter-tables/test_grove.json', '"enemy:test_grove.warden"', '"enemy:nope"']] },
      'ref.unknown encounter-tables/test_grove.json 1.entries.0.enemies.0.enemy',
    ],
    [
      'enemy skills → skill',
      { replace: [['enemies/test_grove_slime.json', '"skills": [\n    "skill:test_strike"', '"skills": [\n    "skill:test_strike", "skill:nope"']] },
      'ref.unknown enemies/test_grove_slime.json skills.1',
    ],
    [
      'enemy loot table → loot table',
      { replace: [['enemies/test_grove_slime.json', '"loot:test_grove.slime"', '"loot:nope"']] },
      'ref.unknown enemies/test_grove_slime.json lootTable',
    ],
    [
      'idle activity encounter table → encounter table',
      { replace: [['idle-activities/test_grove_hunt.json', '"enc:test_grove.hunt"', '"enc:nope"']] },
      'ref.unknown idle-activities/test_grove_hunt.json encounterTable',
    ],
    [
      'idle activity yield → resource node',
      { replace: [['idle-activities/test_grove_hunt.json', '"res:test_grove.herb_patch"', '"res:nope"']] },
      'ref.unknown idle-activities/test_grove_hunt.json resourceYields.0.node',
    ],
    [
      'location encounters → encounter table',
      { replace: [['world/locations/test_grove/warden_den.json', '"enc:test_grove.warden"', '"enc:nope"']] },
      'ref.unknown world/locations/test_grove/warden_den.json encounters',
    ],
    [
      'location resource → resource node',
      { replace: [['world/locations/test_grove/hidden_hollow.json', '"res:test_grove.herb_patch"', '"res:nope"']] },
      'ref.unknown world/locations/test_grove/hidden_hollow.json resources.0.node',
    ],
    [
      'location resource → loot table',
      { replace: [['world/locations/test_grove/hidden_hollow.json', '"loot:test_grove.herb_gather"', '"loot:nope"']] },
      'ref.unknown world/locations/test_grove/hidden_hollow.json resources.0.lootTable',
    ],
    [
      'area activities → idle activity',
      { replace: [['world/areas/test_grove.json', '"idle:test_grove.hunt"', '"idle:nope"']] },
      'ref.unknown world/areas/test_grove.json activities.0',
    ],
    [
      'completion defeated → enemy',
      { replace: [['world/areas/test_grove.json', '"enemy:test_grove.warden"', '"enemy:nope"']] },
      'ref.unknown world/areas/test_grove.json completion.required.all.0.enemy',
    ],
    [
      'exit hasItem → item',
      {
        replace: [
          [
            'world/locations/test_grove/glade.json',
            '"requires": {\n        "game": "levelAtLeast",\n        "level": 2\n      }',
            '"requires": { "any": [{ "hasItem": { "item": "item:nope", "qty": 1 } }] }',
          ],
        ],
      },
      'ref.unknown world/locations/test_grove/glade.json exits.1.requires.any.0.hasItem.item',
    ],
    [
      'enemy AI skillReady → skill',
      { replace: [['enemies/test_grove_warden.json', '"skillReady": "skill:test_slam"', '"skillReady": "skill:nope"']] },
      'ref.unknown enemies/test_grove_warden.json ai.0.when.skillReady',
    ],
  ];

  it.each(cases)('%s', (_name, edits, expected) => {
    expect(errorsOf(compileSeed(edits))).toEqual([expected]);
  });

  it('resolves route requirements too', () => {
    const result = compileSeed({
      replace: [['world/routes/sanctuary_to_test_grove.json', '"travel"', '"requires": { "game": "defeated", "enemy": "enemy:nope" },\n  "travel"']],
    });
    expect(errorsOf(result)).toEqual(['ref.unknown world/routes/sanctuary_to_test_grove.json requires.enemy']);
  });
});

describe('cross-document checks (validate hook)', () => {
  it('telegraphed boss skills need windupTicks > 0', () => {
    const result = compileSeed({ replace: [['skills/test_skills.json', '"windupTicks": 3', '"windupTicks": 0']] });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.telegraphWithoutWindup} enemies/test_grove_warden.json phases.1.telegraphs.0`]);
  });

  it('enemies required by area completion must be bosses', () => {
    const result = compileSeed({ replace: [['world/areas/test_grove.json', '"enemy:test_grove.warden"', '"enemy:test_grove.slime"']] });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.completionEnemyNotBoss} world/areas/test_grove.json completion.required.all.0.enemy`]);
  });

  it('idle activities are only allowed on explorable areas', () => {
    const result = compileSeed({
      replace: [['world/areas/sanctuary.json', '"kind": "hub",', '"kind": "hub",\n  "activities": ["idle:test_grove.hunt"],']],
    });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.activitiesOnNonExplorable} world/areas/sanctuary.json activities`]);
  });

  it('an XP curve must be present', () => {
    const result = compileSeed({ remove: ['progression/xp-curve.json'] });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.xpCurveMissing} - `]);
  });

  it('there is exactly one XP curve', () => {
    const result = compileSeed({ add: { 'progression/other.json': { id: 'progression:other_curve', xpToNext: [10, 20] } } });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.xpCurveUnexpected} progression/other.json id`]);
  });

  it('validates the XP curve with the rpg-schema rules', () => {
    const result = compileSeed({ replace: [['progression/xp-curve.json', '250', '50']] });
    expect(errorsOf(result)).toEqual(['schema.invalid progression/xp-curve.json xpToNext.1']);
  });

  it('AI skillReady conditions must name one of the enemy skills', () => {
    const result = compileSeed({ replace: [['enemies/test_grove_slime.json', '"when": {}', '"when": { "skillReady": "skill:test_slam" }']] });
    expect(errorsOf(result)).toEqual([`${RPG_ISSUE_CODES.aiSkillNotKnown} enemies/test_grove_slime.json ai.0.when.skillReady`]);
  });
});
