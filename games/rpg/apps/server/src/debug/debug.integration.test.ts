import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { compileContentDirectory } from '@engine/content-compiler';
import { actors, checkLedgerInvariants, createDatabase, getHoldings, ledgerBatches, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { and, eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { expeditions } from '../expeditions/schema.ts';
import { DebugToolsRefusedError } from './config.ts';
import type { RpgDebugToolsConfig } from './config.ts';
import { DEBUG_GRANT_SOURCE } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL debug tool tests');
const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';
const SWORD = 'item:rusty_sword';
const START_AT = 1_800_000_000_000;
const DEBUG: RpgDebugToolsConfig = { enabled: true, environment: 'test' };

interface Session { accountId: string; sessionToken: string }
interface Character { actorId: string; level: number; xp: number; attributes: Record<string, number>; unspentPoints: number; activityState: string }

describe.skipIf(!adminUrl)('debug/admin tools against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let config: ServerConfig;
  let directory: string;
  const databaseName = `debug_tools_test_${randomUUID().replaceAll('-', '')}`;
  // The base clock never moves on its own: only the debug time-travel offset advances app time.
  const base = new ManualClock(START_AT);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'debug-tools-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(compiled.bundle));
    const parsed = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(parsed);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(parsed.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...parsed, databaseUrl: url.toString(), roles: ['api'] };
    database = createRpgDatabase(config);
    await database.migrate();
    app = await createRpgServer(config, { clock: base, debug: DEBUG });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  async function guest(): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: randomBytes(32).toString('base64url') } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function hero(): Promise<{ session: Session; character: Character }> {
    const session = await guest();
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Debug hero' } } });
    expect(response.statusCode).toBe(201);
    return { session, character: response.json<Character>() };
  }
  function debugPost(session: Session, url: string, operation: string, payload: Record<string, unknown>, commandId: string = randomUUID()) {
    return app.inject({ method: 'POST', url, headers: headers(session), payload: { command_id: commandId, operation, payload } });
  }
  const grant = (session: Session, actorId: string, payload: Record<string, unknown>, commandId?: string) =>
    debugPost(session, `/debug/characters/${actorId}/grants`, 'debug.grant', { actorId, ...payload }, commandId);
  const setProgression = (session: Session, actorId: string, payload: Record<string, unknown>) =>
    debugPost(session, `/debug/characters/${actorId}/progression`, 'debug.setProgression', { actorId, ...payload });
  const recordProgress = (session: Session, actorId: string, payload: Record<string, unknown>) =>
    debugPost(session, `/debug/characters/${actorId}/world-progress`, 'debug.recordWorldProgress', { actorId, ...payload });
  const resetProgress = (session: Session, actorId: string, payload: Record<string, unknown> = {}) =>
    debugPost(session, `/debug/characters/${actorId}/world-progress/reset`, 'debug.resetWorldProgress', { actorId, ...payload });
  const advance = (session: Session, durationMs: number, commandId?: string) =>
    debugPost(session, '/debug/clock/advance', 'debug.clock.advance', { durationMs }, commandId);
  async function startExpedition(session: Session, actorId: string, durationMin: number, potions = 0) {
    return app.inject({ method: 'POST', url: '/expeditions', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'expedition.start', payload: { actorId,
        request: { areaId: REGION, activityId: HUNT, durationMin, paceBp: 10_000 },
        config: { consumables: potions ? [{ item: POTION, qty: potions }] : [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } } } });
  }
  async function holdings(actorId: string) { return database.db.transaction(tx => getHoldings(tx, actorId)); }
  async function invariants(actorIds: readonly string[], active: readonly string[] = []) {
    return database.db.transaction(tx => checkLedgerInvariants(tx, actorIds, active));
  }
  const qtyOf = (rows: Awaited<ReturnType<typeof holdings>>, match: (row: Awaited<ReturnType<typeof holdings>>[number]) => boolean) =>
    rows.filter(match).reduce((sum, row) => sum + row.qty, 0);

  it('refuses to boot with production configuration and serves no debug routes when disabled', async () => {
    // The guard throws before any database connection or route exists.
    await expect((async () => createRpgServer(config, { clock: base, debug: { enabled: true, environment: 'production' } }))()).rejects.toThrow(DebugToolsRefusedError);
    await expect((async () => createRpgServer(config, { clock: base, debug: { enabled: true, environment: 'qa', nodeEnv: 'production' } }))()).rejects.toThrow(DebugToolsRefusedError);
    const plain = await createRpgServer(config, { clock: base, debug: { enabled: false, environment: 'test' } });
    try {
      const session = (await plain.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: randomBytes(32).toString('base64url') } })).json<Session>();
      expect((await plain.inject({ url: '/debug/clock', headers: headers(session) })).statusCode).toBe(404);
      const response = await plain.inject({ method: 'POST', url: '/debug/clock/advance', headers: headers(session),
        payload: { command_id: randomUUID(), operation: 'debug.clock.advance', payload: { durationMs: 1000 } } });
      expect(response.statusCode).toBe(404);
    } finally { await plain.close(); }
  });

  it('requires authentication and owner-scoped characters', async () => {
    const { session, character } = await hero();
    const other = await guest();
    expect((await app.inject({ url: '/debug/clock' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/debug/characters/${character.actorId}/grants`,
      payload: { command_id: randomUUID(), operation: 'debug.grant', payload: { actorId: character.actorId, gold: 5 } } })).statusCode).toBe(401);
    const stolen = await grant(other, character.actorId, { gold: 5 });
    expect(stolen.statusCode).toBe(404);
    expect((await setProgression(other, character.actorId, { level: 2 })).statusCode).toBe(404);
    expect((await recordProgress(other, character.actorId, { completedAreas: [REGION] })).statusCode).toBe(404);
    expect((await resetProgress(other, character.actorId)).statusCode).toBe(404);
    expect(qtyOf(await holdings(character.actorId), row => row.asset.kind === 'currency')).toBe(0);
    // Route/payload mismatch and wrong operation never reach the dispatcher.
    expect((await debugPost(session, `/debug/characters/${character.actorId}/grants`, 'debug.grant', { actorId: randomUUID(), gold: 1 })).statusCode).toBe(400);
    expect((await debugPost(session, `/debug/characters/${character.actorId}/grants`, 'debug.setProgression', { actorId: character.actorId, gold: 1 })).statusCode).toBe(400);
  });

  it('grants gold, stacks and equipment once per command through the ledger', async () => {
    const { session, character } = await hero();
    const commandId = randomUUID();
    const payload = { gold: 250, items: [{ item: POTION, qty: 3 }, { item: SWORD, qty: 2 }] };
    const first = await grant(session, character.actorId, payload, commandId);
    expect(first.statusCode).toBe(200);
    const replay = await grant(session, character.actorId, payload, commandId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await grant(session, character.actorId, { gold: 999 }, commandId)).statusCode).toBe(409);
    const rows = await holdings(character.actorId);
    expect(qtyOf(rows, row => row.asset.kind === 'currency' && row.asset.currency === 'gold')).toBe(250);
    expect(qtyOf(rows, row => row.asset.kind === 'stack' && row.asset.item === POTION && row.container === 'inventory')).toBe(3);
    expect(rows.filter(row => row.asset.kind === 'unique' && row.definition === SWORD && row.container === 'inventory')).toHaveLength(2);
    const batches = await database.db.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, DEBUG_GRANT_SOURCE),
      eq(ledgerBatches.sourceId, `${session.accountId}:${commandId}`)));
    expect(batches).toHaveLength(1);
    expect(await invariants([character.actorId])).toEqual([]);

    expect((await grant(session, character.actorId, { items: [{ item: 'item:does_not_exist', qty: 1 }] })).json()).toEqual({ error: 'unknown_item' });
    expect((await grant(session, character.actorId, { items: [{ item: SWORD, qty: 11 }] })).statusCode).toBe(400);
    expect((await grant(session, character.actorId, {})).statusCode).toBe(400);
    expect((await grant(session, character.actorId, { gold: 0 })).statusCode).toBe(400);
  });

  it('sets level/XP against the content curve without touching attribute points', async () => {
    const { session, character } = await hero();
    const response = await setProgression(session, character.actorId, { level: 3, xp: 200 });
    expect(response.statusCode).toBe(200);
    const updated = response.json<Character>();
    expect([updated.level, updated.xp]).toEqual([3, 200]);
    expect(updated.attributes).toEqual(character.attributes);
    expect(updated.unspentPoints).toBe(character.unspentPoints);
    // Curve: 100, 250, 450, 700, 1000 → level 3 needs < 450 within the level; cap is level 6.
    expect((await setProgression(session, character.actorId, { level: 3, xp: 450 })).json()).toEqual({ error: 'invalid_progression' });
    expect((await setProgression(session, character.actorId, { level: 7 })).json()).toEqual({ error: 'invalid_progression' });
    expect((await setProgression(session, character.actorId, { level: 0 })).statusCode).toBe(400);
    expect((await setProgression(session, character.actorId, { level: 6, xp: 5_000 })).statusCode).toBe(200);
  });

  it('records and resets world progress through the trusted seams', async () => {
    const { session, character } = await hero();
    const options = async () => (await app.inject({ url: `/characters/${character.actorId}/expedition-options`, headers: headers(session) }))
      .json<{ areas: { areaId: string; activities: { activityId: string; available: boolean }[] }[] }>();
    const huntAvailable = async () => (await options()).areas.find(area => area.areaId === REGION)?.activities
      .find(activity => activity.activityId === HUNT)?.available;
    expect(await huntAvailable()).toBe(false);
    const recorded = await recordProgress(session, character.actorId, { completedAreas: [REGION],
      discoveries: [{ areaId: REGION, locationId: 'loc:region_1.portal_clearing' }], objectives: ['defeated:enemy:hollow_matriarch'] });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toEqual({ actorId: character.actorId, completedAreas: [REGION],
      discoveries: [{ areaId: REGION, locationId: 'loc:region_1.portal_clearing' }], objectives: ['defeated:enemy:hollow_matriarch'] });
    expect(await huntAvailable()).toBe(true);
    expect((await recordProgress(session, character.actorId, { completedAreas: ['area:nowhere'] })).json()).toEqual({ error: 'unknown_area' });
    expect((await recordProgress(session, character.actorId, { discoveries: [{ areaId: REGION, locationId: 'loc:sanctuary.hub' }] })).json())
      .toEqual({ error: 'unknown_location' });
    expect((await recordProgress(session, character.actorId, { objectives: ['defeated:enemy:nobody'] })).json()).toEqual({ error: 'unknown_enemy' });

    const scoped = await resetProgress(session, character.actorId, { areaId: REGION });
    expect(scoped.json()).toEqual({ actorId: character.actorId, completedAreas: [], discoveries: [], objectives: ['defeated:enemy:hollow_matriarch'] });
    expect(await huntAvailable()).toBe(false);
    expect((await resetProgress(session, character.actorId)).json()).toEqual({ actorId: character.actorId, completedAreas: [], discoveries: [], objectives: [] });
  });

  it('refuses mutations while the actor is on an activity', async () => {
    const { session, character } = await hero();
    expect((await recordProgress(session, character.actorId, { completedAreas: [REGION] })).statusCode).toBe(200);
    const started = await startExpedition(session, character.actorId, 15);
    expect(started.statusCode).toBe(201);
    expect((await grant(session, character.actorId, { gold: 10 })).json()).toEqual({ error: 'busy' });
    expect((await setProgression(session, character.actorId, { level: 2 })).json()).toEqual({ error: 'busy' });
    expect((await recordProgress(session, character.actorId, { objectives: ['story:test'] })).json()).toEqual({ error: 'busy' });
    expect((await resetProgress(session, character.actorId)).json()).toEqual({ error: 'busy' });
    expect(qtyOf(await holdings(character.actorId), row => row.asset.kind === 'currency')).toBe(0);
    const id = started.json<{ id: string }>().id;
    const cancelled = await app.inject({ method: 'POST', url: `/expeditions/${id}/cancel`, headers: headers(session),
      payload: { command_id: randomUUID(), operation: 'expedition.cancel', payload: { expeditionId: id } } });
    expect(cancelled.statusCode).toBe(200);
  });

  it('time travel is forward-only, bounded and idempotent per command', async () => {
    const { session } = await hero();
    const before = (await app.inject({ url: '/debug/clock', headers: headers(session) })).json<{ nowMs: number; offsetMs: number }>();
    const commandId = randomUUID();
    const first = await advance(session, 60_000, commandId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ advancedMs: 60_000, offsetMs: before.offsetMs + 60_000 });
    expect((await advance(session, 60_000, commandId)).json()).toMatchObject({ offsetMs: before.offsetMs + 60_000 });
    const after = (await app.inject({ url: '/debug/clock', headers: headers(session) })).json<{ nowMs: number; offsetMs: number }>();
    expect(after.offsetMs).toBe(before.offsetMs + 60_000);
    expect(after.nowMs).toBe(before.nowMs + 60_000);
    expect((await advance(session, -1)).statusCode).toBe(400);
    expect((await advance(session, 0)).statusCode).toBe(400);
    expect((await advance(session, 24 * 60 * 60 * 1000 + 1)).statusCode).toBe(400);
  });

  it('QA flow: a 180-minute expedition completes in seconds via time travel and a separate worker process', async () => {
    const startedAt = performance.now();
    // A separate worker "process" with its own time-travel clock proves the offset is shared through PostgreSQL.
    const worker = await createRpgServer({ ...config, roles: ['worker'] }, { clock: base, debug: DEBUG });
    try {
      const { session, character } = await hero();
      expect((await recordProgress(session, character.actorId, { completedAreas: [REGION] })).statusCode).toBe(200);
      expect((await grant(session, character.actorId, { items: [{ item: POTION, qty: 2 }] })).statusCode).toBe(200);
      const started = await startExpedition(session, character.actorId, 180, 2);
      expect(started.statusCode).toBe(201);
      const dto = started.json<{ id: string; state: string; plannedEndsAtMs: number; startsAtMs: number; outcome?: unknown; endsAtMs?: unknown }>();
      expect(dto.state).toBe('running');
      expect(dto.plannedEndsAtMs - dto.startsAtMs).toBe(180 * 60_000);
      expect(dto.outcome).toBeUndefined();
      expect(dto.endsAtMs).toBeUndefined();

      // Advance exactly to the planned end (the actual end can only be earlier). No lazy read happens until the
      // worker has settled the run on its own.
      const travel = await advance(session, dto.plannedEndsAtMs - dto.startsAtMs);
      expect(travel.statusCode).toBe(200);
      let row = (await database.db.select().from(expeditions).where(eq(expeditions.id, dto.id)))[0];
      const deadline = performance.now() + 10_000;
      while (row?.status === 'running' && performance.now() < deadline) {
        await delay(100);
        row = (await database.db.select().from(expeditions).where(eq(expeditions.id, dto.id)))[0];
      }
      expect(row?.status).toBe('completed');

      const read = await app.inject({ url: `/expeditions/${dto.id}`, headers: headers(session) });
      expect(read.statusCode).toBe(200);
      expect(read.json<{ state: string; outcome: unknown }>()).toMatchObject({ state: 'completed' });
      const [actor] = await database.db.select().from(actors).where(eq(actors.actorId, character.actorId));
      expect([actor?.activityState, actor?.activityId]).toEqual(['none', null]);
      const settlements = await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'expedition_settlement'));
      expect(settlements.filter(batch => batch.sourceId.startsWith(dto.id))).toHaveLength(1);
      // A second lazy read after settlement changes nothing.
      expect((await app.inject({ url: `/expeditions/${dto.id}`, headers: headers(session) })).json()).toEqual(read.json());
      expect(await invariants([character.actorId])).toEqual([]);
      expect(performance.now() - startedAt).toBeLessThan(20_000);
    } finally { await worker.close(); }
  }, 30_000);
});
