import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { coverFit } from '@engine/client-kit';

import { SCENE_HEIGHT, SCENE_WIDTH, sceneForLocation } from './placeholderScene.ts';
import { ART_INDEX, artImage, buildArtIndex, decodeImage } from './regionArt.ts';
import type { ArtManifest } from './regionArt.ts';

const WEB_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(WEB_ROOT, '../../../..');
const REGION_DIR = resolve(WEB_ROOT, 'public/assets/region-1');
const manifest = JSON.parse(readFileSync(resolve(REGION_DIR, 'manifest.json'), 'utf8')) as ArtManifest & {
  roots: { source: string };
  backgrounds: { id: string; source: string; webp: string; webpBytes: number; nativeSize: [number, number] }[];
  sprites: { id: string; source: string; image: string; atlas: string }[];
};

/** Pixel size from the header of a lossy (VP8 ), lossless (VP8L) or extended (VP8X) WebP. */
function webpSize(file: Buffer): [number, number] {
  expect(file.toString('ascii', 0, 4)).toBe('RIFF');
  expect(file.toString('ascii', 8, 12)).toBe('WEBP');
  const kind = file.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return [file.readUInt16LE(26) & 0x3fff, file.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const bits = file.readUInt32LE(21); return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]; }
  return [file.readUIntLE(24, 3) + 1, file.readUIntLE(27, 3) + 1];
}

describe('region art index', () => {
  it('maps every manifest background to its WebP, with the manifest dimensions', () => {
    expect(manifest.backgrounds.length).toBeGreaterThan(0);
    for (const background of manifest.backgrounds) {
      const art = ART_INDEX.get(background.id);
      expect(art, background.id).toBeDefined();
      expect(art?.url).toBe(`${import.meta.env.BASE_URL}assets/region-1/${background.webp}`);
      expect([art?.width, art?.height]).toEqual(background.nativeSize);
    }
  });

  it('describes a Region 1 location as a WebP scene background, framed for the viewport band', () => {
    const spec = sceneForLocation('loc:region_1.portal_clearing');
    expect(spec.id).toBe('loc:region_1.portal_clearing');
    expect(spec.background).toMatchObject({ width: 1086, height: 1448 });
    expect(spec.background.key).toMatch(/assets\/region-1\/backgrounds\/webp\/portal-clearing\.webp$/);
    expect(spec.layers).toEqual([]);
    expect(spec.framing).toEqual({ focalY: 0.5, quietTop: 0.12, quietBottom: 0.18 });
  });

  it('falls back to the deterministic placeholder for a location without art', () => {
    const spec = sceneForLocation('loc:test_grove.glade');
    expect(spec.background).toMatchObject({ width: SCENE_WIDTH, height: SCENE_HEIGHT });
    expect(spec.layers.map((layer) => layer.id)).toEqual(['foreground']);
    expect(spec.framing).toBeUndefined();
  });

  it('does nothing until load() runs, then decodes the art URL', async () => {
    const decode = vi.fn(() => Promise.resolve({} as ImageBitmap));
    const spec = sceneForLocation('loc:region_1.old_well', ART_INDEX, decode);
    expect(decode).not.toHaveBeenCalled();
    await spec.background.load();
    expect(decode).toHaveBeenCalledExactlyOnceWith(ART_INDEX.get('loc:region_1.old_well')?.url);
  });

  it('decodes with fetch and createImageBitmap, and rejects on an HTTP error', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap)));
    const ok = vi.fn(() => Promise.resolve(new Response(new Blob(['x']), { status: 200 })));
    await expect(decodeImage('/a.webp', ok as unknown as typeof fetch)).resolves.toBe(bitmap);
    const missing = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(decodeImage('/a.webp', missing as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
    vi.unstubAllGlobals();
  });

  it('takes the per-background focal point, then the manifest default, then the centre', () => {
    const index = buildArtIndex([{
      baseUrl: '/x/',
      manifest: {
        layout: { defaultFocalY: 0.45 },
        backgrounds: [
          { id: 'a', nativeSize: [30, 40], webp: 'a.webp', focalY: 0.3 },
          { id: 'b', nativeSize: [30, 40], webp: 'b.webp' },
        ],
      },
    }, { baseUrl: '/y/', manifest: { backgrounds: [{ id: 'c', nativeSize: [30, 40], webp: 'c.webp' }] } }]);
    expect(index.get('a')?.framing).toEqual({ focalY: 0.3 });
    expect(index.get('b')?.framing.focalY).toBe(0.45);
    expect(index.get('c')?.framing.focalY).toBe(0.5);
    expect(index.get('a')?.url).toBe('/x/a.webp');
    const c = index.get('c');
    expect(c && artImage(c).key).toBe('/y/c.webp');
  });

  it('shows the middle of the art in the 4:3 band at 360 px, away from the quiet zones', () => {
    const art = ART_INDEX.get('loc:region_1.vault_antechamber');
    if (!art) throw new Error('vault_antechamber has no art');
    const fit = coverFit({ width: art.width, height: art.height }, { width: 360, height: 270 }, art.framing);
    expect(fit.scale).toBeCloseTo(360 / 1086);
    const top = -fit.offsetY / (art.height * fit.scale);
    const bottom = (-fit.offsetY + 270) / (art.height * fit.scale);
    expect(top).toBeGreaterThanOrEqual(0.12 - 1e-9);
    expect(bottom).toBeLessThanOrEqual(0.82 + 1e-9);
  });
});

