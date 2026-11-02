/**
 * Procedural placeholder art for the rendering spike. The goal is not beauty but realistic *texture statistics*:
 * full-bleed 1536×2048 illustrations with gradients, noise and detail (so PNG/WebP sizes and decode costs resemble
 * painted art), plus small RGBA sprites with transparency.
 */
import { type Rgb, Raster, fbm1, fbm2, fillEllipse, fillPolygon, glow, hash2, hex, mix } from './raster.ts';

export const BACKGROUND_WIDTH = 1536;
export const BACKGROUND_HEIGHT = 2048;
export const SPRITE_SIZE = 192;

export type BackgroundTheme = 'forest' | 'cave';
export type SpriteKind = 'knight' | 'mage' | 'ranger' | 'slime' | 'imp' | 'bat';
export const SPRITE_KINDS: readonly SpriteKind[] = ['knight', 'mage', 'ranger', 'slime', 'imp', 'bat'];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function writePixel(r: Raster, x: number, y: number, c: Rgb): void {
  const i = (y * r.width + x) * 4;
  r.data[i] = c[0];
  r.data[i + 1] = c[1];
  r.data[i + 2] = c[2];
  r.data[i + 3] = 255;
}

function vignette(r: Raster, strength: number): void {
  const cx = r.width / 2;
  const cy = r.height / 2;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const k = 1 - strength * clamp01((dx * dx + dy * dy) * 0.5);
      const i = (y * r.width + x) * 4;
      for (let c = 0; c < 3; c++) r.data[i + c] = (r.data[i + c] ?? 0) * k;
    }
  }
}

function pine(r: Raster, x: number, baseY: number, height: number, color: Rgb): void {
  const w = height * 0.32;
  fillPolygon(r, [[x - w * 0.08, baseY], [x + w * 0.08, baseY], [x + w * 0.08, baseY - height * 0.2], [x - w * 0.08, baseY - height * 0.2]], mix(color, hex(0x000000), 0.3));
  for (let t = 0; t < 3; t++) {
    const top = baseY - height + t * height * 0.22;
    const bottom = top + height * 0.45;
    const half = w * (0.55 + t * 0.22);
    fillPolygon(r, [[x, top], [x + half, bottom], [x - half, bottom]], color);
  }
}

