#!/usr/bin/env node
/* global console, process, document, innerWidth, innerHeight, fetch, location, visualViewport */
// Opt-in browser evidence for issue #68: the world map works at 360 px width with touch pan/zoom.
// Not part of `pnpm check`. Drives the real built web app against a real local server in an emulated
// 360x740 @2x touch phone (Chromium). Emulated touch is NOT real-device acceptance.
// Usage: see "World map touch evidence" in games/rpg/apps/web/README.md.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright is a machine-level tool here, deliberately not a repository dependency.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const SERVER_URL = (process.env.SERVER_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const OUT_DIR = process.env.OUT_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'world-map-touch');
const here = dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(join(here, '../../../../../engine/client-kit/src/world-map-layout.ts'), 'utf8');
const MIN_SCALE = Number(/MIN_MAP_SCALE = ([\d.]+)/.exec(layoutSource)?.[1]);
const MAX_SCALE = Number(/MAX_MAP_SCALE = ([\d.]+)/.exec(layoutSource)?.[1]);
if (!(MIN_SCALE > 0 && MAX_SCALE > MIN_SCALE)) throw new Error('cannot read MIN/MAX_MAP_SCALE from world-map-layout.ts');

mkdirSync(OUT_DIR, { recursive: true });
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

// ---------- touch helpers (CDP) ----------
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 1, radiusY: 1, force: 1 })) });
async function drag(from, to, steps = 8) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(60);
}
/** Two fingers symmetric around `center`, horizontal, distance goes from d0 to d1. */
async function pinch(center, d0, d1, steps = 10) {
  const at = (d) => [{ x: center.x - d / 2, y: center.y }, { x: center.x + d / 2, y: center.y }];
  await touch('touchStart', at(d0));
  for (let i = 1; i <= steps; i++) await touch('touchMove', at(d0 + ((d1 - d0) * i) / steps));
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}
/** A canvas point at least 55 px from every node hit area (touches that start on a node never pan), nearest to `want`. */
async function emptyPointNear(want) {
  const nodes = await readNodes();
  const c = await canvasRect();
  let best;
  for (let x = c.x + 10; x < c.x + c.w - 10; x += 10) for (let y = c.y + 10; y < c.y + c.h - 10; y += 10) {
    if (nodes.some((n) => Math.hypot(n.cx - x, n.cy - y) < 55)) continue;
    const d = Math.hypot(x - want.x, y - want.y);
    if (!best || d < best.d) best = { x, y, d };
  }
  if (!best) throw new Error('no empty canvas point for a touch start');
  return { x: best.x, y: best.y };
}
async function tap(point) {
  await touch('touchStart', [point]);
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}

// ---------- DOM probes ----------
const readViewport = () => page.evaluate(() => {
  const g = document.querySelector('.world-map__viewport');
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g?.getAttribute('transform') ?? '');
  return { x: Number(m?.[1]), y: Number(m?.[2]), scale: Number(m?.[3]) };
});
const readNodes = () => page.evaluate(() => {
  const canvas = document.querySelector('.world-map__canvas-wrap').getBoundingClientRect();
  return [...document.querySelectorAll('[data-map-node]')].map((el) => {
    const r = el.querySelector('.world-map__hit-area').getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return {
      label: el.getAttribute('aria-label'), cx, cy, w: r.width, h: r.height,
      // Reachable = touch-hittable: hit area centre lies inside the visible canvas (and so inside the window).
      reachable: cx >= canvas.left && cx <= canvas.right && cy >= canvas.top && cy <= canvas.bottom && cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
      intersects: r.right > Math.max(0, canvas.left) && r.left < Math.min(innerWidth, canvas.right) && r.bottom > Math.max(0, canvas.top) && r.top < Math.min(innerHeight, canvas.bottom),
    };
  });
});
const canvasRect = () => page.evaluate(() => { const r = document.querySelector('.world-map__canvas-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
const overflow = () => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth, bodyScrollWidth: document.body.scrollWidth, visualScale: visualViewport?.scale ?? 1 }));
const shot = (name) => page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
const fmt = (n) => Number(n).toFixed(2);
async function resetMap() {
  await page.getByRole('button', { name: 'Reset map' }).evaluate((el) => el.click());
  await page.waitForTimeout(80);
}

