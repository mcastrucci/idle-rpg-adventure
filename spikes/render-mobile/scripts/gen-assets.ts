/**
 * Build-time generator for the spike's placeholder art. Writes PNG and WebP variants plus a manifest into
 * `public/generated/` (git-ignored), which Vite copies verbatim into `dist/generated/`.
 *
 * Deterministic: the same generator version produces the same pixels. Skips work when the manifest is current.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRITE_KINDS, paintBackground, paintHotspot, paintParticle, paintSprite } from '../src/art/paint.ts';
import type { Raster } from '../src/art/raster.ts';
import type { AssetEntry, AssetManifest, ImageFormat } from '../src/scene/manifest.ts';
import { encodePng } from './png.ts';

const GENERATOR_VERSION = 2;
const WEBP_QUALITY = 80;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'generated');
const manifestPath = join(outDir, 'manifest.json');

interface WebpModule {
  encode(data: Uint8ClampedArray, width: number, height: number, options: object): Uint8Array | null;
}

async function loadWebpEncoder(): Promise<WebpModule> {
  const require = createRequire(import.meta.url);
  // Always use the non-SIMD codec + wasm pair so the factory and the binary match regardless of host features.
  const wasmPath = require.resolve('@jsquash/webp/codec/enc/webp_enc.wasm');
  const wasm = await WebAssembly.compile(readFileSync(wasmPath));
  const { initEmscriptenModule } = (await import('@jsquash/webp/utils.js')) as {
    initEmscriptenModule: (factory: unknown, module: WebAssembly.Module) => Promise<WebpModule>;
  };
  const { defaultOptions } = await import('@jsquash/webp/meta.js');
  const factory = ((await import('@jsquash/webp/codec/enc/webp_enc.js')) as { default: unknown }).default;
  const module = await initEmscriptenModule(factory, wasm);
  return {
    encode: (data, width, height, options) => module.encode(data, width, height, { ...defaultOptions, ...options }),
  };
}

function isCurrent(): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as AssetManifest;
    return m.generatorVersion === GENERATOR_VERSION && m.webpQuality === WEBP_QUALITY;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (isCurrent() && !process.argv.includes('--force')) {
    console.log('[gen-assets] up to date:', manifestPath);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const webp = await loadWebpEncoder();
  const assets: Record<string, Record<ImageFormat, AssetEntry>> = {};

  const emit = (key: string, raster: Raster): void => {
    const started = Date.now();
    const png = encodePng(raster.data, raster.width, raster.height);
    const webpBytes = webp.encode(raster.data, raster.width, raster.height, { quality: WEBP_QUALITY });
    if (!webpBytes) throw new Error(`WebP encoding failed for ${key}`);
    writeFileSync(join(outDir, `${key}.png`), png);
    writeFileSync(join(outDir, `${key}.webp`), webpBytes);
    const base = { width: raster.width, height: raster.height };
    assets[key] = {
      png: { ...base, path: `generated/${key}.png`, bytes: png.length },
      webp: { ...base, path: `generated/${key}.webp`, bytes: webpBytes.length },
    };
    console.log(
      `[gen-assets] ${key} ${raster.width}x${raster.height} png=${(png.length / 1024).toFixed(0)}KiB ` +
        `webp=${(webpBytes.length / 1024).toFixed(0)}KiB (${Date.now() - started} ms encode)`,
    );
  };

  for (const theme of ['forest', 'cave'] as const) {
    const started = Date.now();
    const raster = paintBackground(theme);
    console.log(`[gen-assets] painted bg-${theme} in ${Date.now() - started} ms`);
    emit(`bg-${theme}`, raster);
  }
  for (const kind of SPRITE_KINDS) emit(`sprite-${kind}`, paintSprite(kind));
  emit('particle', paintParticle());
  emit('hotspot', paintHotspot());

  const manifest: AssetManifest = { generatorVersion: GENERATOR_VERSION, webpQuality: WEBP_QUALITY, assets };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[gen-assets] wrote', manifestPath);
}

await main();
