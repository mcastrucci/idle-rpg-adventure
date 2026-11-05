#!/usr/bin/env node
/* global console, process, document, getComputedStyle, window, URL, fetch, setTimeout */
// Opt-in browser evidence for issue #176: the live adventure is one fixed frame. Not part of `pnpm check` (it needs a
// browser). Drives the built web app (`vite preview`) in an emulated phone with the server mocked: HTTP through
// `page.route`, the live socket through `page.routeWebSocket`, so every state (exploring, common-enemy combat, boss
// combat, telegraph, queue, feedback, open log) is scripted and repeatable.
//
// Asserts at each viewport: the document never scrolls; every control is at least 44 px; the skill, potion, retreat, Auto
// and log controls do not move when a telegraph appears, the queue changes, feedback arrives or the log opens; the row
// table is identical in exploring and combat; sprites are drawn for every combatant (a silhouette when none exists).
// Usage: see "Live frame check" in games/rpg/apps/web/README.md.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertInside, assertNoDocumentScroll, assertRectsStable, assertTapTargets } from './live-frame-guard.mjs';

// Playwright is a machine-level tool here, deliberately not a repository dependency.
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT_DIR = process.env.OUT_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'live-frame');
const PORT = Number(process.env.PORT ?? 4179);
const VIEWPORTS = [{ width: 360, height: 780 }, { width: 320, height: 640 }];
const LOCALES = (process.env.LOCALES ?? 'en-US,es-ES').split(',');
mkdirSync(OUT_DIR, { recursive: true });

const ACTOR = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const AREA = 'area:region_1';
const CHARACTER = { actorId: ACTOR, accountId: ACCOUNT, gameId: 'rpg', name: 'Max', level: 3, xp: 120,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0, skillLoadout: ['skill:shield_bash', 'skill:guard'],
  automationRules: [], activityState: 'live', activityId: INSTANCE, version: 1 };

// ---------------------------------------------------------------- fixtures: the host view for each state
const hero = (overrides = {}) => ({ actorId: ACTOR, level: 3, xp: 120, xpIntoLevel: 22, xpToNext: 60, hp: 76, maxHp: 140, present: true,
  consumables: [{ item: 'item:healing_potion', labelKey: 'item.healing_potion.name', qty: 2 }],
  skills: [
    { id: 'skill:taunt', labelKey: 'skill.taunt.name', slot: 1, cooldownTicks: 8, cooldownRemainingTicks: 0, windupTicks: 0 },
    { id: 'skill:guard', labelKey: 'skill.guard.name', slot: 2, cooldownTicks: 6, cooldownRemainingTicks: 0, windupTicks: 0 },
    { id: 'skill:cleave', labelKey: 'skill.cleave.name', slot: 3, cooldownTicks: 10, cooldownRemainingTicks: 4, windupTicks: 0 },
    { id: 'skill:shield_bash', labelKey: 'skill.shield_bash.name', slot: 4, cooldownTicks: 6, cooldownRemainingTicks: 0, windupTicks: 0 }],
  ...overrides });
const exits = (count) => Array.from({ length: count }, (_, i) => ({ id: `exit:${i}`, to: `loc:region_1.${['overgrown_causeway', 'old_well', 'tangle_orchard', 'glowcap_grotto', 'lantern_ruins', 'pump_station', 'vault_antechamber', 'sunken_greenhouse'][i % 8]}`,
  open: i !== 2, reasons: i === 2 ? ['reason.needs_key'] : [], bossRoom: false, visited: false }));
const base = (location, extra) => ({ phase: 'exploring', area: 'area.region_1.name', location, heroes: [hero()], groups: [], exits: [], hotspots: [], resources: [],
  flags: [], canReturn: true, runBag: [{ actorId: ACTOR, items: [{ item: 'item:herb', qty: 2 }], gold: 14, uniques: [] }], combat: null, ...extra });