// ---------- bootstrap a real character through the real UI + real server ----------
await page.goto(`${BASE_URL}/`);
await page.getByLabel('Name').fill('TouchHero');
await page.getByRole('button', { name: 'Create' }).click();
await page.waitForFunction(async () => (await (await fetch('/characters')).json()).length > 0);
const actorId = await page.evaluate(async () => (await (await fetch('/characters')).json())[0]?.actorId);
if (!actorId) throw new Error('no character after creation');

async function debugComplete(areaId) {
  const response = await context.request.post(`${SERVER_URL}/debug/characters/${actorId}/world-progress`, {
    headers: { origin: SERVER_URL },
    data: { command_id: randomUUID(), operation: 'debug.recordWorldProgress', payload: { actorId, completedAreas: [areaId] } },
  });
  return response.status();
}
async function openWorld() {
  await page.evaluate(() => { location.hash = '#/world'; });
  await page.reload();
  await page.locator('.world-map__canvas').waitFor();
  await page.waitForTimeout(300);
}

async function lockedSheetChecks(prefix, locked) {
  const sheet = page.locator('.world-map__details');
  await page.locator('.world-map').scrollIntoViewIfNeeded();
  const node = (await readNodes()).find((n) => n.label === locked.label);
  await tap({ x: node.cx, y: node.cy });
  await sheet.waitFor({ timeout: 3000 });
  await sheet.scrollIntoViewIfNeeded();
  const reasons = await sheet.locator('.world-map__locked-copy li').allInnerTexts();
  const enterDisabled = await sheet.locator('.world-map__actions button').first().isDisabled();
  const lockedVisible = await sheet.locator('.world-map__locked-copy strong').isVisible();
  check(`${prefix} locked area sheet shows Locked + reason text`, lockedVisible && reasons.length > 0 && reasons.every((r) => r.length > 0), `area="${locked.label.split(',')[0]}" reasons=${JSON.stringify(reasons)}`);
  check(`${prefix} locked area enter action is disabled`, enterDisabled, `disabled=${enterDisabled}`);
  await shot('08-locked-sheet');
  const closeBox = await page.locator('.world-map__close').boundingBox();
  await tap({ x: closeBox.x + closeBox.width / 2, y: closeBox.y + closeBox.height / 2 });
  check(`${prefix} locked sheet dismissed by touch`, (await sheet.count()) === 0, `sheets in DOM after tap: ${await sheet.count()}`);
}

// ===== Scenario A: fresh character (locked areas visible with reasons) =====
await openWorld();
const nodesA = await readNodes();
console.log(`Scenario A (fresh character): ${nodesA.length} nodes: ${nodesA.map((n) => n.label).join(' | ')}`);
const ovA = await overflow();
check('A no horizontal overflow', ovA.scrollWidth <= ovA.innerWidth && ovA.bodyScrollWidth <= ovA.innerWidth, `scrollWidth=${ovA.scrollWidth} body=${ovA.bodyScrollWidth} innerWidth=${ovA.innerWidth}`);
await shot('01-fresh-initial');
const lockedA = nodesA.find((n) => /Locked/.test(n.label));
if (lockedA) await lockedSheetChecks('A', lockedA);
else check('A locked area sheet shows Locked + reason text', false, 'no locked area visible for a fresh character');

