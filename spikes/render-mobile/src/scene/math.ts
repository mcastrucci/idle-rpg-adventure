/** Small pure helpers shared by the model and both renderers. */

export interface CoverTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Scales content to cover the view (like CSS `object-fit: cover`), centred. */
export function computeCover(viewW: number, viewH: number, contentW: number, contentH: number): CoverTransform {
  const scale = Math.max(viewW / contentW, viewH / contentH);
  return { scale, offsetX: (viewW - contentW * scale) / 2, offsetY: (viewH - contentH * scale) / 2 };
}

/** Seeded PRNG so the demo choreography is identical across renderers and runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeInCubic = (t: number): number => t * t * t;
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