const exploring = () => base('loc:region_1.portal_clearing', {
  groups: [{ id: 'loc:region_1.portal_clearing/0', enemies: ['enemy:glowcap_mite', 'enemy:thornback_boar'], boss: false, defeated: false }],
  exits: exits(8), hotspots: [{ id: 'hotspot:0', type: 'lore', textKey: 'hotspot.region_1.old_signpost.name', done: false }, { id: 'hotspot:1', type: 'lore', textKey: 'hotspot.region_1.broken_pump.name', done: true }],
  resources: [{ nodeId: 'res:region_1.glowcap', resource: 'res.region_1.glowcap.name', gathered: false }],
  scene: { width: 1086, height: 1448, regions: [{ id: 'exit:0', kind: 'exit', x: 543, y: 300, r: 80 }, { id: 'hotspot:0', kind: 'hotspot', x: 300, y: 900, r: 70 }] } });
const enemy = (n, slug, hp = 80, windup = null) => ({ id: `grp#${n}`, side: 'enemy', hp, maxHp: 100, alive: hp > 0, labelKey: `enemy.${slug}.name`, effects: [], queued: null, windup });
const me = (extra = {}) => ({ id: ACTOR, side: 'hero', hp: 76, maxHp: 140, alive: true, auto: false, effects: [], queued: null, windup: null, ...extra });
const combatView = (location, enemies, { tick = 12, boss = false, heroExtra = {}, hp = 76 } = {}) => base(location, {
  phase: 'combat', canRetreat: !boss, retreatBlockedReason: boss ? 'boss' : null, canReturn: false,
  heroes: [hero({ hp })], combat: { tick, groupId: 'grp', actors: [me({ hp, ...heroExtra }), ...enemies] } });
const windup = (tick, ticks = 3) => ({ skill: 'skill:crushing_blow', labelKey: 'skill.crushing_blow.name', targetIds: [ACTOR], startedTick: tick, resolveAtTick: tick + ticks });
const STATES = {
  exploring,
  common: () => combatView('loc:region_1.irrigation_terraces', [enemy(0, 'glowcap_mite', 60), enemy(1, 'thornback_boar', 90)]),
  four: () => combatView('loc:region_1.tangle_orchard', [enemy(0, 'glowcap_mite', 60), enemy(1, 'thornback_boar', 90), enemy(2, 'hollow_creeper', 100), enemy(3, 'glass_wisp', 100)]),
  boss: () => combatView('loc:region_1.seed_vault_heart', [enemy(0, 'hollow_matriarch', 65)], { boss: true }),
};

// ---------------------------------------------------------------- the mocked server
async function mount(page, startState) {
  const server = { view: startState, seq: 0, socket: null, commands: [] };
  const world = { hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
    areas: [{ id: AREA, label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
      completion: { discovered: 3, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false, bosses: [{ label: 'Boss', defeated: false }] } },
      danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: [] }, actions: { enterLive: true, startIdle: false } }],
    routes: [] };
  const participants = [{ actorId: ACTOR, status: 'connected' }];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const path = url.pathname;
    if (path === '/auth/session') return json({ accountId: ACCOUNT, guest: true, email: null, expiresAtMs: Date.now() + 3_600_000 });
    if (path === '/characters') return json([CHARACTER]);
    if (path.endsWith('/world')) return json(world);
    if (path.endsWith('/live-death')) return json({ death: null });
    if (path === `/live/current/${ACTOR}`) return json({ current: { instanceId: INSTANCE, actorId: ACTOR, view: server.view, participants } });
    if (['/characters', '/live', '/auth', '/debug', '/content', '/expeditions', '/merchant'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return json({ error: 'not_found' }, 404);
    return route.fallback();
  });
  const send = (frame) => server.socket?.send(JSON.stringify(frame));
  await page.routeWebSocket('**/auth/live', (ws) => {
    server.socket = ws;
    ws.send(JSON.stringify({ type: 'authenticated', accountId: ACCOUNT }));
    ws.onMessage((raw) => {
      if (typeof raw !== 'string' || raw === 'ping') return;
      const command = JSON.parse(raw).command;
      if (command?.op === 'live.attach') {
        server.seq += 1;
        send({ type: 'live.snapshot', instanceId: INSTANCE, epoch: 1, seq: server.seq, view: server.view, participants });
        send({ type: 'live.attached', instanceId: INSTANCE, mode: 'snapshot' });
      } else if (command?.op === 'live.command') {
        server.commands.push(command.command);
        send({ type: 'live.ack', instanceId: INSTANCE, commandId: command.commandId, status: 'applied', duplicate: false });
      }
    });
  });
  return {
    server,
    /** A new authoritative snapshot, as the host sends after every command. */
    async setView(view) {
      server.view = view;
      server.seq += 1;
      send({ type: 'live.snapshot', instanceId: INSTANCE, epoch: 1, seq: server.seq, view, participants });
      await page.waitForTimeout(150);
    },
    /** A game event frame; `inner` is a combat-engine event, wrapped like the real host does. */
    async combatEvent(inner) { await this.event({ type: 'combat', event: inner }); },
    async event(event) {
      server.seq += 1;
      send({ type: 'live.event', instanceId: INSTANCE, epoch: 1, seq: server.seq, source: 'game', event });
      await page.waitForTimeout(150);
    },
  };
}

