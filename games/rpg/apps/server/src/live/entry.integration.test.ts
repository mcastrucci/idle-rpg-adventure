/** #97 entry/current acceptance across HTTP, the live host and authenticated WebSockets (real PostgreSQL). */
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { applyLedgerDeltas, actors, cleanupExpiredCommands, commandLog, createDatabase, liveInstances, liveSessions, ManualClock, parseServerConfig, runCommand } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { rpgLiveEntries } from '../telemetry/schema.ts';
import { recordAreaCompletion } from '../expeditions/progress.ts';
import { HIDDEN_FIXTURE, SECOND_LIVE_AREA, SECOND_LIVE_START, NONSTARTABLE_FIXTURE, compileWorldViewFixture } from '../world/test-content.ts';
import { createRpgLiveHost, prepareRpgLiveStart } from './index.ts';
import type { RpgLiveHost } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for live entry PostgreSQL tests');
const REGION = 'area:region_1';
const START_LOCATION = 'loc:region_1.portal_clearing';
const REGION_TWO = 'area:region_2';
const REGION_TWO_START = 'loc:region_2.fracture_landing';
const TRAVEL_EXIT = 'exit:region_1.portal_clearing.overgrown_causeway';
const POTION = 'item:minor_healing_potion';

interface Session { accountId: string; sessionToken: string }
interface Hero { actorId: string; accountId: string }
interface Node { app: Awaited<ReturnType<typeof createRpgServer>>; live: RpgLiveHost; url: string }
type Message = Record<string, unknown> & { type: string };

