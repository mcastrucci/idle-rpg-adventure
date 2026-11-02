import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './database.ts';
import type { Database } from './database.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL migration tests');
const ENGINE_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LEGACY_LIVE_DIR = fileURLToPath(new URL('../migrations-live', import.meta.url));

describe.skipIf(!adminUrl)('engine migration adoption against real PostgreSQL', () => {
  let admin: Database;
  const databases: Array<{ name: string; database: Database }> = [];

  beforeAll(async () => {
    admin = createDatabase({ databaseUrl: adminUrl as string, poolMax: 8, databaseTimeoutMs: 5000 });
  }, 30000);

  afterAll(async () => {
    for (const entry of databases) await entry.database.close();
    if (admin) {
      try {
        for (const entry of databases) await admin.pool.query(`DROP DATABASE IF EXISTS "${entry.name}" WITH (FORCE)`);
      } finally { await admin.close(); }
    }
  }, 30000);

  it.each([2, 4])('adopts legacy live data after engine prefix %i and survives restart', async (prefix) => {
    const { database, name } = await createDatabasePair();
    await seedLegacyState(database, prefix);
    const instanceId = randomUUID();
    await database.pool.query(`INSERT INTO live_instances (instance_id, game_id, game_version, content_hash, participants,
      status, node_id, lease_generation, lease_expires_at, checkpoint, checkpoint_seq, created_at, updated_at)
      VALUES ($1, 'rpg', '1', repeat('a', 64), '[{"actorId":"00000000-0000-4000-8000-000000000001"}]',
      'active', 'legacy-node', 1, now() + interval '1 hour', '{"turn":7}', 11, now(), now())`, [instanceId]);

    await database.migrate();
    await database.verifyMigrations();
    const row = await database.pool.query<{ checkpoint_seq: number; checkpoint: { turn: number } }>(
      'SELECT checkpoint_seq, checkpoint FROM live_instances WHERE instance_id=$1', [instanceId]);
    expect(row.rows[0]).toEqual({ checkpoint_seq: 11, checkpoint: { turn: 7 } });
    const engineJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    const legacyJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM live_host_migrations.__drizzle_migrations');
    expect(Number(engineJournal.rows[0]?.count)).toBe(6);
    expect(Number(legacyJournal.rows[0]?.count)).toBe(1);

    await database.migrate();
    await database.verifyMigrations();
    const afterRestart = await database.pool.query<{ count: string }>('SELECT count(*) FROM live_instances WHERE instance_id=$1', [instanceId]);
    expect(Number(afterRestart.rows[0]?.count)).toBe(1);
    expect(name).toMatch(/^migration_test_/);
  }, 30000);

  it('rejects a legacy CHECK drift without applying the pending engine migrations', async () => {
    const { database } = await createDatabasePair();
    await seedLegacyState(database, 2);
    await database.pool.query(`ALTER TABLE live_instances DROP CONSTRAINT live_instances_generation;
      ALTER TABLE live_instances ADD CONSTRAINT live_instances_generation CHECK ((lease_generation >= 1) OR true)`);

    await expect(database.migrate()).rejects.toThrow('legacy live_instances constraints differ');
    const engineJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    expect(Number(engineJournal.rows[0]?.count)).toBe(3);
  }, 30000);

  it.each(['hash', 'timestamp'])('rejects a changed legacy journal %s before applying pending engine migrations', async (field) => {
    const { database } = await createDatabasePair();
    await seedLegacyState(database, 2);
    if (field === 'hash') await database.pool.query(`UPDATE live_host_migrations.__drizzle_migrations SET hash='tampered'`);
    else await database.pool.query(`UPDATE live_host_migrations.__drizzle_migrations SET created_at=created_at+1`);

    await expect(database.migrate()).rejects.toThrow('legacy live-host migration journal differs');
    const engineJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    expect(Number(engineJournal.rows[0]?.count)).toBe(3);
  }, 30000);

  it('refuses to adopt a live_instances table with no legacy journal', async () => {
    const { database } = await createDatabasePair();
    await seedLegacyState(database, 2);
    await database.pool.query('DROP SCHEMA live_host_migrations CASCADE');

    await expect(database.migrate()).rejects.toThrow('legacy live-host migration state is incomplete');
    const engineJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    expect(Number(engineJournal.rows[0]?.count)).toBe(3);
  }, 30000);

  it('creates one complete engine chain on a fresh database and verifies it on restart', async () => {
    const { database } = await createDatabasePair();
    await database.migrate();
    await database.migrate();
    await database.verifyMigrations();
    const engineJournal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    const liveTable = await database.pool.query<{ exists: boolean }>(`SELECT to_regclass('public.live_instances') IS NOT NULL AS exists`);
    expect(Number(engineJournal.rows[0]?.count)).toBe(6);
    expect(liveTable.rows[0]?.exists).toBe(true);
  }, 30000);

  async function createDatabasePair(): Promise<{ name: string; database: Database }> {
    const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl as string); url.pathname = `/${name}`;
    const database = createDatabase({ databaseUrl: url.toString(), poolMax: 8, databaseTimeoutMs: 5000 });
    databases.push({ name, database });
    return { name, database };
  }
});

async function seedLegacyState(database: Database, enginePrefix: number): Promise<void> {
  const tempEngine = await mkdtemp(join(tmpdir(), 'engine-migrations-'));
  try {
    const sourceJournal = JSON.parse(await readFile(join(ENGINE_DIR, 'meta/_journal.json'), 'utf8')) as {
      version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const prefix = sourceJournal.entries.filter(entry => entry.idx <= enginePrefix);
    await mkdir(join(tempEngine, 'meta'), { recursive: true });
    await writeFile(join(tempEngine, 'meta/_journal.json'), JSON.stringify({ ...sourceJournal, entries: prefix }));
    for (const entry of prefix) await copyFile(join(ENGINE_DIR, `${entry.tag}.sql`), join(tempEngine, `${entry.tag}.sql`));
    await migrate(drizzle(database.pool), { migrationsFolder: tempEngine });
    await migrate(drizzle(database.pool), { migrationsFolder: LEGACY_LIVE_DIR, migrationsSchema: 'live_host_migrations' });
  } finally { await rm(tempEngine, { recursive: true, force: true }); }
}
