import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REGION_1_BACKGROUNDS, regionBackgroundUrl, sceneForRegionLocation } from './regionScenes.ts';

const publicDir = `${resolve(dirname(fileURLToPath(import.meta.url)), '../../public/assets/region-1')}/`;
const manifest = JSON.parse(readFileSync(`${publicDir}manifest.json`, 'utf8')) as {
  backgrounds: { id: string; nativeSize: [number, number]; webp: string }[];
};

afterEach(() => vi.unstubAllGlobals());

describe('Region 1 scene backgrounds', () => {
  it('maps every manifest location to an existing WebP with native dimensions', () => {
    expect(Object.keys(REGION_1_BACKGROUNDS).sort()).toEqual(manifest.backgrounds.map(({ id }) => id).sort());
    for (const entry of manifest.backgrounds) {
      const scene = sceneForRegionLocation(entry.id);
      expect(scene.id).toBe(entry.id);
      expect(scene.background).toMatchObject({ width: entry.nativeSize[0], height: entry.nativeSize[1], key: `${entry.id}:bg` });
      expect(readFileSync(`${publicDir}${entry.webp}`).byteLength).toBeGreaterThan(0);
      expect(REGION_1_BACKGROUNDS[entry.id as keyof typeof REGION_1_BACKGROUNDS]).toBe(entry.webp.split('/').at(-1)?.replace('.webp', ''));
    }
  });

  it('has no authored layers or geometry and falls back for unknown IDs', () => {
    const region = sceneForRegionLocation('loc:region_1.portal_clearing');
    expect(region.layers).toEqual([]);
    expect(region.regions).toEqual([]);
    expect(sceneForRegionLocation('unknown:place').id).toBe('unknown:place');
    expect(sceneForRegionLocation('unknown:place').background.width).toBe(768);
    expect(sceneForRegionLocation('toString').id).toBe('toString');
    expect(sceneForRegionLocation('toString').background.width).toBe(768);
  });

  it('resolves asset URLs against the configured Vite base path', () => {
    expect(regionBackgroundUrl('old-well', '/game/')).toBe('/game/assets/region-1/backgrounds/webp/old-well.webp');
  });

  it('waits for image decode and rejects load or decode failures', async () => {
    let finishDecode!: () => void;
    const decode = vi.fn(() => new Promise<void>((resolveDecode) => { finishDecode = resolveDecode; }));
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decode(): Promise<void> { return decode(); }
      set src(value: string) {
        expect(value).toContain('/assets/region-1/backgrounds/webp/old-well.webp');
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
    let loaded = false;
    const loading = sceneForRegionLocation('loc:region_1.old_well').background.load().then((image) => { loaded = true; return image; });
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toBe(false);
    finishDecode();
    await expect(loading).resolves.toBeInstanceOf(FakeImage);
    expect(decode).toHaveBeenCalledOnce();

    class FailedImage extends FakeImage {
      override set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', FailedImage);
    await expect(sceneForRegionLocation('loc:region_1.old_well').background.load()).rejects.toThrow('Failed to load scene background');

    class DecodeFailedImage extends FakeImage {
      override decode(): Promise<void> { return Promise.reject(new Error('decode failed')); }
    }
    vi.stubGlobal('Image', DecodeFailedImage);
    await expect(sceneForRegionLocation('loc:region_1.old_well').background.load()).rejects.toThrow('decode failed');
  });
});
