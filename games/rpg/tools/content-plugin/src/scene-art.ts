/**
 * Scene background art lives in the web asset manifest (`apps/web/public/assets/<region>/manifest.json`), not in the
 * content root. A `.tmj` image layer names it as `asset:<background id>`; this module resolves that key to `nativeSize`
 * so the compiler can check the map size against the art without copying the image.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SceneArtSize { readonly width: number; readonly height: number }

const ASSETS_DIR = fileURLToPath(new URL('../../../apps/web/public/assets/', import.meta.url));

/** Builds a key -> native size index from parsed manifests (`backgrounds[].id` and `nativeSize`). */
export function buildSceneArtIndex(manifests: readonly unknown[]): ReadonlyMap<string, SceneArtSize> {
  const index = new Map<string, SceneArtSize>();
  for (const manifest of manifests) {
    const backgrounds = (manifest as { backgrounds?: unknown } | null)?.backgrounds;
    if (!Array.isArray(backgrounds)) continue;
    for (const entry of backgrounds as unknown[]) {
      const { id, nativeSize } = (entry ?? {}) as { id?: unknown; nativeSize?: unknown };
      if (typeof id !== 'string' || !Array.isArray(nativeSize) || nativeSize.length !== 2) continue;
      const [width, height] = nativeSize as unknown[];
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) <= 0 || (height as number) <= 0) continue;
      index.set(id, { width: width as number, height: height as number });
    }
  }
  return index;
}

let defaultIndex: ReadonlyMap<string, SceneArtSize> | undefined;

/** Loads every `<assetsDir>/<region>/manifest.json` (sorted by folder name). */
export function loadSceneArtIndex(assetsDir: string = ASSETS_DIR): ReadonlyMap<string, SceneArtSize> {
  const manifests: unknown[] = [];
  if (existsSync(assetsDir)) {
    const folders = readdirSync(assetsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const folder of folders) {
      const file = path.join(assetsDir, folder, 'manifest.json');
      if (existsSync(file)) manifests.push(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    }
  }
  return buildSceneArtIndex(manifests);
}

/** The plugin's `resolveSceneImage` hook: key (a manifest background id) to native size. */
export function resolveRpgSceneImage(key: string): SceneArtSize | undefined {
  defaultIndex ??= loadSceneArtIndex();
  return defaultIndex.get(key);
}
