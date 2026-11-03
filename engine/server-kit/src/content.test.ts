import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileContent, contentHashOf, defineContentPlugin } from '@engine/content-compiler';
import { PredicateRegistry } from '@engine/world';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer, loadContentBundle, parseServerConfig } from './index.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function bundle() {
  const compiled = compileContent([{ file: 'world/areas/base.json', text: JSON.stringify({ id: 'area:base', kind: 'hub' }) }],
    defineContentPlugin({ id: 'test', collections: {}, predicates: new PredicateRegistry() }));
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.bundle;
}
async function file(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'server-content-')); directories.push(dir);
  const path = join(dir, 'bundle.json'); await writeFile(path, JSON.stringify(value)); return path;
}
describe('compiled content boot boundary', () => {
  it('verifies real compiler output and freezes nested content', async () => {
    const content = bundle();
    const loaded = await loadContentBundle(await file(content), 'test');
    expect(loaded.contentHash).toBe(content.contentHash);
    expect(Object.isFrozen(loaded.collections)).toBe(true);
    expect(Object.isFrozen(loaded.world)).toBe(true);
  });
  it('fails boot on tampering before attempting a database connection', async () => {
    const content = bundle();
    const path = await file({ ...content, game: 'test', collections: { invented: [] } });
    const config = parseServerConfig({ DATABASE_URL: 'postgres://secret:credential@localhost:1/unreachable', CONTENT_BUNDLE_PATH: path });
    await expect(createServer({ config, game: 'test' })).rejects.toThrow('hash mismatch');
    await expect(loadContentBundle(await file(content), 'other')).rejects.toThrow('envelope');
    await expect(loadContentBundle(await file({ ...content, format: 2 }), 'test')).rejects.toThrow('envelope');
  });
  it('reads format 2 scenes, validates their shape and verifies the scene-inclusive hash', async () => {
    const seed = bundle();
    const body = {
      format: 2, game: seed.game,
      world: { ...seed.world, locations: [{ id: 'loc:scene.test', tags: [], exits: [], scene: 'scenes/test.tmj' }] },
      collections: seed.collections,
      scenes: { 'loc:scene.test': { width: 32, height: 32, background: 'scenes/test/background.png', exits: {}, hotspots: {}, enemyAnchors: {}, resources: {} } },
    };
    const content = { ...body, contentHash: contentHashOf(body) };
    const loaded = await loadContentBundle(await file(content), 'test');
    expect(loaded.format).toBe(2);
    expect(loaded.scenes).toEqual(body.scenes);
    await expect(loadContentBundle(await file({ ...content, scenes: { ...body.scenes, unknown: {} } }), 'test')).rejects.toThrow('envelope');
    await expect(loadContentBundle(await file({ ...content, scenes: { 'loc:scene.test': { ...body.scenes['loc:scene.test'], extra: true } } }), 'test')).rejects.toThrow('envelope');
  });
});