export function paintForest(w: number, h: number, seed: number): Raster {
  const r = new Raster(w, h);
  const skyTop = hex(0x1b2550);
  const skyMid = hex(0x7a4a7a);
  const horizon = hex(0xf2a65e);
  const sunColor = hex(0xfff1c8);
  const sunX = w * 0.68;
  const sunY = h * 0.33;
  const ridges = [
    { base: 0.44, amp: 0.16, scale: 1 / 520, color: hex(0x6b5a8e), fog: 0.55 },
    { base: 0.52, amp: 0.12, scale: 1 / 380, color: hex(0x3f3f6b), fog: 0.35 },
    { base: 0.6, amp: 0.09, scale: 1 / 260, color: hex(0x23304a), fog: 0.15 },
  ];
  const ridgeY = ridges.map((rd, k) => {
    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) col[x] = h * (rd.base - rd.amp * fbm1(x * rd.scale + k * 17, seed + k * 101));
    return col;
  });
  const groundLine = new Float32Array(w);
  for (let x = 0; x < w; x++) groundLine[x] = h * 0.7 - 50 * fbm1(x / 300, seed + 9);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / (h * 0.62);
      let c = t < 0.6 ? mix(skyTop, skyMid, t / 0.6) : mix(skyMid, horizon, (t - 0.6) / 0.4);
      const dist = Math.hypot(x - sunX, y - sunY);
      c = mix(c, hex(0xffd9a0), clamp01(1 - dist / 650) ** 2 * 0.75);
      if (dist < 90) c = mix(c, sunColor, clamp01(90.5 - dist));
      if (y < h * 0.5) {
        const n = fbm2(x / 420, y / 110, seed + 7, 4);
        if (n > 0.55) c = mix(c, hex(0xf7c79a), (n - 0.55) * 2.2 * (1 - y / (h * 0.5)) * 0.85);
      }
      for (let k = 0; k < ridges.length; k++) {
        const ry = ridgeY[k]?.[x] ?? h;
        const rd = ridges[k];
        if (!rd || y < ry) continue;
        const rock = fbm2(x / 70, y / 70, seed + 20 + k, 3);
        const base = mix(rd.color, hex(0x000000), (0.5 - rock) * 0.5);
        const rim = 0.2 + 0.3 * clamp01((x - (sunX - 700)) / 600);
        const lit = mix(base, hex(0xffb070), clamp01(0.4 - (y - ry) / 120) * rim);
        c = mix(lit, horizon, rd.fog * clamp01(1 - (y - ry) / (h * 0.3)));
      }
      const gy = groundLine[x] ?? h;
      if (y >= gy) {
        const depth = (y - gy) / (h - gy);
        const grass = fbm2(x / 14, y / 9, seed + 50, 3);
        c = mix(mix(hex(0x47683a), hex(0x16240f), depth), hex(0x7da04a), (grass - 0.45) * 1.4 * (1 - depth * 0.6));
        const pc = w * 0.5 + Math.sin(y / 230) * w * 0.12 * (1 - depth * 0.6);
        const half = 26 + (y - gy) * 0.42;
        const d = Math.abs(x - pc);
        if (d < half + 6) {
          const dirt = mix(hex(0xb08a5a), hex(0x6e5034), fbm2(x / 18, y / 10, seed + 60, 3));
          c = mix(c, mix(dirt, hex(0x2a1d12), depth * 0.7), clamp01((half + 6 - d) / 12));
        }
      }
      writePixel(r, x, y, c);
    }
  }

  // Tree lines (back to front).
  for (let i = 0; i < 90; i++) {
    const x = hash2(i, 1, seed) * w;
    const gy = groundLine[Math.floor(x)] ?? h * 0.7;
    const height = 110 + hash2(i, 2, seed) * 200;
    pine(r, x, gy + 20 + hash2(i, 3, seed) * 30, height, mix(hex(0x1c3326), horizon, 0.18));
  }
  for (let i = 0; i < 6; i++) {
    const left = i % 2 === 0;
    const x = left ? hash2(i, 5, seed) * 260 : w - hash2(i, 5, seed) * 260;
    pine(r, x, h * (0.86 + hash2(i, 6, seed) * 0.12), 520 + hash2(i, 7, seed) * 260, hex(0x0c1710));
  }
  // Fog band.
  for (let y = Math.floor(h * 0.55); y < h * 0.75; y++) {
    const g = Math.exp(-(((y - h * 0.66) / (h * 0.04)) ** 2));
    for (let x = 0; x < w; x++) r.blend(x, y, hex(0xf3c9b0), g * (0.15 + 0.25 * fbm2(x / 260, y / 60, seed + 70, 3)));
  }
  // Fireflies.
  for (let i = 0; i < 70; i++) {
    glow(r, hash2(i, 11, seed) * w, h * (0.72 + hash2(i, 12, seed) * 0.25), 10 + hash2(i, 13, seed) * 14, hex(0xfff2a0), 0.9);
  }
  vignette(r, 0.45);
  return r;
}