// ---------------------------------------------------------------- measurements (run in the page)
const CONTROLS = {
  skill1: '.live-combat__action:nth-child(1)', skill2: '.live-combat__action:nth-child(2)', skill3: '.live-combat__action:nth-child(3)', skill4: '.live-combat__action:nth-child(4)',
  potion: '.live-combat__item', retreat: '.live-combat__retreat-button', auto: '.live-combat__auto', log: '.live-log__toggle',
};
const ROWS = { crumb: '.live-frame__crumb', scene: '.live-frame__scene', strip: '.live-explore__strip, .live-combat__strip', panel: '.live-explore__panel, .live-combat__panel', log: '.live-log' };
const COMBAT_ROWS = { telegraph: '.live-combat__telegraphs', queue: '.live-combat__queue', skills: '.live-combat__skills', feedback: '.live-combat__feedback', items: '.live-combat__items' };

const measure = (page, selectors) => page.evaluate((map) => Object.fromEntries(Object.entries(map).flatMap(([name, selector]) => {
  const element = document.querySelector(selector);
  if (!element) return [];
  const r = element.getBoundingClientRect();
  return [[name, { x: r.x, y: r.y, width: r.width, height: r.height }]];
})), selectors);
const documentSize = (page) => page.evaluate(() => ({ scrollHeight: document.scrollingElement.scrollHeight, scrollWidth: document.scrollingElement.scrollWidth, innerHeight: window.innerHeight, innerWidth: window.innerWidth }));
const tapTargets = (page) => page.evaluate(() => [...document.querySelectorAll('.live-frame button, .live-frame a[href], .live-frame label.live-combat__auto')]
  .filter((element) => !element.closest('.visually-hidden') && getComputedStyle(element).visibility !== 'hidden')
  .map((element) => { const r = element.getBoundingClientRect(); return { name: `${element.tagName.toLowerCase()}.${element.className.split(' ')[0]}`, width: r.width, height: r.height, x: r.x, y: r.y }; }));

// ---------------------------------------------------------------- the run
const results = [];
function check(name, run) {
  return run().then(() => { results.push({ name, ok: true }); console.log(`PASS  ${name}`); },
    (error) => { results.push({ name, ok: false }); console.log(`FAIL  ${name}\n      ${error.message}`); });
}

