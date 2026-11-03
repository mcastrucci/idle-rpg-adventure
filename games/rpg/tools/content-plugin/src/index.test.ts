import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContent, compileContentDirectory, loadContentFiles, type CompileResult, type ContentFile } from '@engine/content-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import plugin, { rpgContentPlugin, RPG_ISSUE_CODES } from './index.ts';

const SEED_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
// Isolate the original technical fixture; region-1.test.ts compiles the complete real content root.
const SEED_PATHS = new Set([
  'encounter-tables/test_grove.json', 'enemies/test_grove_slime.json', 'enemies/test_grove_warden.json',
  'idle-activities/test_grove_hunt.json', 'items/test_items.json', 'loot-tables/test_grove.json',
  'progression/xp-curve.json', 'resource-nodes/test_grove_herb_patch.json', 'skills/test_skills.json',
  'world/areas/sanctuary.json', 'world/areas/test_grove.json', 'world/locations/sanctuary/plaza.json',
  'world/locations/test_grove/entrance.json', 'world/locations/test_grove/glade.json',
  'world/locations/test_grove/hidden_hollow.json', 'world/locations/test_grove/warden_den.json',
  'world/routes/sanctuary_to_test_grove.json',
]);
const SEED = loadContentFiles(SEED_ROOT).filter(file => SEED_PATHS.has(file.file));
const TEMP_ROOTS: string[] = [];
afterEach(() => { for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

interface SceneFixture {
  [key: string]: unknown;
  layers: { [key: string]: unknown; objects?: Record<string, unknown>[] }[];
}
function sceneFixture(name = 'foe_left'): SceneFixture {
  return {
    type: 'map', version: '1.10', tiledversion: '1.10.2', orientation: 'orthogonal', renderorder: 'right-down',
    width: 2, height: 2, tilewidth: 16, tileheight: 16, infinite: false, nextlayerid: 6, nextobjectid: 5, tilesets: [],
    layers: [
      // Tiled's JSON map format exports layer visibility/opacity and object IDs/visibility/zero dimensions.
      // The image dimension fields were added in 1.11.1, so this 1.10 export correctly omits them.
      { id: 1, name: 'background', type: 'imagelayer', image: 'background.png', x: 0, y: 0, offsetx: 0, offsety: 0, opacity: 1, visible: true },
      { id: 2, name: 'exits', type: 'objectgroup', draworder: 'topdown', height: 0, width: 0, x: 0, y: 0, opacity: 1, visible: true,
        objects: [{ id: 1, name: 'exit:test_grove.scene_poc.entrance', type: '', x: 4, y: 5, width: 8, height: 6, rotation: 0, opacity: 1, visible: true }] },
      { id: 3, name: 'hotspots', type: 'objectgroup', draworder: 'topdown', height: 0, width: 0, x: 0, y: 0, opacity: 1, visible: true,
        objects: [{ id: 2, name: 'scene_sign', type: '', x: 12, y: 4, width: 5, height: 5, rotation: 0, opacity: 1, visible: true }] },
      { id: 4, name: 'enemyAnchors', type: 'objectgroup', draworder: 'topdown', height: 0, width: 0, x: 0, y: 0, opacity: 1, visible: true,
        objects: [{ id: 3, name, type: '', x: 20, y: 20, width: 0, height: 0, point: true, rotation: 0, opacity: 1, visible: true }] },
      { id: 5, name: 'resources', type: 'objectgroup', draworder: 'topdown', height: 0, width: 0, x: 0, y: 0, opacity: 1, visible: true,
        objects: [{ id: 4, name: 'res:test_grove.herb_patch#0', type: '', x: 25, y: 24, width: 0, height: 0, point: true, rotation: 0, opacity: 1, visible: true }] },
    ],
  };
}

function setLayerValue(map: SceneFixture, layerIndex: number, key: string, value: unknown): void {
  const layer = map.layers[layerIndex];
  if (!layer) throw new Error(`fixture has no layer ${layerIndex}`);
  layer[key] = value;
}

function setObjectValue(map: SceneFixture, layerIndex: number, objectIndex: number, key: string, value: unknown): void {
  const layer = map.layers[layerIndex];
  const item = layer?.objects?.[objectIndex];
  if (!item) throw new Error(`fixture has no object ${layerIndex}.${objectIndex}`);
  item[key] = value;
}

function compileSceneFixture(
  map: unknown = sceneFixture(), backgroundLinkTarget?: string, additionalMaps: readonly (readonly [string, string])[] = [],
): CompileResult {
  const files = new Map(SEED.map((f) => [f.file, f.text]));
  const areaPath = 'world/areas/test_grove.json';
  const area = JSON.parse(files.get(areaPath) ?? '{}') as { locations: string[] };
  area.locations.push('loc:test_grove.scene_poc');
  files.set(areaPath, JSON.stringify(area));
  const entrancePath = 'world/locations/test_grove/entrance.json';
  const entrance = JSON.parse(files.get(entrancePath) ?? '{}') as { exits: unknown[] };
  entrance.exits.push({ id: 'exit:test_grove.entrance.scene_poc', to: 'loc:test_grove.scene_poc' });
  files.set(entrancePath, JSON.stringify(entrance));
  files.set('world/locations/test_grove/scene_poc.json', JSON.stringify({
    id: 'loc:test_grove.scene_poc', tags: ['ordinary'],
    exits: [{ id: 'exit:test_grove.scene_poc.entrance', to: 'loc:test_grove.entrance' }],
    scene: 'scenes/test_grove/scene_poc.tmj',
    resources: [{ node: 'res:test_grove.herb_patch', lootTable: 'loot:test_grove.herb_gather' }],
    hotspots: [{ id: 'scene_sign', type: 'search', textKey: 'hotspot.test_grove.scene_sign' }],
    enemyAnchors: ['foe_left'],
  }));
  if (map !== null) files.set('scenes/test_grove/scene_poc.tmj', typeof map === 'string' ? map : JSON.stringify(map));
  for (const [file, text] of additionalMaps) files.set(file, text);
  const root = mkdtempSync(path.join(tmpdir(), 'rpg-scene-')); TEMP_ROOTS.push(root);
  for (const [file, text] of files) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  const backgroundPath = path.join(root, 'scenes/test_grove/background.png');
  mkdirSync(path.dirname(backgroundPath), { recursive: true });
  if (backgroundLinkTarget) symlinkSync(backgroundLinkTarget, backgroundPath);
  else writeFileSync(backgroundPath, 'fixture image placeholder');
  return compileContentDirectory(root, plugin);
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
      merchants: 'merchants merchant',
      lootTables: 'loot-tables loot',
      encounterTables: 'encounter-tables enc',
      resourceNodes: 'resource-nodes res',
      idleActivities: 'idle-activities idle',
      progression: 'progression progression',
    });
  });
});