describe('region 1 art on disk', () => {
  it('has a WebP per background at the declared size and within the 600 KB budget', () => {
    for (const background of manifest.backgrounds) {
      const path = resolve(REGION_DIR, background.webp);
      expect(existsSync(path), background.webp).toBe(true);
      expect(webpSize(readFileSync(path)), background.id).toEqual(background.nativeSize);
      expect(statSync(path).size, background.id).toBe(background.webpBytes);
      expect(statSync(path).size, background.id).toBeLessThanOrEqual(600 * 1024);
    }
  });

  it('keeps every native source the manifest lists outside public/, and runtime sprites inside it', () => {
    const sourceRoot = resolve(REPO_ROOT, manifest.roots.source);
    expect(sourceRoot.startsWith(resolve(WEB_ROOT, 'public'))).toBe(false);
    for (const entry of [...manifest.backgrounds, ...manifest.sprites]) {
      expect(existsSync(resolve(sourceRoot, entry.source)), entry.source).toBe(true);
      expect(existsSync(resolve(REGION_DIR, entry.source)), `${entry.source} must not be in public/`).toBe(false);
    }
    for (const sprite of manifest.sprites) {
      expect(existsSync(resolve(REGION_DIR, sprite.image)), sprite.image).toBe(true);
      expect(existsSync(resolve(REGION_DIR, sprite.atlas)), sprite.atlas).toBe(true);
    }
  });

  it('references the mockup raster at its design-docs location', () => {
    const mockup = (JSON.parse(readFileSync(resolve(REGION_DIR, 'manifest.json'), 'utf8')) as { mockup: { raster: string } }).mockup;
    expect(existsSync(resolve(REPO_ROOT, mockup.raster))).toBe(true);
  });

  it('declares one background per Region 1 location in content', () => {
    const ids = manifest.backgrounds.map((background) => background.id).sort();
    const locationDir = resolve(REPO_ROOT, 'games/rpg/content/world/locations/region_1');
    const locations = ['glowcap_grotto', 'irrigation_terraces', 'lantern_ruins', 'old_well', 'overgrown_causeway', 'portal_clearing', 'pump_station', 'seed_vault_heart', 'sunken_greenhouse', 'tangle_orchard', 'vault_antechamber'];
    for (const name of locations) {
      expect(existsSync(resolve(locationDir, `${name}.json`)), name).toBe(true);
      expect(JSON.parse(readFileSync(resolve(locationDir, `${name}.json`), 'utf8')).id).toBe(`loc:region_1.${name}`);
    }
    expect(ids).toEqual(locations.map((name) => `loc:region_1.${name}`).sort());
  });
});
