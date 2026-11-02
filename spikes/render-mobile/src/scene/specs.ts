/** The two test scenes (forest ↔ cave), built from the generated asset manifest. */
import { type AssetManifest, type ImageFormat, assetFor } from './manifest.ts';
import type { HotspotSpec, SceneSpec, SpriteSpec, TextureRef } from './types.ts';

export type SceneId = 'forest' | 'cave';

const W = 1536;
const H = 2048;

interface Placement {
  kind: string;
  x: number;
  y: number;
  side: SpriteSpec['side'];
  flying: boolean;
  tint: number;
}

const BASE_SPRITES: readonly Placement[] = [
  { kind: 'knight', x: 0.34, y: 0.93, side: 'party', flying: false, tint: 0x9fd0ff },
  { kind: 'mage', x: 0.5, y: 0.95, side: 'party', flying: false, tint: 0xd9a6ff },
  { kind: 'ranger', x: 0.66, y: 0.93, side: 'party', flying: false, tint: 0xb6f29a },
  { kind: 'slime', x: 0.36, y: 0.81, side: 'foes', flying: false, tint: 0x7ff3d5 },
  { kind: 'imp', x: 0.64, y: 0.81, side: 'foes', flying: false, tint: 0xff8a5c },
  { kind: 'bat', x: 0.5, y: 0.74, side: 'foes', flying: true, tint: 0xff6a8a },
];

const HOTSPOTS: Record<SceneId, readonly HotspotSpec[]> = {
  forest: [
    { id: 'path-north', label: 'Sendero (salida)', x: 0.5 * W, y: 0.63 * H, radius: 80, exit: true },
    { id: 'old-shrine', label: 'Santuario', x: 0.24 * W, y: 0.7 * H, radius: 70, exit: false },
  ],
  cave: [
    { id: 'cave-mouth', label: 'Boca de la cueva (salida)', x: 0.5 * W, y: 0.55 * H, radius: 80, exit: true },
    { id: 'crystal', label: 'Cristal', x: 0.75 * W, y: 0.7 * H, radius: 70, exit: false },
  ],
};

function ref(manifest: AssetManifest, key: string, format: ImageFormat): TextureRef {
  const a = assetFor(manifest, key, format);
  // Texture keys include the format so switching variants never reuses a cached texture.
  return { key: `${key}.${format}`, url: `./${a.path}`, width: a.width, height: a.height, bytes: a.bytes };
}

export function buildScene(id: SceneId, manifest: AssetManifest, format: ImageFormat, stress: boolean): SceneSpec {
  const background = ref(manifest, `bg-${id}`, format);
  const particle = ref(manifest, 'particle', format);
  const hotspot = ref(manifest, 'hotspot', format);
  const spriteTextures = new Map<string, TextureRef>();
  const sprites: SpriteSpec[] = [];
  const copies = stress ? 2 : 1;
  for (let c = 0; c < copies; c++) {
    for (const p of BASE_SPRITES) {
      const tex = spriteTextures.get(p.kind) ?? ref(manifest, `sprite-${p.kind}`, format);
      spriteTextures.set(p.kind, tex);
      const dx = c === 0 ? 0 : p.x < 0.5 ? -0.13 : 0.13;
      sprites.push({
        id: c === 0 ? p.kind : `${p.kind}-${c + 1}`,
        textureKey: tex.key,
        x: (p.x + dx) * W,
        y: (p.y - c * 0.035) * H,
        scale: c === 0 ? 1.35 : 1.1,
        side: p.side,
        flying: p.flying,
        tint: p.tint,
      });
    }
  }
  return {
    id,
    background,
    textures: [background, ...spriteTextures.values(), particle, hotspot],
    sprites,
    hotspots: HOTSPOTS[id],
    particleKey: particle.key,
    hotspotKey: hotspot.key,
    particlesPerBurst: stress ? 48 : 24,
    attackIntervalMs: stress ? 450 : 900,
  };
}

export function otherScene(id: SceneId): SceneId {
  return id === 'forest' ? 'cave' : 'forest';
}
