import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { ManualClock } from '../clock.ts';
import { createDatabase } from '../database.ts';
import type { Database } from '../database.ts';
import { createAuthModule } from './index.ts';
import type { AuthModuleOptions } from './index.ts';
import { newSessionToken, tokenHash } from './crypto.ts';
import { requireAccount, SESSION_COOKIE } from './http.ts';
import { AuthService } from './service.ts';
import type { IssuedSession } from './service.ts';
import { accounts, authSessions, emailCredentials, guestCredentials, liveSessions } from './schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL auth integration tests');
const password = 'a sufficiently long test password';

describe.skipIf(!adminUrl)('guest/email/session authentication against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let service: AuthService;
  const clock = new ManualClock(1_000_000);
  const databaseName = `auth_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const base = { databaseUrl: adminUrl as string, poolMax: 10, databaseTimeoutMs: 10000 };
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...base, databaseUrl: url.toString() });
    // Parent composition includes auth/schema.ts in the engine migration set; no game journal is required.
    await database.migrate();
    service = new AuthService(database, clock, { sessionTtlMs: 60000, liveLeaseMs: 3000 });
  }, 30000);
  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  });
  async function app(options: AuthModuleOptions = {}): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    await createAuthModule({ sessionTtlMs: 60000, liveLeaseMs: 3000, heartbeatMs: 1000, ...options }).register(instance,
      { database, clock, content: { format: 1, game: 'test', contentHash: 'a'.repeat(64), world: {}, collections: {} } });
    // A sibling module uses the shared helper directly, demonstrating no dependency on auth's decorators.
    instance.register(async (sibling) => { sibling.get('/private', async (request) => requireAccount(request, { database, clock })); });
    await instance.ready(); return instance;
  }
  it('serializes first-launch retries into one stable identity and stores only credential hashes', async () => {
    const device = newSessionToken();
    const sessions = await Promise.all(Array.from({ length: 4 }, () => service.guest(device)));
    expect(new Set(sessions.map((session) => session.accountId)).size).toBe(1);
    expect(new Set(sessions.map((session) => session.sessionToken)).size).toBe(4);
    const guest = await database.db.select().from(guestCredentials).where(eq(guestCredentials.tokenHash, tokenHash(device, 'device')));
    expect(guest).toHaveLength(1);
    const stored = await database.db.select().from(authSessions).where(eq(authSessions.accountId, sessions[0]?.accountId as string));
    expect(stored).toHaveLength(4);
    const serialized = JSON.stringify({ guest, stored });
    expect(serialized).not.toContain(device);
    for (const session of sessions) expect(serialized).not.toContain(session.sessionToken);
    expect((await service.authenticate(sessions[0]?.sessionToken as string)).accountId).toBe(sessions[0]?.accountId);
  });
  it('upgrades in place, rotates sessions, disables old device credentials and normalizes sign-in', async () => {
    const device = newSessionToken(); const guest = await service.guest(device);
    const before = (await database.db.select().from(accounts).where(eq(accounts.id, guest.accountId)))[0];
    const lease = await service.acquireLive(guest.sessionToken);
    const upgraded = await service.upgrade(guest.sessionToken, ' UPGRADE@Example.com ', password);
    expect(upgraded.accountId).toBe(guest.accountId);
    expect((await database.db.select().from(accounts).where(eq(accounts.id, guest.accountId)))[0]).toEqual(before);
    await expect(service.authenticate(guest.sessionToken)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(service.guest(device)).rejects.toMatchObject({ code: 'guest_credential_disabled' });
    await expect(service.renewLive(lease)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await service.signIn('upgrade@EXAMPLE.com', password)).accountId).toBe(guest.accountId);
    await expect(service.signIn('upgrade@example.com', 'a completely wrong password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(service.signIn('unknown@example.com', password)).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(await service.current(upgraded.sessionToken)).toMatchObject({ guest: false, email: 'upgrade@example.com' });
    const credentials = (await database.db.select().from(emailCredentials).where(eq(emailCredentials.accountId, guest.accountId)))[0];
    expect(credentials?.passwordHash).not.toContain(password);
  }, 15000);
  it('rejects a racing duplicate email without moving either account or disabling the losing guest', async () => {
    const deviceA = newSessionToken(); const deviceB = newSessionToken();
    const a = await service.guest(deviceA); const b = await service.guest(deviceB);
    const results = await Promise.allSettled([service.upgrade(a.sessionToken, 'same@example.com', password), service.upgrade(b.sessionToken, ' SAME@example.com ', password)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'email_unavailable', statusCode: 409 } });
    const loser = results[0]?.status === 'rejected' ? a : b;
    const loserDevice = loser.accountId === a.accountId ? deviceA : deviceB;
    expect((await service.guest(loserDevice)).accountId).toBe(loser.accountId);
    expect((await service.current(loser.sessionToken)).guest).toBe(true);
  }, 15000);
  it('serializes an in-flight guest login behind upgrade and never re-enables a disabled device', async () => {
    const device = newSessionToken(); const initial = await service.guest(device);
    const blocker = await database.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT token_hash FROM guest_credentials WHERE account_id=$1 FOR UPDATE', [initial.accountId]);
    const upgrade = service.upgrade(initial.sessionToken, 'race@example.com', password).then((session) => ({ session }), (error: unknown) => ({ error }));
    let guest: Promise<{ session: IssuedSession } | { error: unknown }> | undefined;
    try {
      // Upgrade holds accounts FOR UPDATE while its credential UPDATE waits on the test transaction.
      await waitUntil(async () => (await database.pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%update%guest_credentials%') AS blocked`)).rows[0]?.blocked === true);
      guest = service.guest(device).then((session) => ({ session }), (error: unknown) => ({ error }));
      await waitUntil(async () => (await database.pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query ILIKE '%accounts%for update%' OR query ILIKE '%insert%auth_sessions%')) AS blocked`)).rows[0]?.blocked === true);
      await blocker.query('COMMIT');
      expect(await upgrade).toHaveProperty('session');
      expect(await guest).toMatchObject({ error: { code: 'guest_credential_disabled' } });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await upgrade; if (guest) await guest; }
  }, 15000);
  it('uses the injected clock for session expiry and idempotent logout revocation', async () => {
    const session = await service.guest(newSessionToken());
    await service.logout(session.sessionToken); await service.logout(session.sessionToken);
    await expect(service.authenticate(session.sessionToken)).rejects.toMatchObject({ code: 'unauthorized' });
    const expiring = await service.guest(newSessionToken());
    clock.advance(60000);
    await expect(service.authenticate(expiring.sessionToken)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('rejects a concurrent second live connection, supports reconnect and fences stale cleanup', async () => {
    const session = await service.guest(newSessionToken());
    const attempts = await Promise.allSettled([service.acquireLive(session.sessionToken), service.acquireLive(session.sessionToken)]);
    const first = attempts.find((result) => result.status === 'fulfilled');
    expect(first?.status).toBe('fulfilled');
    expect(attempts.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'live_session_active' } });
    if (first?.status !== 'fulfilled') throw new Error('one lease must succeed');
    await service.releaseLive(first.value);
    const reconnected = await service.acquireLive(session.sessionToken);
    await service.releaseLive(first.value);
    await service.renewLive(reconnected);
    clock.advance(3000);
    const recovered = await service.acquireLive(session.sessionToken);
    await expect(service.renewLive(reconnected)).rejects.toMatchObject({ code: 'live_session_expired' });
    await service.releaseLive(reconnected);
    await service.renewLive(recovered);
    await service.releaseLive(recovered);
  });
  it('exposes bounded, no-store HTTP auth with secure cookies and cross-module authorization', async () => {
    const instance = await app();
    try {
      const response = await instance.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: newSessionToken() } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/);
      const session = response.json<IssuedSession>();
      expect((await instance.inject({ url: '/private', headers: { authorization: `Bearer ${session.sessionToken}` } })).json()).toMatchObject({ accountId: session.accountId });
      expect((await instance.inject({ url: '/auth/session', headers: { cookie: `${SESSION_COOKIE}=${session.sessionToken}` } })).statusCode).toBe(200);
      expect((await instance.inject({ method: 'POST', url: '/auth/upgrade', headers: { authorization: `Bearer ${session.sessionToken}` }, payload: { accountId: randomUUID(), email: 'attacker@example.com', password } })).statusCode).toBe(400);
      expect((await instance.inject({ method: 'POST', url: '/auth/guest', headers: { origin: 'https://evil.example' }, payload: { deviceToken: newSessionToken() } })).statusCode).toBe(403);
      expect((await instance.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: 'x'.repeat(5000) } })).statusCode).toBe(413);
      expect((await instance.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${session.sessionToken}` } })).statusCode).toBe(204);
      expect((await instance.inject({ url: '/auth/session', headers: { authorization: `Bearer ${session.sessionToken}` } })).statusCode).toBe(401);
    } finally { await instance.close(); }
  });
  it('limits repeated HTTP attempts before password work', async () => {
    const instance = await app({ rateLimit: 2 });
    try {
      await instance.inject('/auth/session'); await instance.inject('/auth/session');
      expect((await instance.inject('/auth/session')).statusCode).toBe(429);
    } finally { await instance.close(); }
  });
  it('authenticates actual WS upgrades, rejects the second socket, serializes ping/commands and cleans reconnects', async () => {
    const session = await service.guest(newSessionToken());
    let releaseCommand: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { releaseCommand = resolve; });
    const calls: unknown[] = [];
    const lifecycle: { type: string; accountId: string; connectionId: string; atMs: number }[] = [];
    const instance = await app({ onCommand: async (payload, identity) => {
      calls.push(payload); await held; return { type: 'command.result', accountId: identity.accountId, payload };
    }, onLifecycle: async (event) => { lifecycle.push(event); throw new Error('optional telemetry failed'); } });
    const address = await instance.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = address.replace('http:', 'ws:') + '/auth/live';
    const connections = new Set<WebSocket>();
    function connect(headers: Record<string, string> = {}) {
      const socket = new WebSocket(endpoint, { headers });
      connections.add(socket);
      const inbox: string[] = [];
      // Capture messages/close immediately: auth can complete before an awaited open resumes.
      socket.on('message', (data) => { inbox.push(data.toString()); });
      socket.on('error', () => {}); // opened rejects on upgrade errors; avoid an unhandled EventEmitter error.
      const opened = once(socket, 'open');
      const closed = new Promise<number>((resolve) => { socket.once('close', (code) => { resolve(code); }); });
      return { socket, opened, closed, async next(): Promise<string> {
        await waitUntil(async () => {
          if (inbox.length > 0) return true;
          if (socket.readyState === WebSocket.CLOSED) throw new Error('socket closed before expected message');
          return false;
        });
        return inbox.shift() as string;
      } };
    }
    try {
      await expect(connect().opened).rejects.toThrow(/401/);
      await expect(connect({ authorization: `Bearer ${session.sessionToken}`, origin: 'https://evil.example' }).opened).rejects.toThrow(/403/);
      const first = connect({ authorization: `Bearer ${session.sessionToken}` });
      await first.opened;
      expect(JSON.parse(await first.next())).toMatchObject({ type: 'authenticated', accountId: session.accountId });
      const second = connect({ authorization: `Bearer ${session.sessionToken}` });
      await second.opened;
      expect(await second.closed).toBe(4409);
      first.socket.send(JSON.stringify({ type: 'command', command: { command_id: randomUUID(), value: 'private-command' } }));
      await waitUntil(async () => calls.length === 1);
      first.socket.send('ping'); // Valid ping queues while a command is awaiting I/O, rather than closing the socket.
      releaseCommand?.();
      expect(JSON.parse(await first.next())).toMatchObject({ type: 'command.result', accountId: session.accountId });
      expect(await first.next()).toBe('pong');
      // Real TCP FIN/close lifecycle is essential here: injectWS's duplex stream leaves the server CLOSING.
      first.socket.close(); await first.closed;
      await waitUntil(async () => (await database.db.select().from(liveSessions).where(eq(liveSessions.accountId, session.accountId))).length === 0);
      await waitUntil(async () => lifecycle.some((event) => event.type === 'stopped'));
      expect(lifecycle[0]?.type).toBe('authenticated');
      expect(lifecycle.at(-1)?.type).toBe('stopped');
      expect(lifecycle.slice(1, -1).length).toBeGreaterThanOrEqual(2);
      expect(lifecycle.slice(1, -1).every((event) => event.type === 'heartbeat')).toBe(true);
      expect(lifecycle.every((event) => event.accountId === session.accountId && Number.isSafeInteger(event.atMs))).toBe(true);
      expect(new Set(lifecycle.map((event) => event.connectionId))).toHaveProperty('size', 1);
      const reconnect = connect({ cookie: `${SESSION_COOKIE}=${session.sessionToken}` });
      await reconnect.opened;
      expect(JSON.parse(await reconnect.next())).toMatchObject({ type: 'authenticated' });
      await service.logout(session.sessionToken);
      reconnect.socket.send('ping');
      expect(await reconnect.closed).toBe(4401);
    } finally { releaseCommand?.(); for (const socket of connections) socket.terminate(); await instance.close(); }
  }, 15000);
});
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(10); }
  throw new Error('condition did not become true');
}
