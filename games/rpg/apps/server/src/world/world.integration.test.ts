import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { actors, commandLog, createDatabase, liveInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { recordAreaCompletion, recordObjective } from '../expeditions/progress.ts';
import { rpgAreaDiscoveries, rpgCompletedAreas, rpgActorObjectives } from '../expeditions/schema.ts';
import { compileWorldViewFixture, HIDDEN_FIXTURE, LOCKED_FIXTURE } from './test-content.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for world view PostgreSQL tests');
const REGION = 'area:region_1';

interface Session { readonly accountId: string; readonly sessionToken: string }
interface Hero { readonly actorId: string; readonly accountId: string }

describe.skipIf(!adminUrl)('server-owned world view (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  const databaseName = `world_map_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_800_000_000_000);
  let nextIp = 20;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'world-view-'));
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
  async function guest(app: Awaited<ReturnType<typeof createRpgServer>>): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', remoteAddress: `127.0.0.${nextIp++}`,
      payload: { deviceToken: randomBytes(32).toString('base64url') } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function hero(app: Awaited<ReturnType<typeof createRpgServer>>, session: Session): Promise<Hero> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Map test hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<Hero>();
  }

  it('authorizes the owner, filters locked live entry, hides private graph data, and reads frozen completion without writes', async () => {
    const app = await createRpgServer(config, { clock });
    try {
      const session = await guest(app);
      const character = await hero(app, session);
      const otherSession = await guest(app);
      const otherCharacter = await hero(app, otherSession);
      expect((await app.inject(`/characters/${character.actorId}/world`)).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: `/characters/${otherCharacter.actorId}/world`, headers: headers(session) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/characters/${randomUUID()}/world`, headers: headers(session) })).statusCode).toBe(404);

      const getWorld = () => app.inject({ method: 'GET', url: `/characters/${character.actorId}/world`, headers: headers(session) });
      const initial = await getWorld();
      expect(initial.statusCode).toBe(200);
      const initialDto = initial.json<{ areas: Array<Record<string, unknown>>; routes: Array<Record<string, unknown>> }>();
      expect(initial.body).not.toContain(HIDDEN_FIXTURE);
      expect(initial.body).not.toContain('private_name');
      expect(initial.body).not.toContain('99');
      expect(initialDto.areas.find(area => area['id'] === LOCKED_FIXTURE)).toMatchObject({ visibility: 'locked', lockedReasons: ['requires.game.levelAtLeast'] });
      expect(initialDto.routes.some(route => route['id'] === 'route:locked_to_hidden_fixture')).toBe(false);
      expect(initialDto.areas.some(area => area['id'] === HIDDEN_FIXTURE)).toBe(false);
      expect(initialDto.areas.find(area => area['id'] === REGION)).toMatchObject({
        visibility: 'locked',
        completion: { discovered: 0, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false,
          bosses: [{ label: 'Mandatory boss', defeated: false }] } },
        actions: { enterLive: false, startIdle: false },
      });

      const liveOptionsUrl = `/live/options/${character.actorId}`;
      const lockedOptions = await app.inject({ method: 'GET', url: liveOptionsUrl, headers: headers(session) });
      expect(lockedOptions.statusCode).toBe(200);
      expect(lockedOptions.json<{ areas: unknown[] }>().areas).toEqual([]);
      const commandId = randomUUID();
      const lockedStart = await app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: {
        commandId, actorId: character.actorId, areaId: REGION, supplies: [],
      } });
      expect(lockedStart.statusCode).toBe(409);
      expect(lockedStart.json()).toEqual({ error: 'region_locked' });
      expect(await database.db.select().from(liveInstances)).toEqual([]);
      expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, commandId))).toEqual([]);
      const [unchangedActor] = await database.db.select({ activityState: actors.activityState, activityId: actors.activityId })
        .from(actors).where(eq(actors.actorId, character.actorId));
      expect(unchangedActor).toMatchObject({ activityState: 'none', activityId: null });

      await database.db.transaction(tx => recordObjective(tx, clock, character.actorId, 'defeated:enemy:hollow_matriarch'));
      const bossDefeated = await getWorld();
      expect(bossDefeated.json().areas.find((area: { id: string }) => area.id === REGION)).toMatchObject({
        completion: { completed: false, mandatoryBosses: { required: 1, defeated: 1, complete: true,
          bosses: [{ label: 'enemy.hollow_matriarch.name', defeated: true }] } },
      });

      await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
      const before = await Promise.all([
        database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, character.actorId)),
        database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, character.actorId)),
        database.db.select().from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, character.actorId)),
      ]);
      const frozen = await getWorld();
      expect(frozen.statusCode).toBe(200);
      expect(frozen.json().areas.find((area: { id: string }) => area.id === REGION)).toMatchObject({
        visibility: 'locked', completion: { discovered: 0, required: 6, completed: true }, idle: { unlocked: false },
        actions: { enterLive: false, startIdle: false },
      });
      const after = await Promise.all([
        database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, character.actorId)),
        database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, character.actorId)),
        database.db.select().from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, character.actorId)),
      ]);
      expect(after).toEqual(before);

      await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, 'area:test_grove'));
      const unlockedMap = await getWorld();
      expect(unlockedMap.json().areas.find((area: { id: string }) => area.id === REGION))
        .toMatchObject({ visibility: 'known', actions: { enterLive: true } });
      const unlockedOptions = await app.inject({ method: 'GET', url: liveOptionsUrl, headers: headers(session) });
      expect(unlockedOptions.json<{ areas: Array<{ id: string }> }>().areas).toContainEqual(expect.objectContaining({ id: REGION }));
      const successfulStart = await app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: {
        commandId, actorId: character.actorId, areaId: REGION, supplies: [],
      } });
      expect(successfulStart.statusCode).toBe(200);
      const instanceId = successfulStart.json<{ instanceId: string }>().instanceId;
      expect(await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId))).toHaveLength(1);
      const [startedActor] = await database.db.select({ activityState: actors.activityState }).from(actors)
        .where(eq(actors.actorId, character.actorId));
      expect(startedActor?.activityState).toBe('live');
    } finally { await app.close(); }
  }, 30_000);
});
