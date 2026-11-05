/**
 * Scene art for a location. Locations with art (see regionArt.ts) use their WebP background. Every other location gets
 * a deterministic canvas-generated placeholder seeded by its ID: same location, same picture, on every device and
 * every visit. No text is drawn (text stays in the DOM). Nothing else in the viewport depends on how the images are
 * made.
 */
import type { SceneImage, SceneImageData, SceneSpec } from '@engine/client-kit';

import { ART_INDEX, artImage } from './regionArt.ts';
import type { ArtIndex } from './regionArt.ts';

export const SCENE_WIDTH = 768;
export const SCENE_HEIGHT = 512;
const FOREGROUND_HEIGHT = 190;

/** FNV-1a, 32 bit. */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RidgePlan {
  /** Heights as fractions of the band, left to right, evenly spaced. */
  readonly points: readonly number[];
  readonly color: string;
}

export interface ScenePlan {
  readonly skyTop: string;
  readonly skyBottom: string;
  readonly sun: { readonly x: number; readonly y: number; readonly radius: number; readonly color: string };
  readonly stars: readonly { readonly x: number; readonly y: number; readonly size: number }[];
  readonly farRidges: readonly RidgePlan[];
  readonly nearRidge: RidgePlan;
}

function ridge(random: () => number, count: number, low: number, high: number, color: string): RidgePlan {
  const points: number[] = [];
  let height = low + random() * (high - low);
  for (let i = 0; i < count; i++) {
    height = Math.min(high, Math.max(low, height + (random() - 0.5) * (high - low) * 0.8));
    points.push(Math.round(height * 1000) / 1000);
  }
  return { points, color };
}

/** Pure description of a location's backdrop; drawing only follows this plan. */
export function planScene(locationId: string): ScenePlan {
  const random = seededRandom(hashSeed(locationId));
  const hue = Math.floor(random() * 360);
  const night = random() < 0.4;
  const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h) % 360} ${s}% ${l}%)`;
  const stars = night
    ? Array.from({ length: 28 }, () => ({ x: Math.floor(random() * SCENE_WIDTH), y: Math.floor(random() * SCENE_HEIGHT * 0.45), size: 1 + Math.floor(random() * 2) }))
    : [];
  return {
    skyTop: night ? hsl(hue, 45, 10) : hsl(hue, 40, 28),
    skyBottom: night ? hsl(hue + 25, 40, 24) : hsl(hue + 30, 55, 62),
    sun: {
      x: Math.floor(120 + random() * (SCENE_WIDTH - 240)), y: Math.floor(90 + random() * 110), radius: 26 + Math.floor(random() * 22),
      color: night ? hsl(hue + 200, 20, 88) : hsl(hue + 40, 80, 82),
    },
    stars,
    farRidges: [
      ridge(random, 9, 0.18, 0.42, hsl(hue + 10, 30, night ? 18 : 40)),
      ridge(random, 8, 0.1, 0.34, hsl(hue + 5, 30, night ? 14 : 30)),
    ],
    nearRidge: ridge(random, 7, 0.25, 0.8, hsl(hue, 28, night ? 8 : 16)),
  };
}

function drawRidge(ctx: CanvasRenderingContext2D, plan: RidgePlan, left: number, width: number, baseline: number, band: number): void {
  const step = width / (plan.points.length - 1);
  ctx.beginPath();
  ctx.moveTo(left, baseline);
  plan.points.forEach((p, i) => ctx.lineTo(left + i * step, baseline - p * band));
  ctx.lineTo(left + width, baseline);
  ctx.closePath();
  ctx.fillStyle = plan.color;
  ctx.fill();
}

function newCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return { canvas, ctx };
}

function paintBackground(plan: ScenePlan): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(SCENE_WIDTH, SCENE_HEIGHT);
  const sky = ctx.createLinearGradient(0, 0, 0, SCENE_HEIGHT);
  sky.addColorStop(0, plan.skyTop);
  sky.addColorStop(1, plan.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (const star of plan.stars) ctx.fillRect(star.x, star.y, star.size, star.size);
  ctx.beginPath();
  ctx.arc(plan.sun.x, plan.sun.y, plan.sun.radius, 0, Math.PI * 2);
  ctx.fillStyle = plan.sun.color;
  ctx.fill();
  plan.farRidges.forEach((r, i) => drawRidge(ctx, r, 0, SCENE_WIDTH, SCENE_HEIGHT - 150 + i * 60, 260 - i * 50));
  ctx.fillStyle = plan.farRidges[1]?.color ?? '#000';
  ctx.fillRect(0, SCENE_HEIGHT - 90, SCENE_WIDTH, 90);
  return canvas;
}

function paintForeground(plan: ScenePlan): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(SCENE_WIDTH, FOREGROUND_HEIGHT);
  drawRidge(ctx, plan.nearRidge, 0, SCENE_WIDTH, FOREGROUND_HEIGHT, FOREGROUND_HEIGHT * 0.85);
  return canvas;
}

function image(key: string, width: number, height: number, paint: () => HTMLCanvasElement): SceneImage {
  return { key, width, height, load: () => Promise.resolve(paint()) };
}

function placeholderScene(locationId: string): SceneSpec {
  const plan = planScene(locationId);
  return {
    id: locationId,
    background: image(`${locationId}:bg`, SCENE_WIDTH, SCENE_HEIGHT, () => paintBackground(plan)),
    layers: [{
      id: 'foreground', x: 0, y: SCENE_HEIGHT - FOREGROUND_HEIGHT,
      image: image(`${locationId}:fg`, SCENE_WIDTH, FOREGROUND_HEIGHT, () => paintForeground(plan)),
    }],
    // GAP: exit/hotspot geometry lives in the compiled Tiled `scenes` bundle, which no client endpoint serves yet.
    regions: [],
  };
}

/**
 * The scene shown for a location. The scene ID is the location ID, so a location change is a scene change.
 * A location with art in a region manifest uses its WebP as the background (decoded in `load()`); any other
 * location gets the deterministic placeholder.
 */
export function sceneForLocation(locationId: string, art: ArtIndex = ART_INDEX, decode?: (url: string) => Promise<SceneImageData>): SceneSpec {
  const found = art.get(locationId);
  if (!found) return placeholderScene(locationId);
  return { id: locationId, background: artImage(found, decode), framing: found.framing, layers: [], regions: [] };
}
