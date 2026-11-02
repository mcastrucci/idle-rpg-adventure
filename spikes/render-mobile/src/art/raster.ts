/**
 * Tiny software rasteriser used at build time to paint "illustrated-looking" placeholder art (no external assets).
 * Pure TypeScript, deterministic for a given seed, no DOM and no Node APIs, so it is also unit-testable.
 */

export type Rgb = readonly [number, number, number];

export class Raster {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, opaque = true) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    if (opaque) for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
  }

  /** Alpha-blends `color` over the pixel with coverage `a` (0..1). Keeps/extends destination alpha. */
  blend(x: number, y: number, color: Rgb, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const k = a > 1 ? 1 : a;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const da = (d[i + 3] ?? 0) / 255;
    const outA = k + da * (1 - k);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c++) {
      const src = color[c] ?? 0;
      const dst = d[i + c] ?? 0;
      d[i + c] = (src * k + dst * da * (1 - k)) / outA;
    }
    d[i + 3] = outA * 255;
  }

  /** Additive light (used for glows). */
  add(x: number, y: number, color: Rgb, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] ?? 0) + (color[c] ?? 0) * a;
  }

  get(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 4;
    return [this.data[i] ?? 0, this.data[i + 1] ?? 0, this.data[i + 2] ?? 0];
  }
}

/** Integer hash → [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise in [0, 1). */
export function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Fractal value noise in [0, 1). */
export function fbm2(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, y * f, seed + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export function fbm1(x: number, seed: number, octaves = 5): number {
  return fbm2(x, 0.5, seed, octaves);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function hex(value: number): Rgb {
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Anti-aliased filled ellipse with optional vertical shading. */
export function fillEllipse(
  r: Raster,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: Rgb,
  alpha = 1,
  shade?: { light: Rgb; dark: Rgb },
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(r.width - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(r.height - 1, Math.ceil(cy + ry + 1));
  const m = Math.min(rx, ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = (Math.sqrt(nx * nx + ny * ny) - 1) * m;
      const cov = clamp01(0.5 - d);
      if (cov <= 0) continue;
      let c = color;
      if (shade) {
        const light = clamp01(0.5 - nx * 0.35 - ny * 0.5);
        c = light > 0.5 ? mix(color, shade.light, (light - 0.5) * 1.6) : mix(shade.dark, color, light * 2);
      }
      r.blend(x, y, c, cov * alpha);
    }
  }
}

/** Radial glow added on top (light). */
export function glow(r: Raster, cx: number, cy: number, radius: number, color: Rgb, strength: number): void {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(r.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(r.height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const t = 1 - (dx * dx + dy * dy);
      if (t > 0) r.add(x, y, color, t * t * strength);
    }
  }
}

/** Filled polygon with 2×2 supersampled coverage. */
export function fillPolygon(r: Raster, pts: readonly (readonly [number, number])[], color: Rgb, alpha = 1): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const inside = (px: number, py: number): boolean => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i];
      const pj = pts[j];
      if (!pi || !pj) continue;
      if (pi[1] > py !== pj[1] > py && px < ((pj[0] - pi[0]) * (py - pi[1])) / (pj[1] - pi[1]) + pi[0]) hit = !hit;
    }
    return hit;
  };
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(r.height - 1, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(r.width - 1, Math.ceil(maxX)); x++) {
      let cov = 0;
      if (inside(x + 0.25, y + 0.25)) cov++;
      if (inside(x + 0.75, y + 0.25)) cov++;
      if (inside(x + 0.25, y + 0.75)) cov++;
      if (inside(x + 0.75, y + 0.75)) cov++;
      if (cov > 0) r.blend(x, y, color, (cov / 4) * alpha);
    }
  }
}