describe.skipIf(!adminUrl)('live entry/current acceptance (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  const databaseName = `live_entry_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(2_000_000_000_000);
  const nodes: Node[] = [];
  const sockets = new Set<WebSocket>();
  let nextIp = 1;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-entry-'));
    const compiled = await compileWorldViewFixture(directory);
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(compiled));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    for (const node of nodes) await node.app.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function node(nodeId: string): Promise<Node> {
    const live = createRpgLiveHost({ autoStart: false, nodeId, leaseMs: 30_000, graceMs: 60_000 });
    const app = await createRpgServer(config, { clock, live, seedSource: () => 7 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const created = { app, live, url: address.replace('http:', 'ws:') + '/auth/live' };
    nodes.push(created);
    return created;
  }

  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  async function guest(app: Node['app']): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', remoteAddress: `127.0.0.${nextIp++}`,
      payload: { deviceToken: randomBytes(32).toString('base64url') } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function hero(app: Node['app'], session: Session): Promise<Hero> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Live entry hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<Hero>();
  }
  async function fixture(n: Node, options: { potion?: number } = {}) {
    const session = await guest(n.app);
    const character = await hero(n.app, session);
    if (options.potion) await database.db.transaction(tx => applyLedgerDeltas(tx,
      { type: 'test_fixture', id: `${character.actorId}:live-entry` }, [
        { actorId: character.actorId, asset: { kind: 'stack', item: POTION }, qty: options.potion as number },
      ]));
    return { session, character };
  }
  async function start(n: Node, session: Session, character: Hero, commandId = randomUUID(), extra: Record<string, unknown> = {}) {
    return n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: {
      commandId, actorId: character.actorId, areaId: REGION, supplies: [], ...extra,
    } });
  }
  async function getCurrent(n: Node, session: Session, actorId: string) {
    return n.app.inject({ method: 'GET', url: `/live/current/${actorId}`, headers: headers(session) });
  }

  async function waitForLiveLeaseRelease(accountId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await database.db.select().from(liveSessions).where(eq(liveSessions.accountId, accountId));
      if (rows.length === 0) return;
      await delay(10);
    }
    throw new Error(`live session lease did not release for account ${accountId}`);
  }

  class Client {
    readonly socket: WebSocket;
    readonly inbox: Message[] = [];
    closeDetails = 'not closed';
    constructor(url: string, session: Session) {
      this.socket = new WebSocket(url, { headers: headers(session) });
      sockets.add(this.socket);
      this.socket.on('message', data => this.inbox.push(JSON.parse(data.toString()) as Message));
      this.socket.on('close', (code, reason) => { this.closeDetails = `${code}: ${reason.toString()}`; });
    }
    async wait(predicate: (message: Message) => boolean, timeoutMs = 5000): Promise<Message> {
      for (let waited = 0; waited < timeoutMs; waited += 5) {
        const index = this.inbox.findIndex(predicate);
        if (index >= 0) return this.inbox.splice(index, 1)[0] as Message;
        if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`socket closed before expected frame (${this.closeDetails})`);
        await delay(5);
      }
      throw new Error('timed out waiting for live frame');
    }
    async ready() { await this.wait(message => message.type === 'authenticated'); return this; }
    request(command: Record<string, unknown>) { this.socket.send(JSON.stringify({ type: 'command', command })); }
    async drop() { const closed = once(this.socket, 'close'); this.socket.terminate(); await closed; }
  }
  async function attach(client: Client, actorId: string, instanceId: string, resume?: { epoch: number; seq: number }) {
    client.request({ op: 'live.attach', actorId, instanceId, ...(resume ? { resume } : {}) });
    const messages: Message[] = [];
    while (!messages.some(message => message.type === 'live.attached') || !messages.some(message => message.type === 'live.snapshot')) {
      messages.push(await client.wait(message => message.type === 'live.attached' || message.type === 'live.snapshot'));
    }
    return messages.find(message => message.type === 'live.snapshot') as Message;
  }
  async function row(instanceId: string) {
    const [found] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId));
    if (!found) throw new Error(`missing live instance ${instanceId}`);
    return found;
  }
  async function activity(actorId: string) {
    const [found] = await database.db.select().from(actors).where(eq(actors.actorId, actorId));
    return found;
  }

  it('authorizes owner-only options/start/current, uses the server start snapshot, and resumes the authoritative scene over WS', async () => {
    const n = await node('entry-owner');
    const { session, character } = await fixture(n, { potion: 2 });
    const stranger = await guest(n.app);

    expect((await n.app.inject({ method: 'GET', url: `/live/options/${character.actorId}` })).statusCode).toBe(401);
    expect((await n.app.inject({ method: 'GET', url: `/live/options/${character.actorId}`, headers: headers(stranger) })).statusCode).toBe(404);
    expect((await n.app.inject({ method: 'GET', url: `/live/current/${character.actorId}`, headers: headers(stranger) })).statusCode).toBe(404);
    const optionsResponse = await n.app.inject({ method: 'GET', url: `/live/options/${character.actorId}`, headers: headers(session) });
    expect(optionsResponse.statusCode).toBe(200);
    expect(optionsResponse.json()).toMatchObject({ actorId: character.actorId,
      areas: [{ id: REGION, startLocationId: START_LOCATION }],
      supplies: [expect.objectContaining({ item: POTION, availableQty: 2 })] });

    const commandId = randomUUID();
    const startBody = { commandId, actorId: character.actorId, areaId: REGION, supplies: [] };
    expect((await n.app.inject({ method: 'POST', url: '/live/start', payload: startBody })).statusCode).toBe(401);
    expect((await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(stranger), payload: startBody })).statusCode).toBe(404);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toEqual([]);
    const duplicateSupplyId = randomUUID();
    const duplicateSupply = await start(n, session, character, duplicateSupplyId, { supplies: [
      { item: POTION, qty: 1 }, { item: POTION, qty: 1 },
    ] });
    expect(duplicateSupply.statusCode).toBe(400);
    expect(duplicateSupply.json()).toEqual({ error: 'invalid_command' });
    expect(await activity(character.actorId)).toMatchObject({ activityState: 'none', activityId: null });
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, duplicateSupplyId))).toEqual([]);
    const forged = await start(n, session, character, commandId, { location: 'loc:region_1.seed_vault_heart', seed: 9,
      equipment: [{ item: 'item:mythic_sword' }] });
    expect(forged.statusCode).toBe(400);
    expect(await activity(character.actorId)).toMatchObject({ activityState: 'none', activityId: null });

    const invalid = await start(n, session, character, commandId, { supplies: [{ item: POTION, qty: 3 }] });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const started = await start(n, session, character, commandId, { supplies: [{ item: POTION, qty: 1 }] });
    expect(started.statusCode).toBe(200);
    const instanceId = started.json<{ instanceId: string }>().instanceId;
    const current = await getCurrent(n, session, character.actorId);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ current: { instanceId, actorId: character.actorId,
      view: { area: REGION, location: START_LOCATION } } });
    expect(n.live.host().inspect(instanceId)?.state.heroes[0]?.consumables).toEqual([{ item: POTION, qty: 1 }]);

    const first = await new Client(n.url, session).ready();
    const initialSnapshot = await attach(first, character.actorId, instanceId);
    const cursor = { epoch: initialSnapshot['epoch'] as number, seq: initialSnapshot['seq'] as number };
    first.request({ op: 'live.command', actorId: character.actorId, instanceId, commandId: randomUUID(),
      command: { type: 'travel', exitId: TRAVEL_EXIT } });
    expect(await first.wait(message => message.type === 'live.ack')).toMatchObject({ status: 'applied' });
    expect(await first.wait(message => message.type === 'live.event' && (message['event'] as { type?: string })?.type === 'traveled'))
      .toMatchObject({ event: { type: 'traveled' } });
    const fresh = await getCurrent(n, session, character.actorId);
    expect(fresh.json()).toMatchObject({ current: { instanceId, view: { location: 'loc:region_1.overgrown_causeway' } } });
    await first.drop();
    await waitForLiveLeaseRelease(session.accountId);

    const resumed = await new Client(n.url, session).ready();
    resumed.request({ op: 'live.attach', actorId: character.actorId, instanceId, resume: cursor });
    expect(await resumed.wait(message => message.type === 'live.attached')).toMatchObject({ mode: 'resume' });
    expect(await resumed.wait(message => message.type === 'live.event' && (message['event'] as { type?: string })?.type === 'traveled'))
      .toMatchObject({ event: { type: 'traveled' } });
    expect((await getCurrent(n, session, character.actorId)).json()).toMatchObject({
      current: { instanceId, view: { location: 'loc:region_1.overgrown_causeway' } },
    });
  }, 30_000);

  it('offers and starts a second authored area only after persisted completion unlocks it', async () => {
    const n = await node('entry-multi-area');
    const { session, character } = await fixture(n);
    const otherSession = await guest(n.app);
    const worldUrl = `/characters/${character.actorId}/world`;
    const optionsUrl = `/live/options/${character.actorId}`;
    const beforeOptions = await n.app.inject({ method: 'GET', url: optionsUrl, headers: headers(session) });
    expect(beforeOptions.statusCode).toBe(200);
    expect(beforeOptions.body).not.toContain(SECOND_LIVE_AREA);
    expect(beforeOptions.body).not.toContain('area.live_fixture_two.name');
    expect(beforeOptions.body).not.toContain('area:test_grove');
    expect(beforeOptions.json<{ areas: Array<{ id: string }> }>().areas).toContainEqual(expect.objectContaining({ id: REGION }));
    const lockedWorld = await n.app.inject({ method: 'GET', url: worldUrl, headers: headers(session) });
    expect(lockedWorld.json<{ areas: Array<{ id: string; visibility: string; actions: { enterLive: boolean } }> }>().areas)
      .toContainEqual(expect.objectContaining({ id: SECOND_LIVE_AREA, visibility: 'locked', actions: expect.objectContaining({ enterLive: false }) }));

    const lockedCommandId = randomUUID();
    const locked = await start(n, session, character, lockedCommandId, { areaId: SECOND_LIVE_AREA });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toEqual({ error: 'region_locked' });
    expect(locked.body).not.toContain(SECOND_LIVE_AREA);
    expect(locked.body).not.toContain('area.live_fixture_two.name');
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, lockedCommandId))).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toEqual([]);

    await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
    const world = await n.app.inject({ method: 'GET', url: worldUrl, headers: headers(session) });
    expect(world.statusCode).toBe(200);
    expect(world.json<{ areas: Array<{ id: string; actions: { enterLive: boolean } }> }>().areas)
      .toContainEqual(expect.objectContaining({ id: SECOND_LIVE_AREA, actions: expect.objectContaining({ enterLive: true }) }));
    expect(world.body).not.toContain('area:test_grove'); // technical seed areas are hidden from players (#156)
    const unlockedOptions = await n.app.inject({ method: 'GET', url: optionsUrl, headers: headers(session) });
    expect(unlockedOptions.json<{ areas: Array<{ id: string; startLocationId: string }> }>().areas)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: SECOND_LIVE_AREA, startLocationId: SECOND_LIVE_START })]));
    expect(unlockedOptions.json<{ areas: Array<{ id: string }> }>().areas.map(area => area.id))
      .toEqual([SECOND_LIVE_AREA, REGION, REGION_TWO]);

    const foreignCommandId = randomUUID();
    const foreign = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(otherSession), payload: {
      commandId: foreignCommandId, actorId: character.actorId, areaId: SECOND_LIVE_AREA, supplies: [],
    } });
    expect(foreign.statusCode).toBe(404);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, foreignCommandId))).toEqual([]);
    const invalidAreaIds = ['area:sanctuary', 'area:missing_fixture', NONSTARTABLE_FIXTURE, 'area:test_grove'];
    for (const areaId of invalidAreaIds) {
      const commandId = randomUUID();
      const invalid = await start(n, session, character, commandId, { areaId });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'invalid_live_start' });
      expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, commandId))).toEqual([]);
    }
    expect(await activity(character.actorId)).toMatchObject({ activityState: 'none', activityId: null });
    const unknownId = randomUUID();
    const hiddenId = randomUUID();
    const unknown = await start(n, session, character, unknownId, { areaId: 'area:missing_fixture' });
    const hidden = await start(n, session, character, hiddenId, { areaId: HIDDEN_FIXTURE });
    expect([hidden.statusCode, hidden.json()]).toEqual([unknown.statusCode, unknown.json()]);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, unknownId))).toEqual([]);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, hiddenId))).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toEqual([]);
    expect(await activity(character.actorId)).toMatchObject({ activityState: 'none', activityId: null });

    const commandId = randomUUID();
    const body = { commandId, actorId: character.actorId, areaId: SECOND_LIVE_AREA, supplies: [] };
    const started = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(started.statusCode).toBe(200);
    const instanceId = started.json<{ instanceId: string }>().instanceId;
    expect((await getCurrent(n, session, character.actorId)).json())
      .toMatchObject({ current: { instanceId, view: { area: SECOND_LIVE_AREA, location: SECOND_LIVE_START } } });
    expect(await row(instanceId)).toMatchObject({ checkpoint: { state: { area: SECOND_LIVE_AREA, location: SECOND_LIVE_START } } });
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId)))
      .toMatchObject([{ instanceId, actorId: character.actorId, areaId: SECOND_LIVE_AREA }]);

    const replay = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ instanceId });
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId))).toHaveLength(1);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, commandId))).toHaveLength(1);

    const busyCommandId = randomUUID();
    const busy = await start(n, session, character, busyCommandId, { areaId: SECOND_LIVE_AREA });
    expect(busy.statusCode).toBe(409);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, busyCommandId))).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toHaveLength(1);

    const busyUnknownId = randomUUID();
    const busyHiddenId = randomUUID();
    const busyUnknown = await start(n, session, character, busyUnknownId, { areaId: 'area:missing_fixture' });
    const busyHidden = await start(n, session, character, busyHiddenId, { areaId: HIDDEN_FIXTURE });
    expect([busyHidden.statusCode, busyHidden.json()]).toEqual([busyUnknown.statusCode, busyUnknown.json()]);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, busyUnknownId))).toEqual([]);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, busyHiddenId))).toEqual([]);
  }, 30_000);

  it('replays the exact durable start after close, rejects changed payload, and preserves a tombstone conflict', async () => {
    const n = await node('entry-replay');
    const { session, character } = await fixture(n, { potion: 1 });
    const commandId = randomUUID();
    const body = { commandId, actorId: character.actorId, areaId: REGION, supplies: [] };
    const first = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(first.statusCode).toBe(200);
    const instanceId = first.json<{ instanceId: string }>().instanceId;
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId)))
      .toMatchObject([{ instanceId, actorId: character.actorId, areaId: REGION, startedAt: new Date(clock.nowMs()) }]);
    const client = await new Client(n.url, session).ready();
    await attach(client, character.actorId, instanceId);
    client.request({ op: 'live.command', actorId: character.actorId, instanceId, commandId: randomUUID(), command: { type: 'returnToSanctuary' } });
    expect(await client.wait(message => message.type === 'live.ack')).toMatchObject({ status: 'applied' });
    expect((await row(instanceId)).status).toBe('closed');

    const replay = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ instanceId });
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId)))).toHaveLength(1);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId))).toHaveLength(1);
    const changed = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: { ...body,
      supplies: [{ item: POTION, qty: 1 }] } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: 'command_id_conflict' });

    await database.db.update(commandLog).set({ expiresAt: new Date(clock.nowMs() - 1) })
      .where(and(eq(commandLog.accountId, session.accountId), eq(commandLog.commandId, commandId)));
    expect(await cleanupExpiredCommands(database, clock)).toBeGreaterThanOrEqual(1);
    const tombstoned = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(tombstoned.statusCode).toBe(410);
    expect(tombstoned.json()).toMatchObject({ error: 'command_expired' });
  }, 30_000);

  it('serializes same-key and start-vs-idle races to one durable instance per actor', async () => {
    const n = await node('entry-race');
    const { session, character } = await fixture(n);
    const sameId = randomUUID();
    const sameBody = { commandId: sameId, actorId: character.actorId, areaId: REGION, supplies: [] };
    const same = await Promise.all([1, 2].map(() => n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: sameBody })));
    expect(same.map(response => response.statusCode)).toEqual([200, 200]);
    expect(same[0]?.json()).toEqual(same[1]?.json());
    const instanceId = same[0]?.json<{ instanceId: string }>().instanceId;
    if (!instanceId) throw new Error('same-key starts returned no instance ID');
    expect(await database.db.select().from(liveInstances).where(and(eq(liveInstances.instanceId, instanceId), eq(liveInstances.status, 'active'))))
      .toHaveLength(1);

    const otherSession = await guest(n.app);
    const secondActor = await hero(n.app, otherSession);
    const results = await Promise.all([randomUUID(), randomUUID()].map(commandId => n.app.inject({ method: 'POST', url: '/live/start',
      headers: headers(otherSession), payload: { commandId, actorId: secondActor.actorId, areaId: REGION, supplies: [] } })));
    expect(results.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter(response => response.statusCode === 409)).toHaveLength(1);
    expect((await activity(secondActor.actorId))?.activityState).toBe('live');
    const ownedRows = await database.pool.query(`SELECT instance_id FROM live_instances WHERE status = 'active' AND participants @> $1::jsonb`,
      [JSON.stringify([{ actorId: secondActor.actorId }])]);
    expect(ownedRows.rows).toHaveLength(1);
  }, 30_000);

  it('rolls back before commit without a host phantom, then recovers a committed lost response on another node', async () => {
    const n = await node('entry-crash-a');
    const { session, character } = await fixture(n);
    const commandId = randomUUID();
    await database.pool.query(`CREATE FUNCTION fail_live_entry_telemetry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test forced live entry telemetry rollback'; END; $$`);
    await database.pool.query('CREATE TRIGGER fail_live_entry_telemetry BEFORE INSERT ON rpg_live_entries FOR EACH ROW EXECUTE FUNCTION fail_live_entry_telemetry()');
    const failed = await start(n, session, character, commandId);
    expect(failed.statusCode).toBe(500);
    expect((await activity(character.actorId))).toMatchObject({ activityState: 'none', activityId: null });
    const activeRows = await database.pool.query(`SELECT instance_id FROM live_instances WHERE status = 'active' AND participants @> $1::jsonb`,
      [JSON.stringify([{ actorId: character.actorId }])]);
    expect(activeRows.rows).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toEqual([]);
    expect(await database.db.select().from(commandLog).where(and(eq(commandLog.accountId, session.accountId), eq(commandLog.commandId, commandId))))
      .toEqual([]);
    await database.pool.query('DROP TRIGGER fail_live_entry_telemetry ON rpg_live_entries');
    await database.pool.query('DROP FUNCTION fail_live_entry_telemetry()');
    const successfulRetry = await start(n, session, character, commandId);
    expect(successfulRetry.statusCode).toBe(200);
    const createdId = successfulRetry.json<{ instanceId: string }>().instanceId;

    // Simulate the process dying after the command transaction committed but before its prepared runtime was adopted.
    // No special test-only production hook is needed: the production transaction-composition seam is the crash boundary.
    const crashedSession = await guest(n.app);
    const crashedActor = await hero(n.app, crashedSession);
    const crashCommandId = randomUUID();
    const preparedAndLease = await runCommand(database, clock, crashedSession.accountId, { commandId: crashCommandId, operation: 'live.start',
      payload: { actorId: crashedActor.actorId, areaId: REGION, supplies: [] } }, async tx => {
      const prepared = await prepareRpgLiveStart(tx, n.live, crashedSession.accountId, {
        actorId: crashedActor.actorId, areaId: REGION, supplies: [],
      });
      const lease = await n.live.createInTransaction(tx, prepared.input);
      return { status: 200, body: { instanceId: lease.instanceId } };
    });
    const lostId = (preparedAndLease.body as { instanceId: string }).instanceId;
    expect((await row(lostId)).status).toBe('active');
    expect((await activity(crashedActor.actorId))).toMatchObject({ activityState: 'live', activityId: lostId });
    // A fresh server has no adopted runtime and must not misrepresent the stale DB checkpoint as a live view.
    n.live.host().abandonForTesting(); // process-crash semantics: forget all runtime state without releasing its lease
    const n2 = await node('entry-crash-b');
    expect((await getCurrent(n2, crashedSession, crashedActor.actorId)).statusCode).toBe(409);
    const replay = await start(n2, crashedSession, crashedActor, crashCommandId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ instanceId: lostId });
    expect((await getCurrent(n2, crashedSession, crashedActor.actorId)).statusCode).toBe(409);
    clock.advance(30_001);
    expect(await n2.live.host().recoverExpired()).toContain(lostId);
    expect((await n2.live.host().inspect(lostId))?.state.location).toBe(START_LOCATION);
    expect((await getCurrent(n2, crashedSession, crashedActor.actorId)).json()).toMatchObject({ current: { instanceId: lostId,
      view: { location: START_LOCATION } } });
    expect((await row(lostId)).instanceId).toBe(lostId);
    expect(createdId).not.toBe(lostId);
  }, 30_000);

  it('unlocks the production Region 2 entry only after persisted Region 1 completion', async () => {
    const n = await node('entry-region-two');
    const { session, character } = await fixture(n);
    const otherOwner = await fixture(n);
    const optionsUrl = `/live/options/${character.actorId}`;
    const worldUrl = `/characters/${character.actorId}/world`;

    const lockedOptions = await n.app.inject({ method: 'GET', url: optionsUrl, headers: headers(session) });
    expect(lockedOptions.statusCode).toBe(200);
    expect(lockedOptions.json<{ areas: Array<{ id: string }> }>().areas.map(area => area.id)).toEqual([REGION]);
    expect((await n.app.inject({ method: 'GET', url: worldUrl, headers: headers(session) }))
      .json<{ areas: Array<{ id: string; visibility: string; actions: { enterLive: boolean } }> }>().areas)
      .toContainEqual(expect.objectContaining({ id: REGION_TWO, visibility: 'locked', actions: expect.objectContaining({ enterLive: false }) }));

    const lockedCommandId = randomUUID();
    const lockedStart = await start(n, session, character, lockedCommandId, { areaId: REGION_TWO });
    expect(lockedStart.statusCode).toBe(409);
    expect(lockedStart.json()).toEqual({ error: 'region_locked' });
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, lockedCommandId))).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, character.actorId))).toEqual([]);
    expect(await activity(character.actorId)).toMatchObject({ activityState: 'none', activityId: null });

    await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
    const unlockedOptions = await n.app.inject({ method: 'GET', url: optionsUrl, headers: headers(session) });
    expect(unlockedOptions.statusCode).toBe(200);
    expect(unlockedOptions.json<{ areas: Array<{ id: string; startLocationId: string }> }>().areas.map(area => area.id))
      .toEqual([SECOND_LIVE_AREA, REGION, REGION_TWO]);
    expect(unlockedOptions.json<{ areas: Array<{ id: string; startLocationId: string }> }>().areas)
      .toContainEqual(expect.objectContaining({ id: REGION_TWO, startLocationId: REGION_TWO_START }));
    expect((await n.app.inject({ method: 'GET', url: worldUrl, headers: headers(session) }))
      .json<{ areas: Array<{ id: string; visibility: string; actions: { enterLive: boolean } }> }>().areas)
      .toContainEqual(expect.objectContaining({ id: REGION_TWO, visibility: 'known', actions: expect.objectContaining({ enterLive: true }) }));

    const commandId = randomUUID();
    const body = { commandId, actorId: character.actorId, areaId: REGION_TWO, supplies: [] };
    const started = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(started.statusCode).toBe(200);
    const instanceId = started.json<{ instanceId: string }>().instanceId;
    expect(await row(instanceId)).toMatchObject({ checkpoint: { state: { area: REGION_TWO, location: REGION_TWO_START } } });
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId)))
      .toMatchObject([{ instanceId, actorId: character.actorId, areaId: REGION_TWO, startedAt: new Date(clock.nowMs()) }]);

    const replay = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ instanceId });
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.instanceId, instanceId))).toHaveLength(1);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, commandId))).toHaveLength(1);

    const foreignCommandId = randomUUID();
    const foreignStart = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(otherOwner.session), payload: {
      commandId: foreignCommandId, actorId: otherOwner.character.actorId, areaId: REGION_TWO, supplies: [],
    } });
    expect(foreignStart.statusCode).toBe(409);
    expect(foreignStart.json()).toEqual({ error: 'region_locked' });
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, foreignCommandId))).toEqual([]);
    expect(await database.db.select().from(rpgLiveEntries).where(eq(rpgLiveEntries.actorId, otherOwner.character.actorId))).toEqual([]);
    expect(await activity(otherOwner.character.actorId)).toMatchObject({ activityState: 'none', activityId: null });

    const foreignActorCommandId = randomUUID();
    const foreignActor = await n.app.inject({ method: 'POST', url: '/live/start', headers: headers(otherOwner.session), payload: {
      commandId: foreignActorCommandId, actorId: character.actorId, areaId: REGION_TWO, supplies: [],
    } });
    expect(foreignActor.statusCode).toBe(404);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.commandId, foreignActorCommandId))).toEqual([]);
  }, 30_000);
});
