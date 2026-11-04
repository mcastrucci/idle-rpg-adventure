/**
 * #157: the owner's phone flow, against real PostgreSQL and the production content. A character conquers Region 1 through
 * an actual live Matriarch victory (the `bossDefeated` effect committed with the checkpoint, never the debug or SQL
 * completion shortcut), optionally after dying to her once, returns to the Sanctuary and enters Region 2 in live.
 * Ordinary-location discoveries and the character level are the only seeded state.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { LiveConnection } from '@engine/live-kernel';
import { actors, AuthService, createDatabase, liveInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { characters } from '../characters/schema.ts';
import { rpgCompletedAreas } from '../expeditions/schema.ts';
import { recordDiscovery } from '../expeditions/progress.ts';
import { createRpgDatabase, createRpgServer } from '../index.ts';
import { liveDeaths } from './death-schema.ts';
import { createRpgLiveHost, startRpgLiveInstance } from './index.ts';
import type { RpgLiveHost } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for Region 2 live entry PostgreSQL tests');
const REGION_ONE = 'area:region_1';
const REGION_TWO = 'area:region_2';
const PUMP_STATION = 'loc:region_1.pump_station';
const HEART = 'loc:region_1.seed_vault_heart';
const PUMP_EXIT = 'exit:region_1.pump_station.vault_antechamber';
const HEART_EXIT = 'exit:region_1.vault_antechamber.seed_vault_heart';
const LANDING = 'loc:region_2.fracture_landing';
const token = () => randomBytes(32).toString('base64url');

interface Player { accountId: string; sessionToken: string; actorId: string }

describe.skipIf(!adminUrl)('Region 2 live entry after a real Region 1 conquest (real PostgreSQL, production content)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let auth: AuthService;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let live: RpgLiveHost;
  const databaseName = `region2_entry_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'region2-entry-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle;
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    auth = new AuthService(database, clock);
    live = createRpgLiveHost({ autoStart: false, nodeId: 'region2-entry', leaseMs: 30_000, graceMs: 60_000 });
    app = await createRpgServer(config, { clock, live });
    await app.listen({ host: '127.0.0.1', port: 0 });
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

  const headers = (who: Player) => ({ authorization: `Bearer ${who.sessionToken}` });
  function connection(): LiveConnection { return { id: randomUUID(), push: () => {} }; }
  async function player(): Promise<Player> {
    const session = await auth.guest(token());
    const hero = await database.db.transaction((tx) => createCharacterService(tx, content as never).create(session.accountId, { name: 'Region 2 hero' }));
    return { accountId: session.accountId, sessionToken: session.sessionToken, actorId: hero.actorId };
  }
  const setLevel = (who: Player, level: number) => database.db.update(characters)
    .set({ level, xp: 0, attributes: { STR: 40, AGI: 20, INT: 5, VIT: 60, SPI: 20 } }).where(eq(characters.actorId, who.actorId));
  async function discoverOrdinaryLocations(who: Player) {
    const world = (content as unknown as { world?: { areas?: { id: string; locations: string[] }[] } }).world;
    const region = world?.areas?.find((entry) => entry.id === REGION_ONE);
    if (!region) throw new Error('Region 1 is missing from the content bundle');
    await database.db.transaction(async (tx) => {
      for (const locationId of region.locations) await recordDiscovery(tx, clock, who.actorId, REGION_ONE, locationId);
    });
  }
  async function command(instanceId: string, who: Player, body: Record<string, unknown>) {
    return live.host().submit(instanceId, who.actorId, who.accountId, randomUUID(), body as never);
  }
  async function advance(until: () => boolean, maxMs = 120_000) {
    for (let elapsed = 0; elapsed < maxMs && !until(); elapsed += 500) { clock.advance(500); await live.host().pump(); }
    expect(until(), 'live instance did not reach the expected state').toBe(true);
  }
  /** Starts at the pump station, pulls the bulkhead lever, confirms the boss-room warning and fights the Matriarch to its end. */
  async function fightMatriarch(who: Player): Promise<string> {
    const instanceId = await startRpgLiveInstance(live, database, { actorIds: [who.actorId], area: REGION_ONE, location: PUMP_STATION });
    await live.host().attach(instanceId, who.actorId, who.accountId, connection());
    expect((await command(instanceId, who, { type: 'interact', hotspotId: 'bulkhead_lever' })).ack.status).toBe('applied');
    expect((await command(instanceId, who, { type: 'travel', exitId: PUMP_EXIT })).ack.status).toBe('applied');
    expect((await command(instanceId, who, { type: 'enterBossRoom', exitId: HEART_EXIT, confirm: false })).ack.status).toBe('applied');
    expect((await command(instanceId, who, { type: 'enterBossRoom', exitId: HEART_EXIT, confirm: true })).ack.status).toBe('applied');
    const entered = live.host().inspect(instanceId)?.state;
    expect(entered?.location).toBe(HEART);
    expect(entered?.phase).toBe('combat'); // the boss aggroes on entry
    await advance(() => live.host().inspect(instanceId)?.ticking === false || !live.host().has(instanceId));
    return instanceId;
  }

  it('lets a character who died to the Matriarch once, won, returned and re-entered, play Region 2 live', async () => {
    const who = await player();
    await discoverOrdinaryLocations(who);

    // 1. Die to the Matriarch at level 1 (a real heroDied effect, corpse record, closed 'defeated' instance).
    const lost = await fightMatriarch(who);
    const [lostRow] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, lost));
    expect(lostRow).toMatchObject({ status: 'closed', outcome: 'defeated' });
    expect(await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, who.actorId))).toHaveLength(1);
    expect(await database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, who.actorId))).toEqual([]);

    // 2. Win at a higher level (the owner was about level 8).
    await setLevel(who, 8);
    const won = await fightMatriarch(who);
    const [wonRow] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, won));
    expect(wonRow, 'level 8 run vs Matriarch').toMatchObject({ status: 'active' });
    const victory = live.host().inspect(won)?.state;
    expect(victory?.phase).toBe('exploring');
    expect((await database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, who.actorId))).map((row) => row.areaId)).toEqual([REGION_ONE]);

    // 3. Return to the Sanctuary from the boss room.
    expect((await command(won, who, { type: 'returnToSanctuary' })).ack.status).toBe('applied');
    await advance(() => !live.host().has(won));
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, won)))[0]).toMatchObject({ status: 'closed', outcome: 'returned' });
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]).toMatchObject({ activityState: 'none', activityId: null });

    // 4. Region 2 is offered and enterable through the HTTP routes the phone uses.
    const worldResponse = await app.inject({ method: 'GET', url: `/characters/${who.actorId}/world`, headers: headers(who) });
    expect(worldResponse.json<{ areas: { id: string; actions: { enterLive: boolean } }[] }>().areas)
      .toContainEqual(expect.objectContaining({ id: REGION_TWO, actions: expect.objectContaining({ enterLive: true }) }));
    const options = await app.inject({ method: 'GET', url: `/live/options/${who.actorId}`, headers: headers(who) });
    expect(options.json<{ areas: { id: string }[] }>().areas.map((area) => area.id)).toContain(REGION_TWO);
    const started = await app.inject({ method: 'POST', url: '/live/start', headers: headers(who),
      payload: { commandId: randomUUID(), actorId: who.actorId, areaId: REGION_TWO, supplies: [] } });
    expect(started.statusCode).toBe(200);
    const instanceId = started.json<{ instanceId: string }>().instanceId;

    // 5. The instance stays open at the landing: no evict, no close, still the actor's live activity.
    await live.host().attach(instanceId, who.actorId, who.accountId, connection());
    for (let i = 0; i < 40; i += 1) { clock.advance(500); await live.host().pump(); }
    const current = await app.inject({ method: 'GET', url: `/live/current/${who.actorId}`, headers: headers(who) });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ current: { instanceId, view: { phase: 'exploring', area: REGION_TWO, location: LANDING, canReturn: true } } });
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId)))[0]).toMatchObject({ status: 'active' });
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]).toMatchObject({ activityState: 'live', activityId: instanceId });
  }, 120_000);
});