export function paintCave(w: number, h: number, seed: number): Raster {
  const r = new Raster(w, h);
  const mouthX = w * 0.5;
  const mouthY = h * 0.42;
  const top = new Float32Array(w);
  const floor = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    top[x] = h * 0.04 + h * 0.32 * fbm1(x / 38, seed + 3) ** 4 * 5;
    floor[x] = h * 0.76 - h * 0.08 * fbm1(x / 200, seed + 4);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rock = fbm2(x / 110, y / 110, seed, 4);
      const crack = Math.abs(fbm2(x / 50, y / 80, seed + 1, 3) - 0.5) < 0.012 ? 0.5 : 0;
      let c = mix(mix(hex(0x0b1a26), hex(0x1d3a46), rock), hex(0x020608), crack);
      const mx = (x - mouthX) / 380;
      const my = (y - mouthY) / 560;
      const md = Math.sqrt(mx * mx + my * my) + (fbm2(x / 90, y / 90, seed + 2, 3) - 0.5) * 0.4;
      if (md < 1) c = mix(c, mix(hex(0x9fe3d8), hex(0x2f6d74), md), clamp01((1 - md) * 3));
      const ty = top[x] ?? 0;
      if (y < ty) c = mix(hex(0x0a1218), hex(0x24414a), fbm2(x / 30, y / 30, seed + 5, 3) * clamp01(1 - (ty - y) / 300));
      const fy = floor[x] ?? h;
      if (y > fy) {
        const depth = (y - fy) / (h - fy);
        c = mix(mix(hex(0x2a4650), hex(0x081014), depth), hex(0x4b6c70), (fbm2(x / 24, y / 16, seed + 6, 3) - 0.5) * 0.8);
      }
      const px = (x - w * 0.5) / 440;
      const py = (y - h * 0.87) / 95;
      const pd = px * px + py * py;
      if (pd < 1) {
        const ripple = 0.5 + 0.5 * Math.sin(y / 3 + fbm2(x / 40, y / 8, seed + 8, 2) * 6);
        c = mix(c, mix(hex(0x1f8a8f), hex(0x9ff6ef), ripple * (1 - pd)), clamp01((1 - pd) * 6));
      }
      writePixel(r, x, y, c);
    }
  }
  // Light shafts from the opening.
  for (let y = 0; y < h * 0.8; y++) {
    for (let x = 0; x < w; x++) {
      const s = (x - mouthX + (y - mouthY) * 0.35) / 60;
      const band = 0.5 + 0.5 * Math.sin(s);
      const fade = clamp01(1 - Math.abs(y - mouthY) / (h * 0.45)) * clamp01(1 - Math.abs(x - mouthX) / (w * 0.45));
      if (band > 0.8) r.add(x, y, hex(0x6fd6c8), (band - 0.8) * fade * 0.35);
    }
  }
  // Crystal clusters.
  const crystalColors = [hex(0x5ff2e6), hex(0xb07cff), hex(0x7cc4ff)];
  for (let i = 0; i < 14; i++) {
    const cx = hash2(i, 21, seed) * w;
    const cy = (floor[Math.floor(cx)] ?? h * 0.76) + 30 + hash2(i, 22, seed) * 60;
    const col = crystalColors[i % crystalColors.length] ?? hex(0xffffff);
    glow(r, cx, cy - 60, 160, col, 0.35);
    for (let k = 0; k < 4; k++) {
      const hgt = 70 + hash2(i, 30 + k, seed) * 150;
      const lean = (hash2(i, 40 + k, seed) - 0.5) * 70;
      const bx = cx + (k - 1.5) * 26;
      const wid = 16 + hash2(i, 50 + k, seed) * 14;
      fillPolygon(r, [[bx - wid, cy], [bx + wid, cy], [bx + lean + wid * 0.4, cy - hgt * 0.85], [bx + lean, cy - hgt], [bx + lean - wid * 0.4, cy - hgt * 0.85]], mix(col, hex(0x102030), 0.25));
      fillPolygon(r, [[bx - wid * 0.2, cy], [bx + wid * 0.6, cy], [bx + lean + wid * 0.3, cy - hgt * 0.8], [bx + lean, cy - hgt]], mix(col, hex(0xffffff), 0.45), 0.6);
    }
  }
  vignette(r, 0.6);
  return r;
}

export function paintBackground(theme: BackgroundTheme, seed = 1): Raster {
  return theme === 'forest'
    ? paintForest(BACKGROUND_WIDTH, BACKGROUND_HEIGHT, seed)
    : paintCave(BACKGROUND_WIDTH, BACKGROUND_HEIGHT, seed + 100);
}

const SPRITE_PALETTES: Record<SpriteKind, { body: number; accent: number; eye: number }> = {
  knight: { body: 0x3d6fd1, accent: 0xc9d3e0, eye: 0x9fe8ff },
  mage: { body: 0x7a3db8, accent: 0xf2c94c, eye: 0xfff3a0 },
  ranger: { body: 0x3f8f4a, accent: 0x8a5a2b, eye: 0xffffff },
  slime: { body: 0x2fbf9f, accent: 0xb6ffe9, eye: 0x102020 },
  imp: { body: 0xc8382f, accent: 0x2a1410, eye: 0xffd23f },
  bat: { body: 0x4b3266, accent: 0x231633, eye: 0xff5a5a },
};

