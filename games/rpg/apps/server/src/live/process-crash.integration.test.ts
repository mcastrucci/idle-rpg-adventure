/** #37: hard-kill production server processes and recover from their last PostgreSQL checkpoint. */
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import { actors, AuthService, checkLedgerInvariants, createDatabase, getHoldings, liveInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createCharacterService } from '../characters/service.ts';
import { characters } from '../characters/schema.ts';
import { createRpgDatabase } from '../index.ts';
import { rpgAreaDiscoveries } from '../expeditions/schema.ts';
import { rpgLiveXpEvents } from '../telemetry/schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for process crash integration tests');
const START = 1_800_000_000_000;
const PORTAL = 'loc:region_1.portal_clearing';
const CAUSEWAY = 'loc:region_1.overgrown_causeway';
const CAUSEWAY_EXIT = 'exit:region_1.portal_clearing.overgrown_causeway';
type Message = Record<string, unknown> & { type: string };
interface Player { accountId: string; sessionToken: string; actorId: string }
interface Reply { type: 'result' | 'error'; requestId: string; value?: unknown; error?: string }

class ServerProcess {
  private static clockNow = START;
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly wsUrl: string;
  private nextId = 0;
  private readonly replies = new Map<string, (reply: Reply) => void>();
  private output = '';
  private constructor(child: ChildProcess, address: string, stderr: string) {
    this.child = child;
    this.baseUrl = address;
    this.wsUrl = address.replace('http:', 'ws:') + '/auth/live';
    this.output = stderr;
    child.stderr?.on('data', chunk => { this.output += chunk.toString(); });
    child.on('message', (message: Reply) => {
      const resolve = this.replies.get(message.requestId);
      if (resolve) { this.replies.delete(message.requestId); resolve(message); }
    });
    child.once('exit', (code, signal) => {
      for (const [id, reject] of this.replies) { this.replies.delete(id); reject({ type: 'error', requestId: id,
        error: `child exited ${code}/${signal}; stderr: ${this.output}` }); }
    });
  }
  static async start(bundle: string, databaseUrl: string, nodeId: string): Promise<ServerProcess> {
    const child = fork(fileURLToPath(new URL('./process-crash-host.ts', import.meta.url)), [], {
      execArgv: ['--experimental-strip-types'], env: { ...process.env, DATABASE_URL: databaseUrl, CONTENT_BUNDLE_PATH: bundle,
        CLOCK_START: String(ServerProcess.clockNow), NODE_ID: nodeId }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    try {
      const ready = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child did not start; stderr: ${stderr}`)), 10_000);
        child.on('message', (message: { type?: string; address?: string }) => {
          if (message.type === 'ready' && message.address) { clearTimeout(timeout); resolve(message.address); }
        });
        child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`child exited before ready: ${code}/${signal}; stderr: ${stderr}`)); });
      });
      return new ServerProcess(child, ready, stderr);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL');
        await Promise.race([exited, delay(5_000).then(() => { throw new Error(`failed to kill startup child; stderr: ${stderr}`); })]);
      }
      throw error;
    }
  }
  async call(type: 'advance' | 'recoverExpired' | 'recover', ms?: number, instanceId?: string): Promise<unknown> {
    const requestId = String(++this.nextId);
    const reply = new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => { this.replies.delete(requestId); reject(new Error(`child IPC timed out (${type}); stderr: ${this.output}`)); }, 15_000);
      this.replies.set(requestId, value => { clearTimeout(timeout); resolve(value); });
      this.child.send({ type, requestId, ...(ms === undefined ? {} : { ms }), ...(instanceId === undefined ? {} : { instanceId }) }, error => {
        if (error) { clearTimeout(timeout); this.replies.delete(requestId); reject(error); }
      });
    });
    const result = await reply;
    if (result.type === 'error') throw new Error(`child ${type} failed: ${result.error}; stderr: ${this.output}`);
    if (type === 'advance') ServerProcess.clockNow += ms ?? 0;
    return result.value;
  }
  async kill9(): Promise<void> {
    const exited = once(this.child, 'exit');
    this.child.kill('SIGKILL');
    const [code, signal] = await Promise.race([exited as Promise<[number | null, NodeJS.Signals | null]>,
      delay(5_000).then(() => { throw new Error(`SIGKILL did not exit child; stderr: ${this.output}`); })]);
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
  }
  async closeForCleanup(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.kill9();
  }
}

class SocketClient {
  readonly socket: WebSocket;
  private readonly inbox: Message[] = [];
  private socketError = '';
  constructor(url: string, token: string) {
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.socket.on('message', raw => this.inbox.push(JSON.parse(raw.toString()) as Message));
    this.socket.on('error', error => { this.socketError = error.message; });
  }
  async wait(predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as Message;
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`live WebSocket closed before expected frame: ${this.socketError}`);
      await delay(5);
    }
    throw new Error('timed out waiting for live WebSocket frame');
  }
  async ready() { await this.wait(m => m.type === 'authenticated'); }
  async send(command: Record<string, unknown>): Promise<Message> {
    this.socket.send(JSON.stringify({ type: 'command', command }));
    return this.wait(m => m.type === 'live.ack' || m.type === 'live.error' || m.type === 'live.attached');
  }
  async attach(instanceId: string, actorId: string) {
    const response = await this.send({ op: 'live.attach', instanceId, actorId });
    if (response.type === 'live.attached') return this.wait(m => m.type === 'live.snapshot');
    return response;
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close'); this.socket.terminate(); await closed;
  }
}

describe.skipIf(!adminUrl)('hard process crash recovery (real PostgreSQL and SIGKILL)', () => {
  let admin: Database; let database: Database; let config: ServerConfig; let directory: string; let bundlePath: string;
  let content: ContentBundle;
  const authClock = new ManualClock(START);
  const authSockets = new Set<SocketClient>();
  const processes = new Set<ServerProcess>();
  const databaseName = `live_crash_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-process-crash-'));
    const source = fileURLToPath(new URL('../../../../content', import.meta.url));
    const fixture = join(directory, 'content'); await cp(source, fixture, { recursive: true });
    const encounterPath = join(fixture, 'encounter-tables', 'region_1.json');
    const encounters = JSON.parse(await readFile(encounterPath, 'utf8')) as { id: string; entries: unknown[] }[];
    const causeway = encounters.find(table => table.id === 'enc:region_1.causeway');
    if (!causeway) throw new Error('region 1 causeway encounter table missing');
    causeway.entries = [{ weight: 1, enemies: [{ enemy: 'enemy:glowcap_mite', count: 1 }] }];
    await writeFile(encounterPath, JSON.stringify(encounters));
    const lootPath = join(fixture, 'loot-tables', 'region_1.json');
    const loot = JSON.parse(await readFile(lootPath, 'utf8')) as { id: string; rolls?: number; nothingWeight?: number; entries?: unknown[]; gold?: { min: number; max: number } }[];
    const mite = loot.find(table => table.id === 'loot:region_1.mite');
    if (!mite) throw new Error('region 1 mite loot table missing');
    mite.rolls = 1; mite.nothingWeight = 0; mite.entries = [{ item: 'item:glowcap', weight: 1, qty: { min: 1, max: 1 } }]; mite.gold = { min: 2, max: 2 };
    await writeFile(lootPath, JSON.stringify(loot));
    const compiled = compileContentDirectory(fixture, plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle;
    bundlePath = join(directory, 'bundle.json'); await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base); await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`; config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config); await database.migrate();
  }, 30_000);

  afterAll(async () => {
    for (const socket of authSockets) await socket.close();
    for (const child of processes) await child.closeForCleanup();
    await database?.close();
    if (admin) { try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await admin.close(); } }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function child(nodeId: string) {
    const result = await ServerProcess.start(bundlePath, config.databaseUrl, nodeId); processes.add(result); return result;
  }
  async function player(): Promise<Player> {
    const auth = new AuthService(database, authClock); const session = await auth.guest(randomBytes(32).toString('base64url'));
    const hero = await database.db.transaction(tx => createCharacterService(tx, content as never).create(session.accountId, { name: 'Crash hero' }));
    return { accountId: session.accountId, sessionToken: session.sessionToken, actorId: hero.actorId };
  }
  async function start(server: ServerProcess, who: Player): Promise<string> {
    const response = await fetch(`${server.baseUrl}/live/start`, { signal: AbortSignal.timeout(5_000), method: 'POST', headers: { authorization: `Bearer ${who.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), actorId: who.actorId, areaId: 'area:region_1', supplies: [] }) });
    if (!response.ok) throw new Error(`live start failed ${response.status}: ${await response.text()}`);
    return (await response.json() as { instanceId: string }).instanceId;
  }
  async function connect(server: ServerProcess, who: Player) {
    const socket = new SocketClient(server.wsUrl, who.sessionToken); authSockets.add(socket); await socket.ready(); return socket;
  }
  async function row(instanceId: string) {
    const [result] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId));
    if (!result) throw new Error('missing instance'); return result;
  }
  async function assertLedger(actorId: string) {
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [actorId]))).toEqual([]);
  }
  it('SIGKILL after exploration discovery and victory checkpoint; refuses early takeover, then recovers rewards and returns once', async () => {
    const a = await child('crash-explore-a'); const who = await player(); const instanceId = await start(a, who);
    const ca = await connect(a, who); expect(await ca.attach(instanceId, who.actorId)).toMatchObject({ type: 'live.snapshot' });
    expect(await ca.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(),
      command: { type: 'travel', exitId: CAUSEWAY_EXIT } })).toMatchObject({ type: 'live.ack', status: 'applied' });
    const discovered = await database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, who.actorId));
    expect(discovered.map(value => value.locationId).sort()).toEqual([PORTAL, CAUSEWAY].sort());
    expect((await row(instanceId)).checkpointSeq).toBeGreaterThan(0);
    const saved = (await row(instanceId)).checkpoint as { state: { visited: Record<string, { groups: { id: string; defeated: boolean }[] }>; phase: string } };
    const groupId = saved.state.visited[CAUSEWAY]?.groups[0]?.id;
    if (!groupId) throw new Error('checkpoint did not save the causeway encounter');
    const commandId = randomUUID();
    expect(await ca.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId, command: { type: 'engage', groupId } }))
      .toMatchObject({ type: 'live.ack', status: 'applied' });
    await a.call('advance', 45_000);
    await ca.wait(message => message.type === 'live.event' && (message['event'] as { type?: string }).type === 'combatEnded', 10_000);
    const xpBefore = await database.db.select().from(rpgLiveXpEvents).where(eq(rpgLiveXpEvents.instanceId, instanceId));
    expect(xpBefore).toHaveLength(1);
    const checkpoint = (await row(instanceId)).checkpoint as { state: { phase: string; visited: Record<string, { groups: { id: string; defeated: boolean }[] }> } };
    expect(checkpoint.state.visited[CAUSEWAY]?.groups[0]).toMatchObject({ id: groupId, defeated: true });
    await a.kill9(); await ca.close();

    const b = await child('crash-explore-b');
    expect(await b.call('recover', undefined, instanceId)).toBe(false); // the persisted lease still belongs to the killed process
    await b.call('advance', 31_000);
    expect(await b.call('recover', undefined, instanceId)).toBe(true);
    const cb = await connect(b, who);
    expect(await cb.attach(instanceId, who.actorId)).toMatchObject({ type: 'live.snapshot' });
    expect((await row(instanceId)).checkpointSeq).toBeGreaterThan(0);
    const replay = await cb.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId, command: { type: 'engage', groupId } });
    expect(replay).toMatchObject({ type: 'live.ack', duplicate: true });
    expect(await cb.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(),
      command: { type: 'travel', exitId: 'exit:region_1.overgrown_causeway.portal_clearing' } })).toMatchObject({ type: 'live.ack', status: 'applied' });
    expect(await cb.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(),
      command: { type: 'returnToSanctuary' } })).toMatchObject({ type: 'live.ack', status: 'applied' });
    expect((await row(instanceId)).status).toBe('closed');
    expect((await database.db.select().from(rpgLiveXpEvents).where(eq(rpgLiveXpEvents.instanceId, instanceId))).map(x => x.grantedXp)).toEqual([6]);
    const finalHoldings = await database.db.transaction(tx => getHoldings(tx, who.actorId));
    expect(finalHoldings.find(h => h.asset.kind === 'currency' && h.asset.currency === 'gold' && h.container === 'inventory')?.qty).toBe(2);
    expect(finalHoldings.find(h => h.asset.kind === 'stack' && h.asset.item === 'item:glowcap' && h.container === 'inventory')?.qty).toBe(1);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]?.activityState).toBe('none');
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0]?.xp).toBe(6);
    expect(await b.call('recoverExpired')).toEqual([]); // a closed row cannot regrant its checkpointed rewards
    await assertLedger(who.actorId);
  }, 60_000);

  it('SIGKILL midcombat; replacement restores tick zero and settles one victory reward', async () => {
    const a = await child('crash-combat-a'); const who = await player(); const instanceId = await start(a, who);
    const ca = await connect(a, who); await ca.attach(instanceId, who.actorId);
    await ca.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(), command: { type: 'travel', exitId: CAUSEWAY_EXIT } });
    const state = (await row(instanceId)).checkpoint as { state: { visited: Record<string, { groups: { id: string }[] }> } };
    const groupId = state.state.visited[CAUSEWAY]?.groups[0]?.id;
    if (!groupId) throw new Error('missing test encounter');
    await ca.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(), command: { type: 'engage', groupId } });
    let witnessedCombat: { tick: number; actors: { side: string; hp: number; maxHp: number }[] } | undefined;
    for (let elapsed = 0; elapsed < 15_000; elapsed += 250) {
      const response = await fetch(`${a.baseUrl}/live/current/${who.actorId}`, { signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${who.sessionToken}` } });
      expect(response.status).toBe(200);
      const body = await response.json() as { current: { view: { combat: { tick: number; actors: { side: string; hp: number; maxHp: number }[] } | null } } };
      const combat = body.current.view.combat;
      if (combat && combat.tick > 0 && combat.actors.some(actor => actor.side === 'enemy' && actor.hp < actor.maxHp)) {
        witnessedCombat = combat; break;
      }
      await a.call('advance', 250);
    }
    expect(witnessedCombat?.tick).toBeGreaterThan(0);
    expect(witnessedCombat?.actors.some(actor => actor.side === 'enemy' && actor.hp < actor.maxHp)).toBe(true);
    const before = (await row(instanceId)).checkpoint as { state: { phase: string; combat: { tick: number; actors: { side: string; hp: number; stats: { maxHp: number } }[] } } };
    expect(before.state.phase).toBe('combat');
    expect(before.state.combat.tick).toBe(0);
    await a.kill9(); await ca.close();

    const b = await child('crash-combat-b');
    await b.call('advance', 31_000);
    expect(await b.call('recoverExpired')).toEqual([instanceId]);
    const restored = (await row(instanceId)).checkpoint as typeof before;
    expect(restored.state.combat.tick).toBe(0);
    expect(restored.state.combat.actors.filter(actor => actor.side === 'enemy').every(actor => actor.hp === actor.stats.maxHp)).toBe(true);
    const cb = await connect(b, who); const recoveredSnapshot = await cb.attach(instanceId, who.actorId);
    expect(recoveredSnapshot).toMatchObject({ type: 'live.snapshot', view: { combat: { tick: 0 } } });
    expect((recoveredSnapshot['view'] as { combat: { actors: { side: string; hp: number; maxHp: number }[] } }).combat.actors
      .filter(actor => actor.side === 'enemy').every(actor => actor.hp === actor.maxHp)).toBe(true);
    await b.call('advance', 45_000);
    await cb.wait(message => message.type === 'live.event' && (message['event'] as { type?: string }).type === 'combatEnded', 10_000);
    expect((await database.db.select().from(rpgLiveXpEvents).where(eq(rpgLiveXpEvents.instanceId, instanceId))).map(x => x.grantedXp)).toEqual([6]);
    await cb.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(), command: { type: 'travel', exitId: 'exit:region_1.overgrown_causeway.portal_clearing' } });
    await cb.send({ op: 'live.command', instanceId, actorId: who.actorId, commandId: randomUUID(), command: { type: 'returnToSanctuary' } });
    expect((await database.db.select().from(rpgLiveXpEvents).where(eq(rpgLiveXpEvents.instanceId, instanceId))).map(x => x.grantedXp)).toEqual([6]);
    const holdings = await database.db.transaction(tx => getHoldings(tx, who.actorId));
    expect(holdings.find(h => h.asset.kind === 'currency' && h.asset.currency === 'gold' && h.container === 'inventory')?.qty).toBe(2);
    expect(holdings.find(h => h.asset.kind === 'stack' && h.asset.item === 'item:glowcap' && h.container === 'inventory')?.qty).toBe(1);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]?.activityState).toBe('none');
    await assertLedger(who.actorId);
  }, 60_000);
});
