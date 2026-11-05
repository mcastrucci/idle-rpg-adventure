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

/**
 * How a scene is framed when the viewport crops it. All values are fractions of the scene size.
 * - `focalX` / `focalY`: the scene point kept at the centre of the viewport on a cropped axis (default 0.5).
 * - `quietTop` / `quietBottom`: bands at the top and bottom that hold nothing important. When the visible window
 *   fits between them, the window is kept out of them, whatever the focal point says.
 */
export interface SceneFraming {
  readonly focalX?: number;
  readonly focalY?: number;
  readonly quietTop?: number;
  readonly quietBottom?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const fraction = (value: number | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback);

/** Offset of the scene along one axis. An axis that is not cropped is centred. */
function axisOffset(viewport: number, scaled: number, focal: number, quietStart: number, quietEnd: number): number {
  if (scaled <= viewport) return (viewport - scaled) / 2;
  const window = viewport / scaled; // visible share of the scene
  let centre = clamp(focal, window / 2, 1 - window / 2);
  const low = quietStart;
  const high = 1 - quietEnd;
  if (window <= high - low) centre = clamp(centre, low + window / 2, high - window / 2);
  return viewport / 2 - centre * scaled;
}

/** Scales a scene so it covers the viewport, centred or around the framing's focal point. */
export function coverFit(scene: Size, viewport: Size, framing: SceneFraming = {}): CoverFit {
  if (scene.width <= 0 || scene.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.max(viewport.width / scene.width, viewport.height / scene.height);
  const offsetX = axisOffset(viewport.width, scene.width * scale, fraction(framing.focalX, 0.5), 0, 0);
  const offsetY = axisOffset(viewport.height, scene.height * scale, fraction(framing.focalY, 0.5), fraction(framing.quietTop, 0), fraction(framing.quietBottom, 0));
  return { scale, offsetX: offsetX + 0, offsetY: offsetY + 0 }; // `+ 0` turns -0 into 0
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
