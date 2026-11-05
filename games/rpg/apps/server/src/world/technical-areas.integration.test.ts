import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandLog, createDatabase, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { recordAreaCompletion } from '../expeditions/progress.ts';
import { compileWorldViewFixture } from './test-content.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for technical area PostgreSQL tests');
const GROVE = 'area:test_grove';
const HUNT = 'idle:test_grove.hunt';
const IDLE_CONFIG = { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } };

interface Session { readonly accountId: string; readonly sessionToken: string }
type App = Awaited<ReturnType<typeof createRpgServer>>;

describe.skipIf(!adminUrl)('technical seed areas are hidden from players (#156, real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  const databaseName = `technical_areas_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_800_000_000_000);
  let nextIp = 120;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'technical-areas-'));
    const bundle = await compileWorldViewFixture(directory);
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
  }, 30_000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  async function player(app: App) {
    const guest = await app.inject({ method: 'POST', url: '/auth/guest', remoteAddress: `127.0.0.${nextIp++}`,
      payload: { deviceToken: randomBytes(32).toString('base64url') } });
    expect(guest.statusCode).toBe(200);
    const session = guest.json<Session>();
    const created = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Technical hero' } } });
    expect(created.statusCode).toBe(201);
    return { session, actorId: created.json<{ actorId: string }>().actorId };
  }
  const idleStart = (app: App, session: Session, actorId: string, commandId = randomUUID()) => app.inject({
    method: 'POST', url: '/expeditions', headers: headers(session), payload: { command_id: commandId, operation: 'expedition.start',
      payload: { actorId, request: { areaId: GROVE, activityId: HUNT, durationMin: 15, paceBp: 10_000 }, config: IDLE_CONFIG } } });
  const liveStart = (app: App, session: Session, actorId: string, commandId = randomUUID()) => app.inject({
    method: 'POST', url: '/live/start', headers: headers(session), payload: { commandId, actorId, areaId: GROVE, supplies: [] } });

  it('production configuration: the world view, options and starts never expose test_grove', async () => {
    const app = await createRpgServer(config, { clock });
    try {
      const { session, actorId } = await player(app);
      const world = await app.inject({ method: 'GET', url: `/characters/${actorId}/world`, headers: headers(session) });
      expect(world.statusCode).toBe(200);
      expect(world.body).not.toContain('test_grove');
      expect(world.json<{ areas: unknown[] }>().areas.length).toBeGreaterThan(0);

      // Even a completed technical area stays hidden everywhere.
      await database.db.transaction(tx => recordAreaCompletion(tx, clock, actorId, GROVE));
      expect((await app.inject({ method: 'GET', url: `/characters/${actorId}/world`, headers: headers(session) })).body).not.toContain('test_grove');
      const liveOptions = await app.inject({ method: 'GET', url: `/live/options/${actorId}`, headers: headers(session) });
      expect(liveOptions.body).not.toContain('test_grove');
      const idleOptions = await app.inject({ method: 'GET', url: `/characters/${actorId}/expedition-options`, headers: headers(session) });
      expect(idleOptions.statusCode).toBe(200);
      expect(idleOptions.body).not.toContain('test_grove');

      const liveId = randomUUID();
      const live = await liveStart(app, session, actorId, liveId);
      expect([live.statusCode, live.json()]).toEqual([400, { error: 'invalid_live_start' }]);
      expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, liveId))).toEqual([]);

      const idle = await idleStart(app, session, actorId);
      expect([idle.statusCode, idle.json()]).toEqual([400, { error: 'start.unknownArea' }]);
      const estimate = await app.inject({ method: 'POST', url: `/characters/${actorId}/expedition-estimate`, headers: headers(session),
        payload: { request: { areaId: GROVE, activityId: HUNT, durationMin: 15, paceBp: 10_000 }, config: IDLE_CONFIG } });
      expect([estimate.statusCode, estimate.json()]).toEqual([400, { error: 'start.unknownArea' }]);
    } finally { await app.close(); }
  }, 30_000);

  it('debug-enabled configuration: test_grove is visible and can be entered', async () => {
    const app = await createRpgServer(config, { clock, debug: { enabled: true, environment: 'staging' } });
    try {
      const { session, actorId } = await player(app);
      const world = await app.inject({ method: 'GET', url: `/characters/${actorId}/world`, headers: headers(session) });
      expect(world.json<{ areas: Array<{ id: string }> }>().areas.map(area => area.id)).toContain(GROVE);

      const liveOptions = await app.inject({ method: 'GET', url: `/live/options/${actorId}`, headers: headers(session) });
      expect(liveOptions.json<{ areas: Array<{ id: string }> }>().areas.map(area => area.id)).toContain(GROVE);
      const live = await liveStart(app, session, actorId);
      expect(live.statusCode).toBe(200);
    } finally { await app.close(); }
  }, 30_000);

  it('debug-enabled configuration: idle options list test_grove and its start is not refused as unknown', async () => {
    const app = await createRpgServer(config, { clock, debug: { enabled: true, environment: 'staging' } });
    try {
      const { session, actorId } = await player(app);
      const options = await app.inject({ method: 'GET', url: `/characters/${actorId}/expedition-options`, headers: headers(session) });
      expect(options.json<{ areas: Array<{ areaId: string }> }>().areas.map(area => area.areaId)).toContain(GROVE);
      const idle = await idleStart(app, session, actorId);
      expect(idle.json()).not.toEqual({ error: 'start.unknownArea' });
    } finally { await app.close(); }
  }, 30_000);
});
