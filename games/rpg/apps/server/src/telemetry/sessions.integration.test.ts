import { randomBytes, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService, createDatabase, ManualClock } from '@engine/server-kit';
import type { Database } from '@engine/server-kit';

import { RPG_MIGRATIONS } from '../migrations.ts';
import { rpgConnectionSessions } from './session-schema.ts';
import { persistRpgConnectionLifecycle } from './sessions.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for RPG connection telemetry tests');

describe.skipIf(!adminUrl)('RPG authenticated connection telemetry (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let auth: AuthService;
  const databaseName = `rpg_conn_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);

  beforeAll(async () => {
    const base = { databaseUrl: adminUrl as string, poolMax: 5, databaseTimeoutMs: 10000 };
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...base, databaseUrl: url.toString() }, { migrationSets: [RPG_MIGRATIONS] });
    await database.migrate();
    auth = new AuthService(database, clock);
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  });

  it('records starts, keeps server time monotonic, closes once and never revives a closed connection', async () => {
    const session = await auth.guest(randomBytes(32).toString('base64url'));
    const connectionId = randomUUID();
    await persistRpgConnectionLifecycle(database, { type: 'authenticated', accountId: session.accountId, connectionId, atMs: clock.nowMs() });
    clock.advance(1000);
    await persistRpgConnectionLifecycle(database, { type: 'heartbeat', accountId: session.accountId, connectionId, atMs: clock.nowMs() });
    // A backward-moving test/debug clock cannot move the stored observation backward.
    await persistRpgConnectionLifecycle(database, { type: 'heartbeat', accountId: session.accountId, connectionId, atMs: clock.nowMs() - 5000 });
    clock.advance(500);
    await persistRpgConnectionLifecycle(database, { type: 'stopped', accountId: session.accountId, connectionId, atMs: clock.nowMs() });
    await persistRpgConnectionLifecycle(database, { type: 'stopped', accountId: session.accountId, connectionId, atMs: clock.nowMs() + 5000 });
    await persistRpgConnectionLifecycle(database, { type: 'heartbeat', accountId: session.accountId, connectionId, atMs: clock.nowMs() + 10000 });
    const [row] = await database.db.select().from(rpgConnectionSessions).where(eq(rpgConnectionSessions.connectionId, connectionId));
    expect(row).toMatchObject({ connectionId, accountId: session.accountId, endedAt: new Date(clock.nowMs()) });
    expect(row?.lastSeenAt).toEqual(new Date(1_900_000_001_000));
    expect(row?.endedAt?.getTime()).toBeGreaterThanOrEqual(row?.lastSeenAt.getTime() ?? Infinity);
  });

  it('observes abandoned intervals at last_seen_at when a later authenticated connection is acquired', async () => {
    const session = await auth.guest(randomBytes(32).toString('base64url'));
    const oldConnectionId = randomUUID(); const newConnectionId = randomUUID();
    const startedAt = clock.nowMs();
    await persistRpgConnectionLifecycle(database, { type: 'authenticated', accountId: session.accountId, connectionId: oldConnectionId, atMs: startedAt });
    clock.advance(500);
    await persistRpgConnectionLifecycle(database, { type: 'heartbeat', accountId: session.accountId, connectionId: oldConnectionId, atMs: clock.nowMs() });
    clock.advance(5000);
    await persistRpgConnectionLifecycle(database, { type: 'authenticated', accountId: session.accountId, connectionId: newConnectionId, atMs: clock.nowMs() });
    const rows = await database.db.select().from(rpgConnectionSessions).where(eq(rpgConnectionSessions.accountId, session.accountId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.connectionId === oldConnectionId)?.endedAt).toEqual(new Date(startedAt + 500));
    expect(rows.find(row => row.connectionId === newConnectionId)).toMatchObject({ endedAt: null, startedAt: new Date(clock.nowMs()) });
  });
});