let preview;
async function startPreview() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  preview = spawn('pnpm', ['--filter', '@rpg/web', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return url; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('vite preview did not start; run `pnpm --filter @rpg/web build` first');
}

const baseUrl = await startPreview();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const viewport of VIEWPORTS) for (const locale of LOCALES) {
    const tag = `${viewport.width}x${viewport.height}-${locale.slice(0, 2)}`;
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const shot = (name) => page.screenshot({ path: join(OUT_DIR, `${tag}-${name}.png`) });
    const mock = await mount(page, STATES.exploring());
    await page.goto(`${baseUrl}/#/world/live/${encodeURIComponent(AREA)}`);
    await page.waitForSelector('.live-frame[data-mode="explore"] .live-explore__panel');
    await page.waitForTimeout(800);

    // ---- exploring
    await check(`${tag} exploring: no document scroll, tap targets, frame rows`, async () => {
      assertNoDocumentScroll(await documentSize(page));
      assertTapTargets(await tapTargets(page));
      const frame = (await measure(page, { frame: '.live-frame' })).frame;
      assertInside(frame, await measure(page, ROWS));
      const list = await page.evaluate(() => { const l = document.querySelector('.live-explore__list'); return { scroll: l.scrollHeight, client: l.clientHeight }; });
      if (list.scroll <= list.client) throw new Error(`the 8-exit list should scroll inside its panel (${list.scroll} <= ${list.client})`);
    });
    await check(`${tag} exploring: header and tab bar are out of the way, back control present`, async () => {
      const hidden = await page.evaluate(() => ['.header', '.tabbar'].map((s) => getComputedStyle(document.querySelector(s)).display));
      if (hidden.some((display) => display !== 'none')) throw new Error(`header/tab bar visible: ${hidden}`);
      if (!(await page.locator('.live-frame__back').isVisible())) throw new Error('no back control');
    });
    const exploringRows = await measure(page, ROWS);
    console.log(`      rows ${tag}: ${Object.entries(exploringRows).map(([name, r]) => `${name} ${r.height.toFixed(0)}`).join(', ')}`);
    await shot('1-exploring');

    // The canvas is cover-fitted to the band (art 1086x1448, focal point 0.5), so a tap on the drawn hotspot circle can be
    // aimed from the fixture's scene coordinates (hotspot:0 at 300,900 of a 1086x1448 scene).
    await check(`${tag} exploring: tapping a scene region sends the same command as its button`, async () => {
      const mode = await page.getAttribute('.scene-viewport', 'data-mode');
      if (mode !== 'canvas') { console.log(`      (scene renderer mode "${mode}": region tap skipped)`); return; }
      const band = (await measure(page, { scene: '.live-frame__scene' })).scene;
      const scale = Math.max(band.width / 1086, band.height / 1448);
      const x = band.x + 300 * scale + (band.width - 1086 * scale) / 2;
      const y = band.y + 900 * scale + (band.height - 1448 * scale) / 2;
      mock.server.commands.length = 0;
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(300);
      const sent = mock.server.commands.filter((command) => command.type === 'interact' && command.hotspotId === 'hotspot:0');
      if (sent.length !== 1) throw new Error(`expected one interact for hotspot:0 after tapping (${x.toFixed(0)}, ${y.toFixed(0)}), got ${JSON.stringify(mock.server.commands)}`);
    });

    // ---- combat with common enemies
    await mock.setView(STATES.common());
    await page.waitForSelector('.live-frame[data-mode="combat"] .live-combat__panel');
    await page.waitForTimeout(600);
    await check(`${tag} combat: same row table as exploring`, async () => assertRectsStable(exploringRows, await measure(page, ROWS), 0.5, 'frame rows'));
    await check(`${tag} combat (common): no document scroll, tap targets`, async () => {
      assertNoDocumentScroll(await documentSize(page));
      assertTapTargets(await tapTargets(page));
    });
    await check(`${tag} combat (common): a sprite for the hero and each enemy`, async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('.combat-scene img')].every((img) => img.complete && img.naturalWidth > 0));
      const kinds = await page.evaluate(() => [...document.querySelectorAll('.combat-scene__slot')].map((slot) => `${slot.dataset.actor}:${slot.dataset.kind}`));
      if (kinds.length !== 3 || kinds.some((kind) => !kind.endsWith(':sprite'))) throw new Error(`expected 3 sprites, got ${kinds}`);
    });
    await shot('2-combat-common');
    console.log(`      combat panel ${tag}: ${Object.entries(await measure(page, COMBAT_ROWS)).map(([name, r]) => `${name} ${r.height.toFixed(0)}`).join(', ')}`);
    const stable = { ...CONTROLS, ...COMBAT_ROWS };
    const baseline = await measure(page, stable);
    await check(`${tag} combat (common): controls stay put through telegraph, queue, feedback and the log`, async () => {
      const view = STATES.common();
      view.combat.actors[1].windup = windup(12);
      await mock.setView(view);
      await shot('3-combat-telegraph');
      assertRectsStable(baseline, await measure(page, stable), 0.5, 'after telegraph');
      view.combat.actors[0].queued = { kind: 'useSkill', skill: 'skill:guard', labelKey: 'skill.guard.name', target: null };
      view.combat.actors[0].auto = true;
      await mock.setView(view);
      assertRectsStable(baseline, await measure(page, stable), 0.5, 'after queue change');
      await mock.event({ type: 'combatStarted', groupId: 'grp', boss: false });
      await mock.combatEvent({ type: 'InputRejected', actorId: ACTOR, kind: 'useSkill', reason: 'onCooldown', tick: 12 });
      await mock.combatEvent({ type: 'DamageDealt', sourceId: 'grp#0', targetId: ACTOR, amount: 9, hpAfter: 67, tick: 12 });
      await shot('4-combat-feedback');
      assertRectsStable(baseline, await measure(page, stable), 0.5, 'after feedback');
      await page.click('.live-log__toggle');
      await page.waitForSelector('.live-log__drawer');
      await shot('5-combat-log');
      assertRectsStable(baseline, await measure(page, stable), 0.5, 'with the log open');
      assertNoDocumentScroll(await documentSize(page));
      await page.click('.live-log__close');
      assertRectsStable(baseline, await measure(page, stable), 0.5, 'after closing the log');
    });
    await check(`${tag} combat (common): a skill tap sends one command`, async () => {
      mock.server.commands.length = 0;
      await page.click('.live-combat__action:nth-child(1)');
      await page.waitForTimeout(200);
      const sent = mock.server.commands.filter((command) => command.type === 'useSkill');
      if (sent.length !== 1) throw new Error(`expected one useSkill, got ${JSON.stringify(mock.server.commands)}`);
    });

    // ---- four enemies, one without a sprite
    await mock.setView(STATES.four());
    await page.waitForTimeout(500);
    await check(`${tag} combat (4 enemies): four slots in the band, a labelled silhouette for the missing sprite`, async () => {
      assertNoDocumentScroll(await documentSize(page));
      const slots = await page.evaluate(() => [...document.querySelectorAll('.combat-scene__slot--enemy')].map((s) => ({ kind: s.dataset.kind, ...s.getBoundingClientRect().toJSON() })));
      const band = (await measure(page, { scene: '.live-frame__scene' })).scene;
      if (slots.length !== 4) throw new Error(`expected 4 enemy slots, got ${slots.length}`);
      if (slots.filter((s) => s.kind === 'silhouette').length !== 1) throw new Error('expected exactly one silhouette');
      assertInside(band, Object.fromEntries(slots.map((s, i) => [`enemy${i}`, s])), band.width * 0.06);
    });
    await shot('6-combat-four-enemies');

    // ---- boss
    await mock.setView(STATES.boss());
    await page.waitForTimeout(600);
    await check(`${tag} combat (boss): retreat is locked, controls and sprites in place`, async () => {
      assertNoDocumentScroll(await documentSize(page));
      assertTapTargets(await tapTargets(page));
      if (!(await page.locator('.live-combat__retreat-button').isDisabled())) throw new Error('retreat should be disabled against a boss');
      await page.waitForFunction(() => [...document.querySelectorAll('.combat-scene img')].every((img) => img.complete && img.naturalWidth > 0));
      const slots = await page.locator('.combat-scene__slot').count();
      if (slots !== 2) throw new Error(`expected hero + boss, got ${slots} slots`);
    });
    const bossBaseline = await measure(page, stable);
    await check(`${tag} combat (boss): telegraph does not move controls`, async () => {
      const view = STATES.boss();
      view.combat.actors[1].windup = windup(12, 2);
      await mock.setView(view);
      await shot('7-combat-boss-telegraph');
      assertRectsStable(bossBaseline, await measure(page, stable), 0.5, 'boss telegraph');
    });

    // ---- back to exploring: the frame returns to the same rows
    await mock.setView(STATES.exploring());
    await page.waitForSelector('.live-frame[data-mode="explore"]');
    await page.waitForTimeout(400);
    await check(`${tag} back to exploring: same row table`, async () => assertRectsStable(exploringRows, await measure(page, ROWS), 0.5, 'frame rows'));
    await check(`${tag} no page errors`, async () => { if (pageErrors.length > 0) throw new Error(pageErrors.join('\n')); });
    await context.close();
  }
} finally {
  await browser.close();
  preview?.kill();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT_DIR}`);
process.exit(failed.length === 0 ? 0 : 1);