// ===== Scenario B: Region 1 conquered via debug tools (more nodes, Region 2 unlocked) =====
const debugStatus = await debugComplete('area:region_1');
console.log(`debug record area:region_1 completion -> HTTP ${debugStatus}`);
await openWorld();
const nodes0 = await readNodes();
console.log(`Scenario B (region_1 complete): ${nodes0.length} nodes: ${nodes0.map((n) => `${n.label} @(${fmt(n.cx)},${fmt(n.cy)})`).join(' | ')}`);
check('B all nodes inside the viewport at initial fit (no pan needed)', nodes0.every((n) => n.reachable), `${nodes0.filter((n) => n.reachable).length}/${nodes0.length} reachable`);
const ov = await overflow();
check('B no horizontal overflow', ov.scrollWidth <= ov.innerWidth && ov.bodyScrollWidth <= ov.innerWidth, `scrollWidth=${ov.scrollWidth} body=${ov.bodyScrollWidth} innerWidth=${ov.innerWidth}`);
await page.locator('.world-map').scrollIntoViewIfNeeded();
await shot('02-initial');
// Observation only (not gating): do node labels overlap each other at the initial fit?
const labelOverlaps = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.world-map__node-label')].map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
  const out = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].r, b = boxes[j].r;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`"${boxes[i].text}" x "${boxes[j].text}"`);
  }
  return out;
});
console.log(`OBSERVE  label overlaps at initial fit: ${labelOverlaps.length === 0 ? 'none' : labelOverlaps.join('; ')}`);
const cv = await canvasRect();
console.log(`canvas ${fmt(cv.w)}x${fmt(cv.h)} at (${fmt(cv.x)},${fmt(cv.y)})`);

// ---- touch pan ----
const v0 = await readViewport();
const anchor = { x: cv.x + 12, y: cv.y + cv.h - 12 }; // empty corner (no node hit-area)
await drag(anchor, { x: anchor.x + 60, y: anchor.y - 40 });
const v1 = await readViewport();
check('touch drag pans the map', Math.abs(v1.x - v0.x) > 1 && Math.abs(v1.y - v0.y) > 1 && v1.scale === v0.scale,
  `viewport (${fmt(v0.x)},${fmt(v0.y)}) -> (${fmt(v1.x)},${fmt(v1.y)}) scale ${fmt(v0.scale)}`);
await resetMap();

// ---- pinch out (zoom in) ----
// Fingers must start on empty canvas (a touch that starts on a node is a node tap, not a gesture).
const emptyStart = await emptyPointNear({ x: cv.x + 40, y: cv.cy });
const pinchOutCenter = { x: emptyStart.x, y: emptyStart.y };
await pinch(pinchOutCenter, 24, 48);
const vZoom = await readViewport();
check('pinch-out (2x finger spread) increases scale', vZoom.scale > 1.5 && vZoom.scale < MAX_SCALE, `scale 1.00 -> ${fmt(vZoom.scale)} (max ${MAX_SCALE})`);
await shot('03-pinched-in');
await pinch(pinchOutCenter, 24, 180);
const vMax = await readViewport();
check('pinch-out clamps at documented max', Math.abs(vMax.scale - MAX_SCALE) < 0.001, `scale ${fmt(vMax.scale)} == MAX_MAP_SCALE ${MAX_SCALE}`);
const ovZ = await overflow();
check('pinch does not zoom the page itself', ovZ.visualScale === 1 && ovZ.scrollWidth <= ovZ.innerWidth, `visualViewport.scale=${ovZ.visualScale} scrollWidth=${ovZ.scrollWidth}`);

// ---- node reachability at max zoom by touch panning ----
await shot('04-max-zoom');
const labels = nodes0.map((n) => n.label);
const reach = [];
let totalDrags = 0;
for (const label of labels) {
  let node, drags = 0;
  for (; drags <= 14; drags++) {
    node = (await readNodes()).find((n) => n.label === label);
    const margin = 30;
    const inside = node.cx > cv.x + margin && node.cx < cv.x + cv.w - margin && node.cy > cv.y + margin && node.cy < cv.y + cv.h - margin;
    if (inside) break;
    // Drag so the node moves toward the canvas centre; start from the empty side away from the node when possible.
    const dx = Math.max(-90, Math.min(90, cv.cx - node.cx)), dy = Math.max(-90, Math.min(90, cv.cy - node.cy));
    const start = await emptyPointNear({ x: cv.cx - dx / 2, y: cv.cy - dy / 2 });
    await drag(start, { x: start.x + dx, y: start.y + dy });
  }
  node = (await readNodes()).find((n) => n.label === label);
  reach.push({ label, drags, reachable: node.reachable && node.intersects });
  totalDrags += drags;
  if (label === labels[labels.length - 1]) await shot('05-panned-to-last-node');
}
for (const r of reach) check(`node reachable by touch pan at max zoom: ${r.label}`, r.reachable, `${r.drags} drag(s)`);
console.log(`total pan drags across ${labels.length} nodes: ${totalDrags}`);

