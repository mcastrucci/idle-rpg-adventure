/** Shape of `generated/manifest.json`, written by `scripts/gen-assets.ts` and read at runtime. */

export type ImageFormat = 'png' | 'webp';

export interface AssetEntry {
  /** Path relative to the page (e.g. `generated/bg-forest.webp`). */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  /** Encoded file size in bytes. */
  readonly bytes: number;
}

export interface AssetManifest {
  readonly generatorVersion: number;
  readonly webpQuality: number;
  /** key → format → entry. Keys: `bg-forest`, `bg-cave`, `sprite-<kind>`, `particle`, `hotspot`. */
  readonly assets: Readonly<Record<string, Readonly<Record<ImageFormat, AssetEntry>>>>;
}

export async function loadManifest(): Promise<AssetManifest> {
  const res = await fetch('./generated/manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status} (run \`pnpm --filter @spikes/render-mobile assets\`)`);
  return (await res.json()) as AssetManifest;
}

export function assetFor(manifest: AssetManifest, key: string, format: ImageFormat): AssetEntry {
  const entry = manifest.assets[key]?.[format];
  if (!entry) throw new Error(`asset ${key} (${format}) missing from manifest`);
  return entry;
}
