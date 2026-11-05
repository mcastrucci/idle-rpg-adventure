import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import plugin, { buildSceneArtIndex, loadSceneArtIndex, resolveRpgSceneImage } from './index.ts';

const REAL_CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url));
const OLD_WELL = 'loc:region_1.old_well';
const OLD_WELL_MAP = 'scenes/region_1/old_well.tmj';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function compileWithMapEdit(edit: (text: string) => string): ReturnType<typeof compileContentDirectory> {
  const parent = mkdtempSync(path.join(tmpdir(), 'scene-art-'));
  roots.push(parent);
  const root = path.join(parent, 'content');
  cpSync(REAL_CONTENT, root, { recursive: true });
  const file = path.join(root, OLD_WELL_MAP);
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
  return compileContentDirectory(root, plugin);
}

describe('scene art manifest resolution', () => {
  it('indexes backgrounds by id with their native size and skips malformed entries', () => {
    const index = buildSceneArtIndex([
      { backgrounds: [{ id: 'a', nativeSize: [10, 20] }, { id: 'bad', nativeSize: [0, 5] }, { nativeSize: [1, 1] }, { id: 'c', nativeSize: [1] }] },
      { sprites: [] },
      null,
    ]);
    expect([...index]).toEqual([['a', { width: 10, height: 20 }]]);
  });

  it('loads the real web manifest and resolves Region 1 locations', () => {
    expect(resolveRpgSceneImage(OLD_WELL)).toEqual({ width: 1086, height: 1448 });
    expect(resolveRpgSceneImage('loc:region_1.nope')).toBeUndefined();
    expect(loadSceneArtIndex().size).toBeGreaterThanOrEqual(10);
    expect(loadSceneArtIndex(path.join(tmpdir(), 'no-such-assets-dir')).size).toBe(0);
  });

  it('compiles the real content with asset-key backgrounds and no image files', () => {
    const result = compileWithMapEdit((text) => text);
    expect(result.errors).toEqual([]);
    if (result.ok) expect(result.bundle.scenes?.[OLD_WELL]?.background).toBe(`asset:${OLD_WELL}`);
  });

  it('fails with a clear diagnostic when the key is missing from the manifest', () => {
    const result = compileWithMapEdit((text) => text.replace(`asset:${OLD_WELL}`, 'asset:loc:region_1.not_in_manifest'));
    expect(result.errors.map((e) => e.code)).toEqual(['scene.assetMissing']);
    expect(result.errors[0]?.file).toBe(OLD_WELL_MAP);
    expect(result.errors[0]?.message).toContain('not_in_manifest');
  });

  it('fails when the map size differs from the manifest nativeSize', () => {
    const result = compileWithMapEdit((text) => text.replace('"width": 1086,\n  "height": 1448,', '"width": 1085,\n  "height": 1448,').replace('"imagewidth": 1086', '"imagewidth": 1085'));
    expect(result.errors.map((e) => e.code)).toContain('scene.backgroundSize');
  });
});
