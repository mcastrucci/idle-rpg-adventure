import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accounts } from '../auth/schema.ts';
import { ManualClock } from '../clock.ts';
import { parseServerConfig } from '../config.ts';
import { createDatabase } from '../database.ts';
import type { Database } from '../database.ts';

import { cleanupExpiredCommands } from './cleanup.ts';
import { canonicalCommandJson } from './json.ts';
import { runCommand } from './run.ts';
import type { CommandEnvelope, CommandTransaction } from './run.ts';
import { commandLog } from './schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL integration tests');

describe('bounded canonical command JSON', () => {
  it('sorts object keys while preserving array order and values', () => {
    expect(canonicalCommandJson({ z: [2, 1], a: { y: null, x: true } })).toBe('{"a":{"x":true,"y":null},"z":[2,1]}');
    expect(canonicalCommandJson({ value: -0 })).toBe(canonicalCommandJson({ value: 0 }));
  });
  it('rejects ambiguous, cyclic, oversized, and excessively nested JSON', () => {
    const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
    const nested = Array.from({ length: 34 }).reduce<unknown>((value) => ({ child: value }), 1);
    for (const value of [undefined, NaN, Infinity, 1n, { value: undefined }, { value: () => 1 }, cycle, nested,
      new Date(), { [Symbol('hidden')]: 1 }, Array(2), { big: 'a'.repeat(65_536) }, Object.defineProperty({}, 'hidden', { value: 1 }),
      { get value() { throw new Error('must not invoke getter'); } }]) {
      expect(() => canonicalCommandJson(value)).toThrow(TypeError);
    }
  });
});