describe('Tiled scene import', () => {
  it('compiles a temporary location/map with normal graph ownership, parity and deterministic geometry hashing', () => {
    const first = compileSceneFixture();
    const second = compileSceneFixture();
    expect(errorsOf(first)).toEqual([]);
    if (!first.ok || !second.ok) return;
    expect(first.bundle.format).toBe(2);
    expect(first.bundle.scenes?.['loc:test_grove.scene_poc']).toEqual({
      width: 32, height: 32, background: 'scenes/test_grove/background.png',
      exits: { 'exit:test_grove.scene_poc.entrance': { x: 4, y: 5, width: 8, height: 6 } },
      hotspots: { scene_sign: { x: 12, y: 4, width: 5, height: 5 } },
      enemyAnchors: { foe_left: { x: 20, y: 20 } },
      resources: { 'res:test_grove.herb_patch#0': { x: 25, y: 24 } },
    });
    expect(second.bundle.contentHash).toBe(first.bundle.contentHash);
    const changed = sceneFixture();
    setObjectValue(changed, 2, 0, 'x', 13);
    const third = compileSceneFixture(changed);
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.bundle.contentHash).not.toBe(first.bundle.contentHash);
  });

  it('requires exact object-name parity with gameplay JSON', () => {
    const map = sceneFixture('unused_anchor');
    const result = compileSceneFixture(map);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'scene.entityParity', file: 'world/locations/test_grove/scene_poc.json', path: ['enemyAnchors'] }));
  });

  it('accepts a Tiled 1.10 style export with zero-sized point objects and optional image dimensions omitted', () => {
    const result = compileSceneFixture();
    expect(errorsOf(result)).toEqual([]);
    if (result.ok) {
      expect(result.bundle.scenes?.['loc:test_grove.scene_poc']?.enemyAnchors).toEqual({ foe_left: { x: 20, y: 20 } });
      expect(result.bundle.scenes?.['loc:test_grove.scene_poc']?.resources).toEqual({ 'res:test_grove.herb_patch#0': { x: 25, y: 24 } });
    }

    const modernExport = sceneFixture();
    setLayerValue(modernExport, 0, 'imagewidth', 32);
    setLayerValue(modernExport, 0, 'imageheight', 32);
    expect(compileSceneFixture(modernExport).ok).toBe(true);
  });

  it('rejects malformed JSON, missing and orphan maps, duplicate layers and objects', () => {
    expect(compileSceneFixture('{not json').errors.map((error) => error.code)).toContain('scene.jsonInvalid');
    expect(compileSceneFixture(null).errors.map((error) => error.code)).toContain('scene.mapMissing');

    expect(compileSceneFixture(sceneFixture(), undefined, [['scenes/test_grove/orphan.tmj', '{}']]).errors.map((error) => error.code))
      .toContain('scene.mapOrphan');

    const duplicateLayer = sceneFixture();
    const exitsLayer = duplicateLayer.layers[1];
    if (!exitsLayer) throw new Error('fixture has no exits layer');
    duplicateLayer.layers.push({ ...exitsLayer });
    expect(compileSceneFixture(duplicateLayer).errors.map((error) => error.code)).toContain('scene.duplicateLayer');

    const duplicateObject = sceneFixture();
    const anchorLayer = duplicateObject.layers[3];
    const anchorObjects = anchorLayer?.objects;
    const anchor = anchorObjects?.[0];
    if (!anchorObjects || !anchor) throw new Error('fixture has no anchor object');
    anchorObjects.push({ ...anchor });
    expect(compileSceneFixture(duplicateObject).errors.map((error) => error.code)).toContain('scene.duplicateObject');
  });

  it('rejects hidden objects and malformed optional Tiled boolean fields', () => {
    for (const [field, value] of [['visible', false], ['visible', 'false'], ['point', null], ['ellipse', 'false']] as const) {
      const map = sceneFixture();
      setObjectValue(map, 3, 0, field, value);
      expect(compileSceneFixture(map).ok).toBe(false);
    }
    for (const [field, value] of [['visible', 'true'], ['repeatx', 'false'], ['repeaty', null]] as const) {
      const map = sceneFixture();
      setLayerValue(map, 0, field, value);
      expect(compileSceneFixture(map).ok).toBe(false);
    }
    const hidden = sceneFixture();
    setObjectValue(hidden, 3, 0, 'visible', false);
    expect(compileSceneFixture(hidden).errors.map((error) => error.code)).toContain('scene.unsupportedObject');

    const hiddenLayer = sceneFixture();
    setLayerValue(hiddenLayer, 0, 'visible', false);
    expect(compileSceneFixture(hiddenLayer).errors.map((error) => error.code)).toContain('scene.unsupportedTransform');
    const repeatedBackground = sceneFixture();
    setLayerValue(repeatedBackground, 0, 'repeatx', true);
    expect(compileSceneFixture(repeatedBackground).errors.map((error) => error.code)).toContain('scene.unsupportedTransform');
  });

  it('rejects explicit null or wrong-typed numeric transform fields instead of applying defaults', () => {
    for (const [layerIndex, field, value] of [[0, 'offsetx', null], [0, 'parallaxx', '1'], [1, 'x', null]] as const) {
      const map = sceneFixture();
      setLayerValue(map, layerIndex, field, value);
      expect(compileSceneFixture(map).ok).toBe(false);
    }
    const object = sceneFixture();
    setObjectValue(object, 3, 0, 'rotation', null);
    expect(compileSceneFixture(object).errors.map((error) => error.code)).toContain('scene.unsupportedObject');

    const sizedPoint = sceneFixture();
    setObjectValue(sizedPoint, 3, 0, 'width', 1);
    expect(compileSceneFixture(sizedPoint).errors.map((error) => error.code)).toContain('scene.unsupportedObject');

    const wrongBackgroundDimensions = sceneFixture();
    setLayerValue(wrongBackgroundDimensions, 0, 'imagewidth', 31);
    expect(compileSceneFixture(wrongBackgroundDimensions).errors.map((error) => error.code)).toContain('scene.backgroundSize');
  });

  it('rejects transformed, out-of-bounds and traversal paths in the real compiler path', () => {
    const transformed = sceneFixture();
    setLayerValue(transformed, 1, 'offsetx', 1);
    expect(compileSceneFixture(transformed).errors.map((error) => error.code)).toContain('scene.unsupportedTransform');
    const bounds = sceneFixture();
    setObjectValue(bounds, 1, 0, 'x', 28);
    expect(compileSceneFixture(bounds).errors.map((error) => error.code)).toContain('scene.outOfBounds');
    const pathEscape = sceneFixture();
    setLayerValue(pathEscape, 0, 'image', '../background.png');
    expect(compileSceneFixture(pathEscape).errors.map((error) => error.code)).toContain('scene.imagePathRejected');
    const externalDir = mkdtempSync(path.join(tmpdir(), 'rpg-scene-external-'));
    TEMP_ROOTS.push(externalDir);
    const externalImage = path.join(externalDir, 'outside.png');
    writeFileSync(externalImage, 'external image');
    expect(compileSceneFixture(sceneFixture(), externalImage).errors.map((error) => error.code)).toContain('scene.imagePathRejected');
    const externalTileset = sceneFixture();
    externalTileset['tilesets'] = [{ firstgid: 1, source: '../outside.tsx' }];
    expect(compileSceneFixture(externalTileset).errors.map((error) => error.code)).toContain('scene.unsupportedMap');
  });

  it('keeps scene-less bundles on the format-1 hash contract', () => {
    const result = compileSeed();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.format).toBe(1);
      expect(result.bundle).not.toHaveProperty('scenes');
    }
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
      merchants: 0,
      lootTables: 3,
      progression: 1,
      resourceNodes: 1,
      skills: 2,
    });
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects merchant offers for materials; POC merchants sell stackable consumables only', () => {
    const result = compileSeed({ add: { 'merchants/test.json': { id: 'merchant:test', offers: [
      { id: 'offer:herb', item: 'item:test_grove.herb', buyPrice: { currency: 'gold', amount: 10 } },
    ] } } });
    expect(errorsOf(result)).toContain('rpg.merchantOfferInvalidItem merchants/test.json offers.0.item');
  });

  it('requires offer IDs to be unique across merchant catalogs', () => {
    const offer = { id: 'offer:test_tonic', item: 'item:test_tonic', buyPrice: { currency: 'gold', amount: 10 } };
    const result = compileSeed({ add: {
      'merchants/first.json': { id: 'merchant:first', offers: [offer] },
      'merchants/second.json': { id: 'merchant:second', offers: [offer] },
    } });
    expect(errorsOf(result)).toContain('rpg.merchantOfferIdDuplicate merchants/second.json offers.0.id');
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
