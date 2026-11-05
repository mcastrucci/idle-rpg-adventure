/**
 * Maps the server's scene geometry (#154) to renderer regions. Pure and game-light: the server decides which regions
 * exist (it never sends undiscovered secrets); the caller decides which are enabled, with the very rule its DOM
 * button uses. A tap only names the region; the caller sends the same command as the matching button.
 */
import type { SceneRegion } from '@engine/client-kit';
import type { LiveSceneDto } from '@rpg/protocol';

export type SceneRegionKind = 'exit' | 'hotspot';

/** Renderer region IDs are `<kind>:<id>` so an exit and a hotspot may share an ID. */
export const sceneRegionId = (kind: SceneRegionKind, id: string): string => `${kind}:${id}`;

export function parseSceneRegionId(regionId: string): { kind: SceneRegionKind; id: string } | null {
  const split = regionId.indexOf(':');
  const kind = regionId.slice(0, split);
  return split > 0 && (kind === 'exit' || kind === 'hotspot') ? { kind, id: regionId.slice(split + 1) } : null;
}

/**
 * Scales the authored (Tiled) pixel space onto the background image, which defines the renderer's scene space. Each
 * axis is scaled by its own ratio (identity when the Tiled map and the art have the same size); the radius follows the
 * smaller ratio so a tap target never grows past its authored area. The renderer enforces the 44 px minimum target.
 */
export function sceneRegions(scene: LiveSceneDto | undefined, art: { readonly width: number; readonly height: number },
  enabled: (kind: SceneRegionKind, id: string) => boolean | undefined): SceneRegion[] {
  if (!scene) return [];
  const sx = art.width / scene.width;
  const sy = art.height / scene.height;
  return scene.regions.flatMap((region) => {
    const state = enabled(region.kind, region.id);
    if (state === undefined) return []; // geometry without a matching DOM control is not interactive
    return [{ id: sceneRegionId(region.kind, region.id), x: region.x * sx, y: region.y * sy, radius: region.r * Math.min(sx, sy), enabled: state }];
  });
}