/** Durable side effects use PostgreSQL fixture stock, never an in-memory balance or a production potion route. */
describe.skipIf(!adminUrl)('commands against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let peer: Database;
  const databaseName = `command_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_000_000);
  beforeAll(async () => {
    const config = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: '/unused', LOG_LEVEL: 'silent' });
    admin = createDatabase(config);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(config.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...config, databaseUrl: url.toString() });
    peer = createDatabase({ ...config, databaseUrl: url.toString() });
    await database.migrate();
    await database.pool.query('CREATE TABLE command_test_stock (account_id uuid PRIMARY KEY REFERENCES accounts(id), quantity integer NOT NULL CHECK (quantity >= 0))');
  }, 30_000);
  afterAll(async () => {
    await peer?.close(); await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  });
  async function account(): Promise<string> {
    const id = randomUUID();
    await database.db.insert(accounts).values({ id, createdAt: new Date(clock.nowMs()) });
    await database.pool.query('INSERT INTO command_test_stock(account_id, quantity) VALUES ($1, 5)', [id]);
    return id;
  }
  const envelope = (payload = { item: 'potion' }): CommandEnvelope => ({ commandId: randomUUID(), operation: 'inventory.usePotion', payload });
  const consume = (accountId: string) => async (tx: CommandTransaction) => {
    const result = await tx.execute<{ quantity: number }>(sql`UPDATE command_test_stock SET quantity = quantity - 1 WHERE account_id = ${accountId} AND quantity > 0 RETURNING quantity`);
    return { status: 200, body: { remaining: result.rows[0]?.quantity ?? 0 } };
  };
  async function stock(id: string): Promise<number | undefined> {
    return (await database.pool.query<{ quantity: number }>('SELECT quantity FROM command_test_stock WHERE account_id = $1', [id])).rows[0]?.quantity;
  }
  it.each([{ status: null, body: '{}' }, { status: 200, body: null }])('rejects mismatched response nullability at the SQL constraint: %j', async ({ status, body }) => {
    const id = await account();
    await expect(database.pool.query(`INSERT INTO command_log
      (account_id, command_id, operation, fingerprint, created_at, expires_at, response_status, response_body)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, randomUUID(), 'inventory.usePotion', 'a'.repeat(64), new Date(clock.nowMs()), new Date(clock.nowMs() + 1), status, body]))
      .rejects.toMatchObject({ code: '23514', constraint: 'command_log_response' });
    expect(await database.db.select().from(commandLog).where(eq(commandLog.accountId, id))).toEqual([]);
  });
  it('stores the exact status/body and replays a lost response without consuming another potion', async () => {
    const id = await account(); const command = envelope();
    const result = await runCommand(database, clock, id, command, consume(id));
    expect(result).toEqual({ status: 200, body: { remaining: 4 } });
    expect(await runCommand(peer, clock, id, command, consume(id))).toEqual(result);
    expect(await stock(id)).toBe(4);
    const [row] = await database.db.select().from(commandLog).where(and(eq(commandLog.accountId, id), eq(commandLog.commandId, command.commandId)));
    expect(row?.responseBody).toBe(JSON.stringify(result.body));
    expect(row?.createdAt.getTime()).toBe(clock.nowMs());
  });
  it('executes racing duplicate requests once across pools', async () => {
    const id = await account(); const command = envelope(); let calls = 0;
    const handler = async (tx: CommandTransaction) => { calls++; return consume(id)(tx); };
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => runCommand(index % 2 ? peer : database, clock, id, command, handler)));
    expect(calls).toBe(1);
    expect(responses).toEqual(Array.from({ length: 12 }, () => ({ status: 200, body: { remaining: 4 } })));
    expect(await stock(id)).toBe(4);
  });
  it('isolates accounts and rejects payload or operation reuse without changing stock', async () => {
    const first = await account(); const second = await account(); const command = envelope();
    await runCommand(database, clock, first, command, consume(first));
    expect(await runCommand(database, clock, second, command, consume(second))).toEqual({ status: 200, body: { remaining: 4 } });
    for (const changed of [{ ...command, payload: { item: 'elixir' } }, { ...command, operation: 'inventory.discard' }]) {
      expect(await runCommand(database, clock, first, changed, consume(first))).toEqual({ status: 409, body: { error: 'command_id_conflict' } });
    }
    expect(await stock(first)).toBe(4); expect(await stock(second)).toBe(4);
  });
  it('canonicalizes key order, but distinguishes array order', async () => {
    const id = await account(); const command = { ...envelope(), payload: { a: 1, b: [1, 2] } };
    const response = await runCommand(database, clock, id, command, consume(id));
    expect(await runCommand(database, clock, id, { ...command, payload: { b: [1, 2], a: 1 } }, consume(id))).toEqual(response);
    expect((await runCommand(database, clock, id, { ...command, payload: { a: 1, b: [2, 1] } }, consume(id))).status).toBe(409);
    expect(await stock(id)).toBe(4);
  });
  it('rolls back both stock and command on handler failure, then permits a successful retry', async () => {
    const id = await account(); const command = envelope();
    await expect(runCommand(database, clock, id, command, async (tx) => { await consume(id)(tx); throw new Error('mutation failed'); })).rejects.toThrow('mutation failed');
    expect(await stock(id)).toBe(5);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.accountId, id))).toEqual([]);
    expect((await runCommand(database, clock, id, command, consume(id))).body).toEqual({ remaining: 4 });
  });
  it('lets a racing retry own the command after the first transaction rolls back', async () => {
    const id = await account(); const command = envelope();
    let started: (() => void) | undefined; let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const failed = runCommand(database, clock, id, command, async (tx) => {
      await consume(id)(tx); started?.(); await hold; throw new Error('owner failed');
    });
    const rejection = expect(failed).rejects.toThrow('owner failed');
    await entered;
    const retry = runCommand(peer, clock, id, command, consume(id));
    release?.(); await rejection;
    expect(await retry).toEqual({ status: 200, body: { remaining: 4 } });
    expect(await stock(id)).toBe(4);
  });
  it('rolls back invalid responses instead of committing an unreplayable mutation', async () => {
    const id = await account(); const command = envelope();
    await expect(runCommand(database, clock, id, command, async (tx) => { await consume(id)(tx); return { status: 200, body: { invalid: Infinity } }; })).rejects.toThrow(TypeError);
    expect(await stock(id)).toBe(5);
    expect(await database.db.select().from(commandLog).where(eq(commandLog.accountId, id))).toEqual([]);
  });
  it('returns 410 at expiry, compacts bounded batches, and never repeats a tombstoned command', async () => {
    const id = await account(); const commands = [envelope(), envelope()];
    for (const command of commands) await runCommand(database, clock, id, command, consume(id), { retentionMs: 1 });
    clock.advance(1);
    expect((await runCommand(database, clock, id, commands[0] as CommandEnvelope, consume(id))).status).toBe(410);
    expect(await cleanupExpiredCommands(database, clock, 1)).toBe(1);
    expect(await cleanupExpiredCommands(peer, clock, 1)).toBe(1);
    expect(await cleanupExpiredCommands(database, clock, 1)).toBe(0);
    for (const command of commands) expect((await runCommand(database, clock, id, command, consume(id))).status).toBe(410);
    const rows = await database.db.select().from(commandLog).where(eq(commandLog.accountId, id));
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row.responseBody).toBeNull(); expect(row.responseStatus).toBeNull(); expect(row.tombstonedAt?.getTime()).toBe(clock.nowMs()); }
    expect((await runCommand(database, clock, id, { ...commands[0] as CommandEnvelope, operation: 'inventory.discard' }, consume(id))).status).toBe(409);
    expect(await stock(id)).toBe(3);
  });
  it('serializes cleanup versus concurrent expired retries safely', async () => {
    const id = await account(); const command = envelope();
    await runCommand(database, clock, id, command, consume(id), { retentionMs: 1 }); clock.advance(1);
    const [response] = await Promise.all([runCommand(peer, clock, id, command, consume(id)), cleanupExpiredCommands(database, clock)]);
    expect(response.status).toBe(410); expect(await stock(id)).toBe(4);
    expect((await runCommand(database, clock, id, command, consume(id))).status).toBe(410);
  });
  it('skips locked expired rows without blocking a replay transaction', async () => {
    const id = await account(); const command = envelope();
    await runCommand(database, clock, id, command, consume(id), { retentionMs: 1 }); clock.advance(1);
    await database.db.transaction(async (tx) => {
      await tx.select().from(commandLog).where(and(eq(commandLog.accountId, id), eq(commandLog.commandId, command.commandId))).for('update');
      expect(await cleanupExpiredCommands(peer, clock)).toBe(0);
    });
    expect(await cleanupExpiredCommands(database, clock)).toBe(1);
    expect(await stock(id)).toBe(4);
  });
  it('uses one runner for HTTP and decoded WebSocket adapters', async () => {
    const id = await account(); const command = envelope();
    const dispatch = (message: CommandEnvelope) => runCommand(database, clock, id, message, consume(id));
    const app = Fastify();
    app.post<{ Body: CommandEnvelope }>('/fixture/potion', async (request, reply) => { const result = await dispatch(request.body); return reply.code(result.status).send(result.body); });
    try {
      const http = await app.inject({ method: 'POST', url: '/fixture/potion', payload: command });
      const websocket = await dispatch(JSON.parse(JSON.stringify(command)) as CommandEnvelope);
      expect({ status: http.statusCode, body: http.json() }).toEqual(websocket);
      expect(await stock(id)).toBe(4);
    } finally { await app.close(); }
  });
});
