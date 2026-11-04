/**
 * Automated evidence for #44 / ADR-0014: a new location is added with one Tiled map and location JSON (plus the
 * data links the authoring guide prescribes) and no code change. Every step follows docs/content/authoring-scenes.md;
 * validation runs through the same `runCli` entry point as `pnpm content-cli validate|build`.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, type ContentBundle } from '@engine/content-compiler';
import { afterEach, describe, expect, it } from 'vitest';

const REAL_CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url));
const PLUGIN = fileURLToPath(new URL('./index.ts', import.meta.url));

const AREA = 'world/areas/region_1.json';
const HUB = 'world/locations/region_1/old_well.json'; // existing, scene-less location that gets the new exit
const NEW_LOC = 'loc:region_1.mossy_cistern';
const NEW_LOC_FILE = 'world/locations/region_1/mossy_cistern.json';
const NEW_SCENE = 'scenes/region_1/mossy_cistern.tmj';
const NEW_IMAGE = 'scenes/region_1/mossy_cistern.png';
const EXIT_BACK = 'exit:region_1.mossy_cistern.old_well';
const EXIT_IN = 'exit:region_1.old_well.mossy_cistern';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A fresh temp dir holding `content/` (a copy of the real tree) next to scratch space for bundles. */
function copyRealContent(): string {
  const parent = mkdtempSync(path.join(tmpdir(), 'no-code-location-'));
  roots.push(parent);
  const root = path.join(parent, 'content');
  cpSync(REAL_CONTENT, root, { recursive: true });
  return root;
}
const scratch = (root: string, name: string): string => path.join(path.dirname(root), name);
const readJson = (root: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
function writeText(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}
const writeJson = (root: string, file: string, value: unknown): void => writeText(root, file, `${JSON.stringify(value, null, 2)}\n`);

/** The map an author saves from Tiled: 64x48 tiles of 16px, one image layer, `exits` and `hotspots` object layers. */
function tiledMap(overrides: { hotspotName?: string; extraHotspot?: string } = {}): Record<string, unknown> {
  const rect = (id: number, name: string, x: number, y: number, width: number, height: number) =>
    ({ id, name, type: '', x, y, width, height, rotation: 0, opacity: 1, visible: true });
  const group = (id: number, name: string, objects: unknown[]) =>
    ({ id, name, type: 'objectgroup', draworder: 'topdown', x: 0, y: 0, width: 0, height: 0, opacity: 1, visible: true, objects });
  return {
    type: 'map', version: '1.11', tiledversion: '1.11.2', orientation: 'orthogonal', renderorder: 'right-down',
    width: 64, height: 48, tilewidth: 16, tileheight: 16, infinite: false, nextlayerid: 4, nextobjectid: 5, tilesets: [],
    layers: [
      { id: 1, name: 'background', type: 'imagelayer', image: 'mossy_cistern.png', imagewidth: 1024, imageheight: 768,
        x: 0, y: 0, offsetx: 0, offsety: 0, opacity: 1, visible: true },
      group(2, 'exits', [rect(1, EXIT_BACK, 40, 700, 96, 48)]),
      group(3, 'hotspots', [
        rect(2, overrides.hotspotName ?? 'mossy_valve', 512, 200, 64, 64),
        ...(overrides.extraHotspot ? [rect(3, overrides.extraHotspot, 100, 100, 32, 32)] : []),
      ]),
    ],
  };
}

function locationJson(overrides: { exits?: unknown[] } = {}): Record<string, unknown> {
  return {
    id: NEW_LOC,
    nameKey: 'loc.region_1.mossy_cistern.name',
    tags: ['ordinary'],
    scene: NEW_SCENE,
    exits: overrides.exits ?? [{ id: EXIT_BACK, to: 'loc:region_1.old_well' }],
    resources: [],
    hotspots: [{ id: 'mossy_valve', type: 'lore', textKey: 'hotspot.region_1.mossy_valve' }],
    encounters: 'enc:region_1.old_well',
  };
}

/** The author's steps from the guide: .tmj + image, location JSON, area `locations`, matching exit in the neighbour. */
function addLocation(root: string, opts: { map?: Record<string, unknown> | null; location?: Record<string, unknown> | null; link?: boolean } = {}): void {
  const map = opts.map === undefined ? tiledMap() : opts.map;
  if (map !== null) {
    writeText(root, NEW_SCENE, JSON.stringify(map));
    writeText(root, NEW_IMAGE, 'placeholder image bytes'); // the importer never inspects pixels
  }
  const location = opts.location === undefined ? locationJson() : opts.location;
  if (location !== null) writeJson(root, NEW_LOC_FILE, location);
  if (opts.link !== false) {
    const area = readJson(root, AREA);
    (area['locations'] as string[]).push(NEW_LOC);
    writeJson(root, AREA, area);
    const hub = readJson(root, HUB);
    (hub['exits'] as unknown[]).push({ id: EXIT_IN, to: NEW_LOC });
    writeJson(root, HUB, hub);
  }
}

interface CliRun { code: number; stderr: string; issueCodes: string[] }
async function cli(args: string[]): Promise<CliRun> {
  let stderr = '';
  const code = await runCli([...args, '--game', PLUGIN], { cwd: process.cwd(), stdout: () => undefined, stderr: t => { stderr += t; } });
  // Issue codes are `namespace.camelCase` tokens in the CLI's error listing.
  const issueCodes = [...stderr.matchAll(/\b([a-z]+\.[a-zA-Z]+)\b(?=\s)/g)].map(m => m[1] as string).filter(c => /^(scene|area|baseline|rpg|world|ref|schema|id|previous)\./.test(c));
  return { code, stderr, issueCodes };
}
const validate = (root: string): Promise<CliRun> => cli(['validate', root]);
async function build(root: string, extra: string[] = []): Promise<{ run: CliRun; bundle?: ContentBundle }> {
  const out = scratch(root, `bundle-${Math.random().toString(36).slice(2)}.json`);
  const run = await cli(['build', root, '--out', out, ...extra]);
  if (run.code !== 0) return { run };
  return { run, bundle: JSON.parse(readFileSync(out, 'utf8')) as ContentBundle };
}

function reachable(bundle: ContentBundle, from: string): Set<string> {
  const exits = new Map<string, string[]>(bundle.world.locations.map(l => [l.id, l.exits.map(e => e.to)]));
  const seen = new Set<string>([from]);
  for (const id of seen) for (const next of exits.get(id) ?? []) seen.add(next);
  return seen;
}

describe('no-code location (#44, ADR-0014)', () => {
  it('real content validates before any edit (baseline of the experiment)', async () => {
    const run = await validate(REAL_CONTENT);
    expect(run.code, run.stderr).toBe(0);
  });

  it('adds a Region 1 location with a .tmj + one JSON file and data-only links, with no issues', async () => {
    const before = (await build(copyRealContent())).bundle;
    expect(before?.format).toBe(1);

    const root = copyRealContent();
    addLocation(root);

    const validated = await validate(root);
    expect(validated.code, validated.stderr).toBe(0);
    const { run, bundle } = await build(root);
    expect(run.code, run.stderr).toBe(0);
    if (!bundle || !before) throw new Error('bundles missing');

    // The bundle contains the new location and its normalized geometry (format 2 once any scene exists).
    expect(bundle.format).toBe(2);
    expect(bundle.world.locations.map(l => l.id)).toContain(NEW_LOC);
    expect(bundle.scenes?.[NEW_LOC]).toEqual({
      width: 1024, height: 768, background: NEW_IMAGE,
      exits: { [EXIT_BACK]: { x: 40, y: 700, width: 96, height: 48 } },
      hotspots: { mossy_valve: { x: 512, y: 200, width: 64, height: 64 } },
      enemyAnchors: {}, resources: {},
    });
    expect(Object.keys(bundle.scenes ?? {})).toEqual([NEW_LOC]);
    expect(bundle.contentHash).not.toBe(before.contentHash);

    // Reachable through the exit graph from the area's start location, and back.
    const area = bundle.world.areas.find(a => a.id === 'area:region_1');
    expect(area?.locations).toContain(NEW_LOC);
    expect(reachable(bundle, area?.startLocation ?? '')).toContain(NEW_LOC);
    expect(reachable(bundle, NEW_LOC)).toContain(area?.startLocation);

    // Everything else is untouched: other areas, routes and all game collections are identical.
    const otherAreas = (b: ContentBundle) => b.world.areas.filter(a => a.id !== 'area:region_1');
    expect(otherAreas(bundle)).toEqual(otherAreas(before));
    expect(bundle.collections).toEqual(before.collections);
    expect(bundle.world.routes).toEqual(before.world.routes);
    const untouched = (b: ContentBundle) => b.world.locations.filter(l => l.id !== NEW_LOC && l.id !== 'loc:region_1.old_well');
    expect(untouched(bundle)).toEqual(untouched(before));
  });

  it('keeps an existing frozen conquest baseline unchanged when the new location is added', async () => {
    // Publish a baseline: freeze region_1 (a data edit, as at publication), build it, then add the location against it.
    const root = copyRealContent();
    const area = readJson(root, AREA);
    (area['completion'] as Record<string, unknown>)['frozen'] = { poolSize: 8, requiredCount: 6, at: '2026-11-01' };
    writeJson(root, AREA, area);
    const published = await build(root);
    expect(published.run.code, published.run.stderr).toBe(0);
    const previousFile = scratch(root, 'previous.json');
    writeFileSync(previousFile, JSON.stringify(published.bundle));

    addLocation(root);
    const { run, bundle } = await build(root, ['--previous', previousFile]);
    expect(run.code, run.stderr).toBe(0);
    expect(bundle?.world.areas.find(a => a.id === 'area:region_1')?.completion?.frozen).toEqual({ poolSize: 8, requiredCount: 6, at: '2026-11-01' });
    expect(bundle?.world.locations.find(l => l.id === NEW_LOC)?.tags).toContain('ordinary'); // joins the live pool, not the frozen count
  });

  describe('negative cases fail with the documented issue code', () => {
    it('(a) an exit in JSON without Tiled geometry -> scene.entityParity', async () => {
      const root = copyRealContent();
      addLocation(root, { location: locationJson({ exits: [
        { id: EXIT_BACK, to: 'loc:region_1.old_well' },
        { id: 'exit:region_1.mossy_cistern.pump_station', to: 'loc:region_1.pump_station' },
      ] }) });
      const run = await validate(root);
      expect(run.code).toBe(1);
      expect(run.issueCodes).toEqual(['scene.entityParity']);
      expect(run.stderr).toContain(NEW_LOC_FILE);
    });

    it('(b) a Tiled object with no JSON counterpart -> scene.entityParity', async () => {
      const root = copyRealContent();
      addLocation(root, { map: tiledMap({ extraHotspot: 'undeclared_lever' }) });
      const run = await validate(root);
      expect(run.code).toBe(1);
      expect(run.issueCodes).toEqual(['scene.entityParity']);
    });

    it('(b2) a Tiled object name differing in case from the JSON id -> scene.entityParity', async () => {
      const root = copyRealContent();
      addLocation(root, { map: tiledMap({ hotspotName: 'Mossy_Valve' }) });
      const run = await validate(root);
      expect(run.code).toBe(1);
      expect(run.issueCodes).toEqual(['scene.entityParity']);
    });

    it('(c) a .tmj without location JSON -> scene.mapOrphan', async () => {
      const root = copyRealContent();
      addLocation(root, { location: null, link: false });
      const run = await validate(root);
      expect(run.code).toBe(1);
      expect(run.issueCodes).toEqual(['scene.mapOrphan']);
      expect(run.stderr).toContain(NEW_SCENE);
    });

    it('(d) location JSON declaring `scene` without the .tmj -> scene.mapMissing', async () => {
      const root = copyRealContent();
      addLocation(root, { map: null });
      const run = await validate(root);
      expect(run.code).toBe(1);
      expect(run.issueCodes).toEqual(['scene.mapMissing']);
    });
  });
});