export function paintSprite(kind: SpriteKind): Raster {
  const s = SPRITE_SIZE;
  const r = new Raster(s, s, false);
  const p = SPRITE_PALETTES[kind];
  const body = hex(p.body);
  const accent = hex(p.accent);
  const shade = { light: mix(body, hex(0xffffff), 0.55), dark: mix(body, hex(0x000000), 0.6) };
  fillEllipse(r, s * 0.5, s * 0.9, s * 0.3, s * 0.06, hex(0x000000), 0.35);
  switch (kind) {
    case 'knight':
    case 'mage':
    case 'ranger': {
      fillEllipse(r, s * 0.5, s * 0.66, s * 0.24, s * 0.24, body, 1, shade);
      if (kind === 'mage') fillPolygon(r, [[s * 0.5, s * 0.08], [s * 0.76, s * 0.5], [s * 0.24, s * 0.5]], body);
      if (kind === 'ranger') fillPolygon(r, [[s * 0.5, s * 0.14], [s * 0.72, s * 0.44], [s * 0.28, s * 0.44]], mix(body, hex(0x000000), 0.3));
      fillEllipse(r, s * 0.5, s * 0.38, s * 0.16, s * 0.16, kind === 'knight' ? accent : hex(0xf0c8a0), 1, {
        light: hex(0xffffff),
        dark: mix(kind === 'knight' ? accent : hex(0xf0c8a0), hex(0x000000), 0.5),
      });
      if (kind === 'knight') fillPolygon(r, [[s * 0.38, s * 0.36], [s * 0.62, s * 0.36], [s * 0.62, s * 0.4], [s * 0.38, s * 0.4]], hex(0x1a1f2a));
      else {
        fillEllipse(r, s * 0.44, s * 0.38, s * 0.02, s * 0.025, hex(0x1a1a1a));
        fillEllipse(r, s * 0.56, s * 0.38, s * 0.02, s * 0.025, hex(0x1a1a1a));
      }
      const weapon = kind === 'ranger' ? accent : hex(0xdfe6ee);
      fillPolygon(r, [[s * 0.8, s * 0.2], [s * 0.84, s * 0.2], [s * 0.83, s * 0.78], [s * 0.81, s * 0.78]], weapon);
      if (kind === 'mage') glow(r, s * 0.82, s * 0.2, s * 0.1, hex(p.eye), 0.9);
      break;
    }
    case 'slime': {
      fillEllipse(r, s * 0.5, s * 0.66, s * 0.36, s * 0.26, body, 0.92, shade);
      fillEllipse(r, s * 0.38, s * 0.54, s * 0.07, s * 0.04, accent, 0.8);
      fillEllipse(r, s * 0.42, s * 0.64, s * 0.035, s * 0.05, hex(p.eye));
      fillEllipse(r, s * 0.58, s * 0.64, s * 0.035, s * 0.05, hex(p.eye));
      break;
    }
    case 'imp': {
      fillPolygon(r, [[s * 0.34, s * 0.32], [s * 0.26, s * 0.08], [s * 0.42, s * 0.28]], accent);
      fillPolygon(r, [[s * 0.66, s * 0.32], [s * 0.74, s * 0.08], [s * 0.58, s * 0.28]], accent);
      fillEllipse(r, s * 0.5, s * 0.6, s * 0.26, s * 0.3, body, 1, shade);
      fillEllipse(r, s * 0.42, s * 0.48, s * 0.05, s * 0.035, hex(p.eye));
      fillEllipse(r, s * 0.58, s * 0.48, s * 0.05, s * 0.035, hex(p.eye));
      fillPolygon(r, [[s * 0.4, s * 0.62], [s * 0.6, s * 0.62], [s * 0.5, s * 0.7]], hex(0x2a0a08));
      break;
    }
    case 'bat': {
      fillPolygon(r, [[s * 0.5, s * 0.45], [s * 0.04, s * 0.28], [s * 0.12, s * 0.5], [s * 0.2, s * 0.44], [s * 0.28, s * 0.62]], accent);
      fillPolygon(r, [[s * 0.5, s * 0.45], [s * 0.96, s * 0.28], [s * 0.88, s * 0.5], [s * 0.8, s * 0.44], [s * 0.72, s * 0.62]], accent);
      fillEllipse(r, s * 0.5, s * 0.5, s * 0.18, s * 0.2, body, 1, shade);
      fillEllipse(r, s * 0.44, s * 0.46, s * 0.03, s * 0.03, hex(p.eye));
      fillEllipse(r, s * 0.56, s * 0.46, s * 0.03, s * 0.03, hex(p.eye));
      break;
    }
  }
  return r;
}

/** Soft white dot (tinted at runtime). */
export function paintParticle(size = 32): Raster {
  const r = new Raster(size, size, false);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c;
      const a = clamp01(1 - d) ** 1.6;
      const i = (y * size + x) * 4;
      r.data[i] = 255;
      r.data[i + 1] = 255;
      r.data[i + 2] = 255;
      r.data[i + 3] = a * 255;
    }
  }
  return r;
}

/** White ring with a soft glow (tinted at runtime). */
export function paintHotspot(size = 96): Raster {
  const r = new Raster(size, size, false);
  const c = size / 2;
  const ring = size * 0.38;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const line = clamp01(1 - Math.abs(d - ring) / 3);
      const halo = clamp01(1 - Math.abs(d - ring) / 12) ** 2 * 0.45;
      const dot = clamp01(1 - d / (size * 0.1));
      const a = Math.max(line, halo, dot);
      const i = (y * size + x) * 4;
      r.data[i] = 255;
      r.data[i + 1] = 255;
      r.data[i + 2] = 255;
      r.data[i + 3] = a * 255;
    }
  }
  return r;
}
