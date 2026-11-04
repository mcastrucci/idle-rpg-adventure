/** Pure layout and hit-testing helpers, shared by the renderer and its tests. */
import type { SceneRegion } from './types.ts';

export interface Size { readonly width: number; readonly height: number }

export interface CoverFit {
  readonly scale: number;
  /** Offset of the scene origin inside the viewport, in CSS pixels (<= 0 on the cropped axis). */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Smallest touch target radius in CSS pixels (44 px diameter). */
export const MIN_TAP_RADIUS = 22;

/** Scales a scene so it covers the viewport and centres it. */
export function coverFit(scene: Size, viewport: Size): CoverFit {
  if (scene.width <= 0 || scene.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.max(viewport.width / scene.width, viewport.height / scene.height);
  return { scale, offsetX: (viewport.width - scene.width * scale) / 2, offsetY: (viewport.height - scene.height * scale) / 2 };
}

/** Canvas resolution: device pixel ratio capped at `max` (ADR-0010 texture budget), at least 1. */
export function clampResolution(devicePixelRatio: number, max: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 1 ? Math.min(devicePixelRatio, max) : 1;
}

/**
 * Region under a point given in CSS pixels relative to the viewport. The nearest centre wins when targets overlap,
 * and a region is never smaller than the minimum touch target.
 */
export function hitRegion(regions: readonly SceneRegion[], fit: CoverFit, x: number, y: number): SceneRegion | null {
  let best: SceneRegion | null = null;
  let bestDistance = Infinity;
  for (const region of regions) {
    if (!region.enabled) continue;
    const dx = x - (fit.offsetX + region.x * fit.scale);
    const dy = y - (fit.offsetY + region.y * fit.scale);
    const distance = Math.hypot(dx, dy);
    if (distance <= Math.max(region.radius * fit.scale, MIN_TAP_RADIUS) && distance < bestDistance) { best = region; bestDistance = distance; }
  }
  return best;
}
