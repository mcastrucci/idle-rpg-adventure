import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { createDatabase, ManualClock, parseServerConfig, transitionActivity } from '@engine/server-kit';
import type { Database } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRpgDatabase, createRpgServer } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI needs PostgreSQL for authenticated game-command integration');
interface Session { accountId: string; sessionToken: string }
interface CharacterDto { actorId: string; accountId: string; name: string; version: number }
const token = () => randomBytes(32).toString('base64url');
const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });

describe.skipIf(!adminUrl)('authenticated character commands across HTTP and WebSocket', () => {
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let directory: string;
  let websocketUrl: string;
  const databaseName = `identity_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_000_000);
  const sockets = new Set<WebSocket>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'identity-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(compiled.bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    const config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    app = await createRpgServer(config, { clock });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    websocketUrl = address.replace('http:', 'ws:') + '/auth/live';
  }, 30_000);
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close(); await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function guest(): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200); return response.json<Session>();
  }
  async function create(session: Session, commandId = randomUUID()) {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session),
      payload: { command_id: commandId, operation: 'character.create', payload: { name: 'First hero' } } });
    expect(response.statusCode).toBe(201); return response.json<CharacterDto>();
  }
  function socket(session: Session) {
    const connection = new WebSocket(websocketUrl, { headers: headers(session) });
    sockets.add(connection);
    const inbox: string[] = [];
    connection.on('message', (message) => { inbox.push(message.toString()); });
    return { connection, async next(): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const message = inbox.shift(); if (message !== undefined) return message;
        if (connection.readyState === WebSocket.CLOSED) throw new Error('socket closed before expected message');
        await delay(10);
      }
      throw new Error('socket response timeout');
    } };
  }

  it('upgrades the same guest account/actor and replays a pre-upgrade command with the new session', async () => {
    const initial = await guest(); const commandId = randomUUID();
    const original = await create(initial, commandId);
    const upgrade = await app.inject({ method: 'POST', url: '/auth/upgrade', headers: headers(initial),
      payload: { email: `identity-${randomUUID()}@example.com`, password: 'a long integration test password' } });
    expect(upgrade.statusCode).toBe(200);
    const upgraded = upgrade.json<Session>(); expect(upgraded.accountId).toBe(initial.accountId);
    expect((await app.inject({ url: '/characters', headers: headers(initial) })).statusCode).toBe(401);
    expect(await create(upgraded, commandId)).toEqual(original);
    const current = await app.inject({ url: `/characters/${original.actorId}`, headers: headers(upgraded) });
    expect(current.json()).toEqual(original);
    const list = await app.inject({ url: '/characters', headers: headers(upgraded) });
    expect(list.json<CharacterDto[]>()).toHaveLength(1);
  }, 15_000);

  it('applies one WS/HTTP mutation, rejects conflicting retries and a second live socket, and revokes the first', async () => {
    const session = await guest(); const hero = await create(session);
    const first = socket(session);
    expect(JSON.parse(await first.next())).toMatchObject({ type: 'authenticated', accountId: session.accountId });
    const second = socket(session); const secondClosed = once(second.connection, 'close');
    expect((await secondClosed)[0]).toBe(4409);
    const commandId = randomUUID();
    first.connection.send(JSON.stringify({ type: 'command', command: { command_id: commandId, operation: 'character.configure',
      payload: { actorId: hero.actorId, configuration: { name: 'One committed change' } } } }));
    const result = JSON.parse(await first.next()) as { type: string; status: number; body: CharacterDto };
    expect(result).toMatchObject({ type: 'command.result', status: 200, body: { name: 'One committed change', version: 1 } });
    const replay = await app.inject({ method: 'PATCH', url: `/characters/${hero.actorId.toUpperCase()}/configuration`, headers: headers(session),
      payload: { command_id: commandId.toUpperCase(), operation: 'character.configure', payload: { name: 'One committed change' } } });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(result.body);
    const conflict = await app.inject({ method: 'PATCH', url: `/characters/${hero.actorId}/configuration`, headers: headers(session),
      payload: { command_id: commandId, operation: 'character.configure', payload: { name: 'Different request' } } });
    expect(conflict.statusCode).toBe(409);
    const current = await app.inject({ url: `/characters/${hero.actorId}`, headers: headers(session) });
    expect(current.json()).toEqual(result.body);
    first.connection.send('ping'); expect(await first.next()).toBe('pong');
    const closed = once(first.connection, 'close');
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: headers(session) })).statusCode).toBe(204);
    first.connection.send('ping'); expect((await closed)[0]).toBe(4401);
  }, 15_000);

  it('enforces ownership and activity guards before edits, without caching failed mutations', async () => {
    const owner = await guest(); const other = await guest(); const hero = await create(owner);
    const path = `/characters/${hero.actorId}/configuration`;
    const wire = { command_id: randomUUID(), operation: 'character.configure', payload: { name: 'After return' } };
    expect((await app.inject({ method: 'PATCH', url: path, headers: headers(other), payload: wire })).statusCode).toBe(404);
    const activityId = randomUUID();
    await database.db.transaction((tx) => transitionActivity(tx, hero.actorId,
      { state: 'none', activityId: null }, { state: 'expedition', activityId }));
    expect((await app.inject({ method: 'PATCH', url: path, headers: headers(owner), payload: wire })).statusCode).toBe(409);
    await database.db.transaction((tx) => transitionActivity(tx, hero.actorId,
      { state: 'expedition', activityId }, { state: 'none', activityId: null }));
    const valid = await app.inject({ method: 'PATCH', url: path, headers: headers(owner), payload: wire });
    expect(valid.statusCode).toBe(200); expect(valid.json()).toMatchObject({ name: 'After return', version: 3 });
    const unearned = await app.inject({ method: 'PATCH', url: path, headers: headers(owner),
      payload: { ...wire, command_id: randomUUID(), payload: { allocate: { STR: 1 } } } });
    expect(unearned.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: path, headers: { ...headers(owner), origin: 'https://other.example' }, payload: wire })).statusCode).toBe(403);
  });
});
