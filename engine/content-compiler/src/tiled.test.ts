import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { importTiledMap, type SceneImageResolver } from './tiled.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tiled-import-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scenes'), { recursive: true });
  return root;
}

function map(image: string, size: { width: number; height: number } = { width: 8, height: 6 }): string {
  return JSON.stringify({
    type: 'map', orientation: 'orthogonal', infinite: false, width: size.width, height: size.height, tilewidth: 1, tileheight: 1, tilesets: [],
    layers: [
      { id: 1, name: 'background', type: 'imagelayer', image, x: 0, y: 0, offsetx: 0, offsety: 0, opacity: 1, visible: true },
      { id: 2, name: 'exits', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true,
        objects: [{ id: 1, name: 'exit:a', x: 1, y: 1, width: 2, height: 2, rotation: 0, opacity: 1, visible: true }] },
    ],
  });
}

const FILE = 'scenes/a.tmj';
const resolver: SceneImageResolver = (key) => (key === 'art.a' ? { width: 8, height: 6 } : undefined);

describe('importTiledMap scene images', () => {
  it('resolves an asset key through the game hook without any file in the content root', () => {
    const result = importTiledMap(FILE, map('asset:art.a'), tempRoot(), resolver);
    expect(result.error).toBeUndefined();
    expect(result.geometry).toMatchObject({ width: 8, height: 6, background: 'asset:art.a', exits: { 'exit:a': { x: 1, y: 1, width: 2, height: 2 } } });
  });

  it('fails when the declared art size differs from the map size', () => {
    const result = importTiledMap(FILE, map('asset:art.a', { width: 9, height: 6 }), tempRoot(), resolver);
    expect(result.error?.code).toBe('scene.backgroundSize');
    expect(result.error?.message).toContain('8x6');
    expect(result.error?.message).toContain('9x6');
  });

  it('fails when the key is unknown to the game', () => {
    const result = importTiledMap(FILE, map('asset:art.missing'), tempRoot(), resolver);
    expect(result.error?.code).toBe('scene.assetMissing');
    expect(result.error?.message).toContain('art.missing');
  });

  it('fails when the game provides no resolver', () => {
    expect(importTiledMap(FILE, map('asset:art.a'), tempRoot()).error?.code).toBe('scene.assetUnsupported');
  });

  it('rejects malformed asset keys', () => {
    expect(importTiledMap(FILE, map('asset:../x'), tempRoot(), () => ({ width: 8, height: 6 })).error?.code).toBe('scene.imagePathRejected');
  });

  it('still accepts an image file inside the content root', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'scenes/a.png'), 'x');
    const result = importTiledMap(FILE, map('a.png'), root, resolver);
    expect(result.geometry?.background).toBe('scenes/a.png');
  });

  it('still rejects a referenced file that resolves outside the content root', () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(path.join(outside, 'out.png'), 'x');
    symlinkSync(path.join(outside, 'out.png'), path.join(root, 'scenes/a.png'));
    expect(importTiledMap(FILE, map('a.png'), root, resolver).error?.code).toBe('scene.imagePathRejected');
    expect(importTiledMap(FILE, map('../../out.png'), root, resolver).error?.code).toBe('scene.imagePathRejected');
  });
});
