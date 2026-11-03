import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory, contentHashOf } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import { parseServerConfig } from '@engine/server-kit';
import rpgContentPlugin from '@rpg/content-plugin';
import { afterEach, describe, expect, it } from 'vitest';

import { createRpgServer } from './index.ts';
import { validateRpgBundle } from './content.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
export function compiledRpgContent(): ContentBundle {
  const compiled = compileContentDirectory(fileURLToPath(new URL('../../../content', import.meta.url)), rpgContentPlugin);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.bundle;
}
describe('RPG boot composition', () => {
  it('accepts the real compiled RPG seed', () => { expect(() => validateRpgBundle(compiledRpgContent())).not.toThrow(); });
  it.each(['skills', 'lootTables', 'items', 'encounterTables', 'resourceNodes', 'idleActivities'])('rejects hash-valid bundles missing referenced %s', (name) => {
    const seed = compiledRpgContent();
    const body = { format: seed.format, game: seed.game, world: seed.world, collections: { ...seed.collections, [name]: [] } };
    expect(() => validateRpgBundle({ ...body, contentHash: contentHashOf(body) })).toThrow(/unresolved RPG reference/);
  });
  it('rejects duplicate IDs and dangling references in world requirements', () => {
    const seed = compiledRpgContent();
    const items = seed.collections['items'];
    if (!items?.[0]) throw new Error('seed needs items');
    expect(() => validateRpgBundle({ ...seed, collections: { ...seed.collections, items: [...items, items[0]] } })).toThrow(/duplicate entity ID/);
    const area = seed.world.areas[0];
    if (!area) throw new Error('seed needs areas');
    area.revealedBy = { game: 'defeated', enemy: 'enemy:missing' };
    expect(() => validateRpgBundle(seed)).toThrow(/unresolved RPG reference/);
  });
  it('rejects hash-valid malformed RPG extensions before opening the database', async () => {
    const seed = compiledRpgContent();
    const area = seed.world.areas.find((area) => area.kind === 'explorable');
    if (area === undefined) throw new Error('test seed must include an explorable area');
    area['difficulty'] = -1;
    const body = { format: seed.format, game: seed.game, world: seed.world, collections: seed.collections };
    const tampered = { ...body, contentHash: contentHashOf(body) };
    const dir = await mkdtemp(join(tmpdir(), 'rpg-invalid-')); dirs.push(dir);
    const path = join(dir, 'content.json'); await writeFile(path, JSON.stringify(tampered));
    const config = parseServerConfig({ DATABASE_URL: 'postgres://test:secret@localhost:1/unreachable', CONTENT_BUNDLE_PATH: path });
    await expect(createRpgServer(config)).rejects.toThrow(/difficulty/);
    expect(() => validateRpgBundle(tampered)).toThrow();
  });
  it('rejects format-2 boot geometry that is validly hashed but has orphan RPG geometry', () => {
    const seed = compiledRpgContent();
    const location = seed.world.locations.find((entry) => entry.id === 'loc:sanctuary.plaza');
    if (!location) throw new Error('test seed must include the sanctuary plaza');
    location.scene = 'scenes/sanctuary/plaza.tmj';
    const body = {
      format: 2 as const, game: seed.game, world: seed.world, collections: seed.collections,
      scenes: { [location.id]: { width: 32, height: 32, background: 'scenes/sanctuary/background.png', exits: {},
        hotspots: { orphan: { x: 1, y: 1, width: 2, height: 2 } }, enemyAnchors: {}, resources: {} } },
    };
    expect(() => validateRpgBundle({ ...body, contentHash: contentHashOf(body) })).toThrow(/hotspots geometry names/);
  });
});
