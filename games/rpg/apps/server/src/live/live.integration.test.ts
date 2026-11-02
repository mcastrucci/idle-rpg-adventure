/**
 * Spike 3 (#13) adversarial tests: two live nodes (Fastify + `/auth/live` WebSocket) sharing one real PostgreSQL
 * database and one manual clock. A node "crash" drops its host without any write or lease release
 * (`abandonForTesting`), exactly what a `kill -9` leaves behind in PostgreSQL.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { ActivityConflictError } from '@engine/live-kernel';
import {
  actors, AuthService, createDatabase, liveInstances, ManualClock, parseServerConfig, PostgresInstanceStore, transitionActivity,
} from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createCharacterService } from '../characters/service.ts';
import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createRpgLiveHost, startRpgLiveInstance } from './index.ts';
import type { RpgLiveHost } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for live hosting integration tests');

// The Test Grove start location: returning to the Sanctuary is allowed there (open decision #17, provisional).
const LOCATION = 'loc:test_grove.entrance';
const SLIMES = { id: 'group:slimes', enemies: ['enemy:test_grove.slime'] };
const WARDENS = { id: 'group:wardens', enemies: ['enemy:test_grove.warden', 'enemy:test_grove.warden', 'enemy:test_grove.warden'] };
const GROUPS = [SLIMES, WARDENS];
const LEASE_MS = 30_000;
const GRACE_MS = 60_000;

type Message = Record<string, unknown> & { type: string };
interface Player { accountId: string; sessionToken: string; actorId: string; deviceToken: string }
interface Node { app: Awaited<ReturnType<typeof createRpgServer>>; live: RpgLiveHost; url: string }

describe.skipIf(!adminUrl)('live instance hosting under adversarial conditions (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: ReturnType<typeof compileBundle>;
  let auth: AuthService;
  const nodes: Node[] = [];
  const clients = new Set<Client>();
  const clock = new ManualClock(1_000_000);
  const databaseName = `live_test_${randomUUID().replaceAll('-', '')}`;

  function compileBundle() {
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    return compiled.bundle;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-integration-'));
    content = compileBundle();
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    // Stand-in for a ledger grant: the close hook commits one row per settled instance in the fenced close transaction.
    await database.pool.query('CREATE TABLE test_live_grants (instance_id uuid NOT NULL, outcome text NOT NULL)');
    auth = new AuthService(database, clock);
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) client.socket.terminate();
    for (const node of nodes) await node.app.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Activity-lock invariant: every `live` actor belongs to an active instance listing it as a participant that has not
    // left, and every such participant is `live` in exactly that instance.
    const orphans = await database.pool.query(`SELECT a.actor_id FROM actors a WHERE a.activity_state = 'live' AND NOT EXISTS (
      SELECT 1 FROM live_instances i WHERE i.instance_id = a.activity_id AND i.status = 'active')`);
    expect(orphans.rows).toEqual([]);
    const unlocked = await database.pool.query(`SELECT i.instance_id, p->>'actorId' AS actor_id FROM live_instances i,
      jsonb_array_elements(i.participants) p WHERE i.status = 'active' AND (p->>'left')::boolean = false AND NOT EXISTS (
      SELECT 1 FROM actors a WHERE a.actor_id = (p->>'actorId')::uuid AND a.activity_state = 'live' AND a.activity_id = i.instance_id)`);
    expect(unlocked.rows).toEqual([]);
    const grants = await database.pool.query('SELECT instance_id, count(*)::int AS n FROM test_live_grants GROUP BY instance_id HAVING count(*) > 1');
    expect(grants.rows).toEqual([]);
  });

  async function node(nodeId: string): Promise<Node> {
    const live = createRpgLiveHost({ autoStart: false, nodeId, leaseMs: LEASE_MS, graceMs: GRACE_MS, hooks: {
      onClose: async (tx, instance, input) => {
        await tx.execute(sql`INSERT INTO test_live_grants (instance_id, outcome) VALUES (${instance.instanceId}, ${input.outcome})`);
      },
    } });
    const app = await createRpgServer(config, { clock, live });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const created = { app, live, url: address.replace('http:', 'ws:') + '/auth/live' };
    nodes.push(created);
    return created;
  }

  async function player(): Promise<Player> {
    const deviceToken = randomBytes(32).toString('base64url');
    const session = await auth.guest(deviceToken);
    const character = await database.db.transaction((tx) => createCharacterService(tx, content as never).create(session.accountId, { name: 'Spike hero' }));
    return { accountId: session.accountId, sessionToken: session.sessionToken, actorId: character.actorId, deviceToken };
  }

  class Client {
    readonly socket: WebSocket;
    readonly inbox: Message[] = [];
    epoch = 0;
    seq = 0;
    readonly seqs: number[] = [];
    readonly who: Player;
    pongs = 0;
    closed = '';
    constructor(url: string, who: Player) {
      this.who = who;
      this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${who.sessionToken}` } });
      clients.add(this);
      this.socket.on('close', (code, reason) => { this.closed = `${code} ${reason.toString()}`; });
      this.socket.on('message', (data) => {
        const text = data.toString();
        if (text === 'pong') { this.pongs += 1; return; }
        const message = JSON.parse(text) as Message;
        if (message.type === 'live.snapshot') { this.epoch = message['epoch'] as number; this.seq = message['seq'] as number; }
        if (message.type === 'live.event') {
          // Clients drop anything already seen: duplicates would show up as a non-increasing seq.
          this.seqs.push(message['seq'] as number);
          this.epoch = message['epoch'] as number; this.seq = message['seq'] as number;
        }
        this.inbox.push(message);
      });
    }
    async ready(): Promise<this> { await this.waitFor((m) => m.type === 'authenticated'); return this; }
    async waitFor(predicate: (message: Message) => boolean, timeoutMs = 5000): Promise<Message> {
      for (let waited = 0; waited < timeoutMs; waited += 5) {
        const index = this.inbox.findIndex(predicate);
        if (index >= 0) return this.inbox.splice(index, 1)[0] as Message;
        if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`socket closed while waiting (${this.closed})`);
        await delay(5);
      }
      throw new Error('timed out waiting for message');
    }
    async request(command: Record<string, unknown>): Promise<Message> {
      this.socket.send(JSON.stringify({ type: 'command', command }));
      return this.waitFor((m) => m.type === 'live.attached' || m.type === 'live.ack' || m.type === 'live.error');
    }
    attach(instanceId: string, resume?: { epoch: number; seq: number }) {
      return this.request({ op: 'live.attach', instanceId, actorId: this.who.actorId, ...(resume ? { resume } : {}) });
    }
    command(instanceId: string, command: Record<string, unknown>, commandId: string = randomUUID()) {
      return this.request({ op: 'live.command', instanceId, actorId: this.who.actorId, commandId, command });
    }
    /** Waits for the pong so pings never outrun the server's bounded frame queue (it closes the socket at 8 pending). */
    async ping(timeoutMs = 5000): Promise<void> {
      if (this.socket.readyState !== WebSocket.OPEN) return;
      const expected = this.pongs + 1;
      this.socket.send('ping');
      for (let waited = 0; this.pongs < expected; waited += 2) {
        if (this.socket.readyState !== WebSocket.OPEN) return;
        if (waited >= timeoutMs) throw new Error('timed out waiting for pong');
        await delay(2);
      }
    }
    async drop(): Promise<void> {
      const closed = once(this.socket, 'close');
      this.socket.terminate(); await closed; await delay(20);
    }
  }
  const connect = (n: Node, who: Player) => new Client(n.url, who).ready();

  /** Advances the shared clock in small steps, keeping connected sockets' account leases alive and pumping hosts. */
  async function advance(ms: number, hosts: readonly Node[], until?: () => boolean): Promise<void> {
    for (let elapsed = 0; elapsed < ms && !(until?.() ?? false); elapsed += 1000) {
      clock.advance(1000);
      for (const client of clients) await client.ping();
      for (const h of hosts) await h.live.host().pump();
    }
  }
  async function row(instanceId: string) {
    const [found] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId));
    if (!found) throw new Error('missing instance row');
    return found;
  }
  async function activity(actorId: string) {
    const [found] = await database.db.select().from(actors).where(eq(actors.actorId, actorId));
    return found?.activityState;
  }

  it('reconnect within grace: missed events delivered once, consistent state, replayed command_id applies once', async () => {
    const nodeA = await node('node-reconnect');
    const [a, b] = [await player(), await player()];
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId, b.actorId], location: LOCATION, groups: GROUPS });
    const ca = await connect(nodeA, a); const cb = await connect(nodeA, b);
    expect(await ca.attach(instanceId)).toMatchObject({ type: 'live.attached', mode: 'snapshot' });
    expect(await cb.attach(instanceId)).toMatchObject({ type: 'live.attached', mode: 'snapshot' });
    const engageId = randomUUID();
    expect(await ca.command(instanceId, { type: 'engage', groupId: SLIMES.id }, engageId)).toMatchObject({ status: 'applied', duplicate: false });
    await advance(2000, [nodeA]);
    const seen = { epoch: ca.epoch, seq: ca.seq };
    await ca.drop();
    await advance(5000, [nodeA]); // the fight goes on while A is disconnected (no pause)
    const host = nodeA.live.host();
    expect(host.inspect(instanceId)?.participants).toContainEqual({ actorId: a.actorId, status: 'disconnected' });
    const ca2 = await connect(nodeA, a);
    expect(await ca2.attach(instanceId, seen)).toMatchObject({ type: 'live.attached', mode: 'resume' });
    const current = host.inspect(instanceId)?.seq ?? 0;
    await ca2.waitFor(() => ca2.seq === current);
    // Exactly the missed range, contiguous, no duplicates.
    expect(ca2.seqs).toEqual(Array.from({ length: current - seen.seq }, (_, i) => seen.seq + 1 + i));
    expect(await ca2.command(instanceId, { type: 'engage', groupId: SLIMES.id }, engageId)).toMatchObject({ status: 'applied', duplicate: true });
    expect(host.inspect(instanceId)?.state.encounters).toBe(1);
    await advance(60_000, [nodeA], () => host.inspect(instanceId)?.ticking === false);
    expect(host.inspect(instanceId)?.state.visited[LOCATION]?.groups.find((g) => g.id === SLIMES.id)?.defeated).toBe(true);
    // Both clients converge on the same state through events.
    expect(cb.seq).toBe(host.inspect(instanceId)?.seq);
    expect(ca2.seq).toBe(cb.seq);
    expect(await cb.command(instanceId, { type: 'returnToSanctuary' })).toMatchObject({ status: 'applied' });
    expect((await row(instanceId)).status).toBe('closed');
    expect(await activity(a.actorId)).toBe('none');
    expect(await activity(b.actorId)).toBe('none');
  }, 30_000);

  it('disconnecting during a losing fight still ends in death (no pause exploit)', async () => {
    const nodeA = await node('node-death');
    const a = await player();
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: GROUPS });
    const ca = await connect(nodeA, a);
    await ca.attach(instanceId);
    expect(await ca.command(instanceId, { type: 'engage', groupId: WARDENS.id })).toMatchObject({ status: 'applied' });
    const disconnectedAt = clock.nowMs();
    await ca.drop();
    await advance(GRACE_MS, [nodeA], () => !nodeA.live.host().has(instanceId));
    expect(nodeA.live.host().has(instanceId)).toBe(false);
    const closed = await row(instanceId);
    expect(closed).toMatchObject({ status: 'closed', outcome: 'defeated' });
    expect(clock.nowMs() - disconnectedAt).toBeLessThan(GRACE_MS); // died on automation, inside the grace window
    expect(await activity(a.actorId)).toBe('none');
    const grants = await database.pool.query('SELECT outcome FROM test_live_grants WHERE instance_id = $1', [instanceId]);
    expect(grants.rows).toEqual([{ outcome: 'defeated' }]);
  }, 30_000);

  it('crash mid-exploration: another node restores from the last checkpoint after lease expiry, no duplicated grants', async () => {
    const nodeA = await node('node-crash-a'); const nodeB = await node('node-crash-b');
    const a = await player();
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: GROUPS });
    const ca = await connect(nodeA, a);
    await ca.attach(instanceId);
    await ca.command(instanceId, { type: 'engage', groupId: SLIMES.id });
    await advance(60_000, [nodeA], () => nodeA.live.host().inspect(instanceId)?.ticking === false);
    const beforeCrash = nodeA.live.host().inspect(instanceId)?.state;
    expect(beforeCrash?.visited[LOCATION]?.groups.find((g) => g.id === SLIMES.id)?.defeated).toBe(true);
    const staleHost = nodeA.live.host();
    staleHost.abandonForTesting(); // kill -9: no checkpoint, no lease release
    await ca.drop();
    const cb = await connect(nodeB, a);
    expect(await cb.attach(instanceId)).toMatchObject({ type: 'live.error', error: 'instance_unavailable' }); // lease still held
    await advance(LEASE_MS, [nodeB]);
    expect(await cb.attach(instanceId)).toMatchObject({ type: 'live.attached', mode: 'snapshot' });
    const snapshot = await cb.waitFor((m) => m.type === 'live.snapshot');
    expect(snapshot).toMatchObject({ epoch: 2, view: { phase: 'exploring', groups: [{ id: SLIMES.id, defeated: true }, { id: WARDENS.id, defeated: false }] } });
    expect(nodeB.live.host().inspect(instanceId)?.state.heroes).toEqual(beforeCrash?.heroes);
    expect(await cb.command(instanceId, { type: 'returnToSanctuary' })).toMatchObject({ status: 'applied' });
    const grants = await database.pool.query('SELECT outcome FROM test_live_grants WHERE instance_id = $1', [instanceId]);
    expect(grants.rows).toEqual([{ outcome: 'returned' }]);
    expect(await nodeA.live.host().recover(instanceId)).toBe(false); // closed: nothing left to restore or settle
    expect(await activity(a.actorId)).toBe('none');
  }, 30_000);

  it('crash mid-combat: combat restarts from the pre-combat checkpoint on the new node', async () => {
    const nodeA = await node('node-combat-a'); const nodeB = await node('node-combat-b');
    const a = await player();
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: GROUPS });
    const ca = await connect(nodeA, a);
    await ca.attach(instanceId);
    await ca.command(instanceId, { type: 'engage', groupId: SLIMES.id });
    await advance(2000, [nodeA]);
    const midFight = nodeA.live.host().inspect(instanceId)?.state.combat;
    expect(midFight?.tick).toBeGreaterThan(0);
    expect(midFight?.outcome).toBeNull();
    nodeA.live.host().abandonForTesting();
    await ca.drop();
    await advance(LEASE_MS, [nodeB]);
    expect(await nodeB.live.host().recoverExpired()).toEqual([instanceId]);
    const restored = nodeB.live.host().inspect(instanceId);
    expect(restored?.ticking).toBe(true);
    expect(restored?.state.combat?.tick).toBe(0);
    expect(restored?.state.combat?.actors.filter((x) => x.side === 'enemy').every((x) => x.hp === x.stats.maxHp)).toBe(true);
    expect(restored?.state.encounters).toBe(1);
    // The disconnected hero keeps fighting on automation and wins on the new node.
    await advance(60_000, [nodeB], () => nodeB.live.host().inspect(instanceId)?.ticking === false);
    expect(nodeB.live.host().inspect(instanceId)?.state.visited[LOCATION]?.groups.find((g) => g.id === SLIMES.id)?.defeated).toBe(true);
    expect((await row(instanceId)).leaseGeneration).toBe(2);
    const cb = await connect(nodeB, a);
    await cb.attach(instanceId);
    await cb.command(instanceId, { type: 'returnToSanctuary' });
    expect((await row(instanceId)).status).toBe('closed');
  }, 30_000);

  it('live holds the activity lock: no expedition, no second instance, no Sanctuary mutation, one device per account', async () => {
    const nodeA = await node('node-locks');
    const a = await player();
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: GROUPS });
    expect(await activity(a.actorId)).toBe('live');
    // Starting an expedition is the CAS none → expedition, which loses while live.
    const expedition = await database.db.transaction((tx) => transitionActivity(tx, a.actorId, { state: 'none', activityId: null },
      { state: 'expedition', activityId: randomUUID() }));
    expect(expedition).toBeNull();
    await expect(startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: GROUPS }))
      .rejects.toBeInstanceOf(ActivityConflictError);
    expect(await database.db.select().from(liveInstances).where(sql`${liveInstances.participants} @> ${JSON.stringify([{ actorId: a.actorId }])}::jsonb`))
      .toHaveLength(1);
    const device1 = await connect(nodeA, a);
    expect(await device1.request({ op: 'live.attach', instanceId: 'not-a-uuid', actorId: a.actorId })).toMatchObject({ error: 'invalid_live_command' });
    expect(await device1.request({ op: 'live.attach', instanceId, actorId: a.actorId, resume: { epoch: -1, seq: 0 } }))
      .toMatchObject({ error: 'invalid_live_command' });
    expect(await device1.request({ op: 'live.command', instanceId, actorId: a.actorId, commandId: randomUUID(),
      command: { type: 'returnToSanctuary' }, stateAfter: {} })).toMatchObject({ error: 'invalid_live_command' });
    // Another account can neither attach to nor command someone else's participant.
    const intruder = await connect(nodeA, await player());
    expect(await intruder.request({ op: 'live.attach', instanceId, actorId: a.actorId })).toMatchObject({ error: 'not_participant' });
    expect(await intruder.request({ op: 'live.command', instanceId, actorId: a.actorId, commandId: randomUUID(),
      command: { type: 'returnToSanctuary' } })).toMatchObject({ error: 'not_participant' });
    // REST/WS character mutations are rejected while the live lock is held.
    device1.socket.send(JSON.stringify({ type: 'command', command: { command_id: randomUUID(), operation: 'character.configure',
      payload: { actorId: a.actorId, configuration: { name: 'Renamed mid-run' } } } }));
    expect(await device1.waitFor((m) => m.type === 'command.result')).toMatchObject({ status: 409, body: { error: 'busy' } });
    // A second device of the same account (another session) is refused while the first holds the live session lease.
    const otherSession = await auth.guest(a.deviceToken); // same account, independent session token
    expect(otherSession.accountId).toBe(a.accountId);
    const device2 = new Client(nodeA.url, { ...a, sessionToken: otherSession.sessionToken });
    const [code] = await once(device2.socket, 'close') as [number];
    expect(code).toBe(4409);
    expect(await device1.attach(instanceId)).toMatchObject({ type: 'live.attached' });
    expect(await device1.command(instanceId, { type: 'returnToSanctuary' })).toMatchObject({ status: 'applied' });
    expect(await activity(a.actorId)).toBe('none');
  }, 30_000);

  it('fencing: a stale node cannot write a checkpoint, renew, release or close after losing its lease', async () => {
    const a = await player();
    const store = new PostgresInstanceStore(database);
    const now = clock.nowMs();
    const instanceId = randomUUID();
    const stale = await store.create({ instanceId, gameId: 'test', gameVersion: '1', contentHash: 'h', nodeId: 'stale',
      participants: [{ actorId: a.actorId, accountId: a.accountId, left: false }], checkpoint: { v: 0 }, nowMs: now, leaseMs: LEASE_MS });
    const first = await store.checkpoint(stale, { v: 1 }, now + 1);
    expect(first?.checkpointSeq).toBe(1);
    if (!first) throw new Error('unreachable');
    // A replayed write with the old sequence is refused even while the lease is valid.
    expect(await store.checkpoint(stale, { v: 'replayed' }, now + 2)).toBeNull();
    expect(await store.claim(instanceId, 'fresh', now + 3, LEASE_MS)).toBeNull(); // lease still valid
    const later = now + LEASE_MS + 10;
    const claimed = await store.claim(instanceId, 'fresh', later, LEASE_MS);
    expect(claimed?.lease).toMatchObject({ nodeId: 'fresh', generation: 2, checkpointSeq: 1 });
    expect(claimed?.record.checkpoint).toEqual({ v: 1 });
    expect(await store.checkpoint(first, { v: 'stale' }, later + 1)).toBeNull();
    expect(await store.renew(first, later + 1, LEASE_MS)).toBe(false);
    expect(await store.releaseParticipant(first, a.actorId, { v: 'stale' }, later + 1)).toBeNull();
    expect(await store.close(first, { outcome: 'stale', result: null, checkpoint: { v: 'stale' } }, later + 1)).toBe(false);
    expect(await activity(a.actorId)).toBe('live');
    expect(await row(instanceId)).toMatchObject({ status: 'active', nodeId: 'fresh', checkpointSeq: 1, checkpoint: { v: 1 } });
    if (!claimed) throw new Error('unreachable');
    expect(await store.close(claimed.lease, { outcome: 'done', result: null, checkpoint: { v: 2 } }, later + 2)).toBe(true);
    expect(await activity(a.actorId)).toBe('none');

    // Same through hosts and the socket: a paused node is evicted on its next action and its client told so.
    const nodeA = await node('node-fence-a'); const nodeB = await node('node-fence-b');
    const p = await player();
    const live = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [p.actorId], location: LOCATION, groups: GROUPS });
    const ca = await connect(nodeA, p);
    await ca.attach(live);
    await advance(LEASE_MS + 1000, []); // node A's host paused (no pump, no renewal); the account socket stays alive
    expect(await nodeB.live.host().recover(live)).toBe(true);
    expect(await ca.command(live, { type: 'engage', groupId: SLIMES.id })).toMatchObject({ type: 'live.error', error: 'not_hosted' });
    expect(await ca.waitFor((m) => m.type === 'live.evicted')).toMatchObject({ reason: 'lease_lost' });
    expect(nodeA.live.host().has(live)).toBe(false);
    expect((await row(live)).nodeId).toBe('node-fence-b');
    await ca.drop();
    const cb = await connect(nodeB, p);
    await cb.attach(live);
    await cb.command(live, { type: 'returnToSanctuary' });
  }, 30_000);

  // -------------------------------------------------------------------------------------------------------------------
  // Exploration state machine (#38) on the real Region 1 content
  // -------------------------------------------------------------------------------------------------------------------

  const R1 = (name: string) => `loc:region_1.${name}`;
  const EXIT = (from: string, to: string) => `exit:region_1.${from}.${to}`;
  const travel = (exitId: string) => ({ type: 'travel', exitId });
  async function discoveries(actorIds: readonly string[]): Promise<{ actor_id: string; location_id: string }[]> {
    const result = await database.pool.query<{ actor_id: string; location_id: string }>(`SELECT actor_id::text, location_id
      FROM rpg_area_discoveries WHERE actor_id = ANY($1::uuid[]) ORDER BY actor_id, location_id`, [actorIds]);
    return result.rows;
  }
  async function rejected(client: Client, instanceId: string, command: Record<string, unknown>, reason: string): Promise<void> {
    expect(await client.command(instanceId, command)).toMatchObject({ type: 'live.ack', status: 'rejected', reason });
  }
  async function applied(client: Client, instanceId: string, command: Record<string, unknown>): Promise<void> {
    expect(await client.command(instanceId, command)).toMatchObject({ type: 'live.ack', status: 'applied' });
  }
  const gameEvent = (type: string) => (m: Message) => m.type === 'live.event' && (m['event'] as { type?: unknown }).type === type;

  it('exploration: rejects invalid commands and records each discovery once per participant present, with the checkpoint', async () => {
    const n = await node('node-explore');
    const [a, b] = [await player(), await player()];
    const host = n.live.host();
    const instanceId = await startRpgLiveInstance(host, database, { actorIds: [a.actorId, b.actorId], area: 'area:region_1' });
    const ca = await connect(n, a); const cb = await connect(n, b);
    await ca.attach(instanceId); await cb.attach(instanceId);
    expect(await ca.waitFor((m) => m.type === 'live.snapshot')).toMatchObject({ view: { phase: 'exploring', location: R1('portal_clearing'),
      exits: [{ id: EXIT('portal_clearing', 'overgrown_causeway'), open: true }] } });
    await rejected(ca, instanceId, travel('exit:nowhere'), 'unknown_exit');
    await rejected(ca, instanceId, travel(EXIT('old_well', 'glowcap_grotto')), 'unknown_exit');
    await rejected(ca, instanceId, { type: 'travel' }, 'malformed');
    await rejected(ca, instanceId, { type: 'retreat' }, 'not_in_combat');
    // Nothing durable yet: the start-location discovery waits for the first checkpoint.
    expect(await discoveries([a.actorId, b.actorId])).toEqual([]);

    await applied(ca, instanceId, travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(await cb.waitFor(gameEvent('discovered'))).toMatchObject({ event: { locationId: R1('overgrown_causeway'),
      actorIds: [a.actorId, b.actorId].sort() } });
    const expected = (actorId: string) => [R1('overgrown_causeway'), R1('portal_clearing')].map((location_id) => ({ actor_id: actorId, location_id }));
    const both = [...expected(a.actorId), ...expected(b.actorId)].sort((x, y) => (x.actor_id < y.actor_id ? -1 : x.actor_id > y.actor_id ? 1 : 0));
    expect(await discoveries([a.actorId, b.actorId])).toEqual(both);
    expect((await row(instanceId)).checkpointSeq).toBe(1); // committed with the travel checkpoint

    // Going back and forth discovers nothing new.
    await applied(cb, instanceId, travel(EXIT('overgrown_causeway', 'portal_clearing')));
    await applied(cb, instanceId, travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(await discoveries([a.actorId, b.actorId])).toEqual(both);

    // Combat locks exploration commands; returning is refused outside safe/start locations.
    await rejected(ca, instanceId, { type: 'returnToSanctuary' }, 'not_safe_location');
    const group = host.inspect(instanceId)?.state.visited[R1('overgrown_causeway')]?.groups[0]?.id ?? '';
    await applied(ca, instanceId, { type: 'engage', groupId: group });
    await rejected(cb, instanceId, travel(EXIT('overgrown_causeway', 'old_well')), 'in_combat');
    await rejected(cb, instanceId, { type: 'returnToSanctuary' }, 'in_combat');
    await rejected(cb, instanceId, { type: 'gather', nodeId: 'res:glowcap#0' }, 'in_combat');
    // Retreat (provisional #18): back to the portal clearing, the group stays.
    await applied(cb, instanceId, { type: 'retreat' });
    expect(host.inspect(instanceId)?.state).toMatchObject({ phase: 'exploring', location: R1('portal_clearing') });
    expect(host.inspect(instanceId)?.state.visited[R1('overgrown_causeway')]?.groups[0]?.defeated).toBe(false);
    await applied(ca, instanceId, { type: 'returnToSanctuary' });
    expect(await row(instanceId)).toMatchObject({ status: 'closed', outcome: 'returned' });
    expect(await discoveries([a.actorId, b.actorId])).toEqual(both);

    // A new instance starts from the recorded progress (no second discovery of the same location).
    const next = await startRpgLiveInstance(host, database, { actorIds: [a.actorId], area: 'area:region_1' });
    expect(host.inspect(next)?.state.heroes[0]?.world.discovered).toEqual([R1('overgrown_causeway'), R1('portal_clearing')]);
    const ca2 = ca; // one live socket per account: the same connection attaches to the new instance
    await ca2.attach(next);
    await applied(ca2, next, travel(EXIT('portal_clearing', 'overgrown_causeway')));
    expect(ca2.inbox.some((m) => gameEvent('discovered')(m) && m['instanceId'] === next)).toBe(false);
    await applied(ca2, next, travel(EXIT('overgrown_causeway', 'portal_clearing')));
    await applied(ca2, next, { type: 'returnToSanctuary' });
    expect(await discoveries([a.actorId])).toEqual(expected(a.actorId));
  }, 30_000);

  it('exploration: engage → combat → victory → exploring, and return from a safe location', async () => {
    const n = await node('node-victory');
    const a = await player();
    const instanceId = await startRpgLiveInstance(n.live.host(), database, { actorIds: [a.actorId], location: LOCATION, groups: [SLIMES] });
    const ca = await connect(n, a);
    await ca.attach(instanceId);
    await applied(ca, instanceId, { type: 'engage', groupId: SLIMES.id });
    expect(n.live.host().inspect(instanceId)?.state.phase).toBe('combat');
    await advance(60_000, [n], () => n.live.host().inspect(instanceId)?.ticking === false);
    expect(await ca.waitFor(gameEvent('combatEnded'))).toMatchObject({ event: { outcome: 'victory', groupId: SLIMES.id } });
    expect(n.live.host().inspect(instanceId)?.state.phase).toBe('exploring');
    await rejected(ca, instanceId, { type: 'engage', groupId: SLIMES.id }, 'unknown_group');
    await applied(ca, instanceId, { type: 'returnToSanctuary' });
    expect(await row(instanceId)).toMatchObject({ status: 'closed', outcome: 'returned' });

    // The vault antechamber is `safe`: returning is allowed there.
    const safe = await startRpgLiveInstance(n.live.host(), database, { actorIds: [a.actorId], location: R1('vault_antechamber') });
    const cs = ca;
    await cs.attach(safe);
    await applied(cs, safe, { type: 'returnToSanctuary' });
    expect(await row(safe)).toMatchObject({ status: 'closed', outcome: 'returned' });
    expect((await discoveries([a.actorId])).map((d) => d.location_id)).toEqual([R1('vault_antechamber'), LOCATION]);
  }, 30_000);

  it('exploration: hotspot flag survives a node crash; boss room needs a risk summary and confirmation; the boss aggroes', async () => {
    const nodeA = await node('node-boss-a'); const nodeB = await node('node-boss-b');
    const a = await player();
    const instanceId = await startRpgLiveInstance(nodeA.live.host(), database, { actorIds: [a.actorId], area: 'area:region_1' });
    const ca = await connect(nodeA, a);
    await ca.attach(instanceId);
    for (const exitId of [EXIT('portal_clearing', 'overgrown_causeway'), EXIT('overgrown_causeway', 'tangle_orchard'),
      EXIT('tangle_orchard', 'irrigation_terraces'), EXIT('irrigation_terraces', 'pump_station'), EXIT('pump_station', 'vault_antechamber')]) {
      await applied(ca, instanceId, travel(exitId));
    }
    const bossExit = EXIT('vault_antechamber', 'seed_vault_heart');
    // An unmet requirement keeps the route blocked.
    await rejected(ca, instanceId, { type: 'enterBossRoom', exitId: bossExit, confirm: false }, 'exit_locked');
    await rejected(ca, instanceId, travel(bossExit), 'exit_locked');
    await applied(ca, instanceId, travel(EXIT('vault_antechamber', 'pump_station')));
    await applied(ca, instanceId, { type: 'interact', hotspotId: 'bulkhead_lever' });
    expect(await ca.waitFor(gameEvent('hotspotInteracted'))).toMatchObject({ event: { flagsSet: ['region_1.bulkhead_open'], repeat: false } });
    await applied(ca, instanceId, { type: 'interact', hotspotId: 'bulkhead_lever' });
    expect(await ca.waitFor(gameEvent('hotspotInteracted'))).toMatchObject({ event: { flagsSet: [], repeat: true } });
    const before = nodeA.live.host().inspect(instanceId)?.state;

    nodeA.live.host().abandonForTesting(); // kill -9 after the lever checkpoint
    await ca.drop();
    await advance(LEASE_MS, [nodeB]);
    const cb = await connect(nodeB, a);
    expect(await cb.attach(instanceId)).toMatchObject({ type: 'live.attached', mode: 'snapshot' });
    expect(await cb.waitFor((m) => m.type === 'live.snapshot')).toMatchObject({ epoch: 2,
      view: { phase: 'exploring', location: R1('pump_station'), flags: ['region_1.bulkhead_open'] } });
    expect(nodeB.live.host().inspect(instanceId)?.state).toEqual(before);

    await applied(cb, instanceId, travel(EXIT('pump_station', 'vault_antechamber')));
    await rejected(cb, instanceId, travel(bossExit), 'boss_room_requires_confirmation');
    await rejected(cb, instanceId, { type: 'enterBossRoom', exitId: bossExit, confirm: true }, 'confirmation_required');
    await applied(cb, instanceId, { type: 'enterBossRoom', exitId: bossExit, confirm: false });
    expect(await cb.waitFor(gameEvent('bossRoomWarning'))).toMatchObject({ event: { exitId: bossExit, risk: {
      locationId: R1('seed_vault_heart'), enemies: [{ enemy: 'enemy:hollow_matriarch', rank: 'boss' }], retreatAllowed: false } } });
    expect(nodeB.live.host().inspect(instanceId)?.state.location).toBe(R1('vault_antechamber'));
    await applied(cb, instanceId, { type: 'enterBossRoom', exitId: bossExit, confirm: true });
    expect(await cb.waitFor(gameEvent('combatStarted'))).toMatchObject({ event: { boss: true } });
    await rejected(cb, instanceId, { type: 'retreat' }, 'retreat_not_allowed');
    await rejected(cb, instanceId, { type: 'returnToSanctuary' }, 'in_combat');
    // The boss-room discovery was committed with the pre-encounter checkpoint, before the outcome is known.
    expect((await discoveries([a.actorId])).map((d) => d.location_id)).toContain(R1('seed_vault_heart'));
    await advance(180_000, [nodeB], () => !nodeB.live.host().has(instanceId));
    const closed = await row(instanceId);
    expect(closed.status).toBe('closed');
    // A level-1 starter hero cannot beat the level-6 Matriarch: `dead`, closed as defeated, lock released.
    expect(closed.outcome).toBe('defeated');
    expect(closed.checkpoint).toMatchObject({ state: { phase: 'dead', location: R1('seed_vault_heart') } });
    expect(await activity(a.actorId)).toBe('none');
    expect((await discoveries([a.actorId])).map((d) => d.location_id)).toEqual([R1('irrigation_terraces'), R1('overgrown_causeway'),
      R1('portal_clearing'), R1('pump_station'), R1('seed_vault_heart'), R1('tangle_orchard'), R1('vault_antechamber')]);
  }, 60_000);
});