// ---- pinch in (zoom out) clamps at min ----
await resetMap();
const mid = { x: cv.cx, y: cv.cy };
await pinch(mid, 300, 20);
const vMin = await readViewport();
check('pinch-in clamps at documented min', Math.abs(vMin.scale - MIN_SCALE) < 0.001, `scale ${fmt(vMin.scale)} == MIN_MAP_SCALE ${MIN_SCALE}`);
await shot('06-min-zoom');
const nodesMin = await readNodes();
const sizesMin = nodesMin.map((n) => Math.min(n.w, n.h));
check('node targets >= 44x44 CSS px at min zoom', Math.min(...sizesMin) >= 43.9, `smallest hit area ${fmt(Math.min(...sizesMin))} px over ${nodesMin.length} nodes`);

// ---- target sizes (initial and max zoom) ----
await resetMap();
const sizesInitial = (await readNodes()).map((n) => Math.min(n.w, n.h));
check('node targets >= 44x44 CSS px at initial zoom', Math.min(...sizesInitial) >= 43.9, `smallest hit area ${fmt(Math.min(...sizesInitial))} px over ${sizesInitial.length} nodes`);
await pinch(pinchOutCenter, 24, 180);
const sizesMax = (await readNodes()).map((n) => Math.min(n.w, n.h));
check('node targets >= 44x44 CSS px at max zoom', Math.min(...sizesMax) >= 43.9, `smallest hit area ${fmt(Math.min(...sizesMax))} px`);
await resetMap();
const buttonSizes = async (selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') ?? el.textContent.trim(), w: r.width, h: r.height }; }), selector);
const zoomButtons = await buttonSizes('.world-map__zoom-controls button');
check('zoom control buttons >= 44x44 CSS px', zoomButtons.length === 3 && zoomButtons.every((b) => b.w >= 43.9 && b.h >= 43.9), zoomButtons.map((b) => `${b.label}:${fmt(b.w)}x${fmt(b.h)}`).join(', '));

// ---- tap an unlocked area: detail sheet, action buttons, dismiss by touch ----
const sheet = page.locator('.world-map__details');
async function tapNode(label) {
  const node = (await readNodes()).find((n) => n.label.startsWith(label));
  if (!node) throw new Error(`node not found: ${label}`);
  await tap({ x: node.cx, y: node.cy });
}
const allNodes = await readNodes();
const known = allNodes.find((n) => !/Locked/.test(n.label) && !/Sanctuary/.test(n.label));
console.log(`known area under test: ${known?.label}`);
if (known) {
  await tapNode(known.label.split(',')[0]);
  await sheet.waitFor({ timeout: 3000 });
  await sheet.scrollIntoViewIfNeeded();
  const knownTitle = await sheet.locator('h2').innerText();
  check('tap on area opens detail sheet', knownTitle === known.label.split(',')[0], `sheet h2="${knownTitle}"`);
  await shot('07-known-sheet');
  const sheetButtons = await buttonSizes('.world-map__details button');
  check('detail sheet buttons >= 44x44 CSS px', sheetButtons.length > 0 && sheetButtons.every((b) => b.w >= 43.9 && b.h >= 43.9), sheetButtons.map((b) => `${b.label}:${fmt(b.w)}x${fmt(b.h)}`).join(', '));
  const closeBox = await page.locator('.world-map__close').boundingBox();
  await tap({ x: closeBox.x + closeBox.width / 2, y: closeBox.y + closeBox.height / 2 });
  check('detail sheet dismissed by touch (close button)', (await sheet.count()) === 0, `sheets in DOM after tap: ${await sheet.count()}`);
} else check('tap on area opens detail sheet', false, 'no unlocked area in the view');

// ---- hub sheet + final overflow ----
const finalOv = await overflow();
check('final: no horizontal overflow', finalOv.scrollWidth <= finalOv.innerWidth, `scrollWidth=${finalOv.scrollWidth} innerWidth=${finalOv.innerWidth}`);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; ') || 'none');

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT_DIR}`);
process.exit(failed.length === 0 ? 0 : 1);
