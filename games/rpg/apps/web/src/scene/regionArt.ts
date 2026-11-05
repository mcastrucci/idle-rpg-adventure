/**
 * Scene art index, built from the art manifests under `public/assets/<region>/manifest.json` (#160). A location
 * has art when a manifest background carries its content ID; nothing here names a location. A region that ships a
 * manifest is picked up without code changes.
 *
 * Only runtime files are referenced (`webp`). Native source PNGs live in `games/rpg/art/` and never reach the build.
 */
import type { SceneFraming, SceneImage, SceneImageData } from '@engine/client-kit';

/** The part of a region manifest this module reads. */
export interface ArtManifest {
  readonly layout?: {
    readonly quietZones?: { readonly top?: number; readonly bottom?: number };
    readonly defaultFocalY?: number;
  };
  readonly backgrounds: readonly {
    readonly id: string;
    readonly nativeSize: readonly [number, number];
    readonly webp: string;
    /** Fraction (0..1) of the art height kept at the vertical centre of the viewport. */
    readonly focalY?: number;
  }[];
}

export interface BackgroundArt {
  readonly locationId: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly framing: SceneFraming;
}

export type ArtIndex = ReadonlyMap<string, BackgroundArt>;

/** One manifest sprite (`hero_max`, `enemy:<content id>`): a 512x512 PNG that costs 1 MiB of RGBA texture memory. */
export interface SpriteArt {
  readonly id: string;
  readonly url: string;
}
export type SpriteIndex = ReadonlyMap<string, SpriteArt>;

/** `baseUrl` is the public URL of the manifest's folder, with a trailing slash. */
export function buildArtIndex(manifests: readonly { readonly baseUrl: string; readonly manifest: ArtManifest }[]): ArtIndex {
  const index = new Map<string, BackgroundArt>();
  for (const { baseUrl, manifest } of manifests) {
    const quiet = manifest.layout?.quietZones;
    for (const background of manifest.backgrounds) {
      const [width, height] = background.nativeSize;
      index.set(background.id, {
        locationId: background.id,
        url: `${baseUrl}${background.webp}`,
        width,
        height,
        framing: {
          focalY: background.focalY ?? manifest.layout?.defaultFocalY ?? 0.5,
          ...(quiet?.top !== undefined ? { quietTop: quiet.top } : {}),
          ...(quiet?.bottom !== undefined ? { quietBottom: quiet.bottom } : {}),
        },
      });
    }
  }
  return index;
}

/** Sprite entries are only indexed by ID and URL: nothing is fetched until a combat scene renders the `<img>`. */
export function buildSpriteIndex(manifests: readonly { readonly baseUrl: string; readonly sprites: readonly { readonly id: string; readonly image: string }[] }[]): SpriteIndex {
  const index = new Map<string, SpriteArt>();
  for (const { baseUrl, sprites } of manifests) for (const sprite of sprites) index.set(sprite.id, { id: sprite.id, url: `${baseUrl}${sprite.image}` });
  return index;
}

// Named imports let the bundler drop the mockup and verification data of the manifests (sprites are kept for combat).
const backgrounds = import.meta.glob<ArtManifest['backgrounds']>('../../public/assets/*/manifest.json', { eager: true, import: 'backgrounds' });
const layouts = import.meta.glob<NonNullable<ArtManifest['layout']>>('../../public/assets/*/manifest.json', { eager: true, import: 'layout' });

/** Vite serves `public/` at `import.meta.env.BASE_URL`, so a manifest's folder is its public URL. */
export const ART_INDEX: ArtIndex = buildArtIndex(Object.entries(backgrounds).map(([path, list]) => {
  const folder = /public\/(assets\/[^/]+)\/manifest\.json$/.exec(path)?.[1] ?? '';
  const layout = layouts[path];
  return { baseUrl: `${import.meta.env.BASE_URL}${folder}/`, manifest: { backgrounds: list, ...(layout ? { layout } : {}) } };
}));

const spriteLists = import.meta.glob<readonly { readonly id: string; readonly image: string }[]>('../../public/assets/*/manifest.json', { eager: true, import: 'sprites' });

export const SPRITE_INDEX: SpriteIndex = buildSpriteIndex(Object.entries(spriteLists).map(([path, sprites]) => {
  const folder = /public\/(assets\/[^/]+)\/manifest\.json$/.exec(path)?.[1] ?? '';
  return { baseUrl: `${import.meta.env.BASE_URL}${folder}/`, sprites };
}));

/** Decodes off the main thread when the browser can; the renderer owns, and releases, the result. */
export async function decodeImage(url: string, fetchImpl: typeof fetch = fetch): Promise<SceneImageData> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`scene art ${url}: HTTP ${response.status}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const element = new Image();
    element.src = objectUrl;
    await element.decode();
    return element;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** The renderer image for a piece of art. Nothing is fetched or decoded until `load()` runs in the preload step. */
export function artImage(art: BackgroundArt, decode: (url: string) => Promise<SceneImageData> = decodeImage): SceneImage {
  return { key: art.url, width: art.width, height: art.height, load: () => decode(art.url) };
}
