import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { contentReleases, createDatabase, createServer, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ProcessRole, ServerConfig, ServerModule } from '@engine/server-kit';
import rpgContentPlugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from './index.ts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { MIGRATIONS_DIRECTORY } from '@engine/server-kit';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL integration tests');

/** Uses a new disposable database, never clears the database named by TEST_DATABASE_URL. Requires CREATEDB. */
describe.skipIf(!adminUrl)('server foundation against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  const databaseName = `server_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_000_000);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'server-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../content', import.meta.url)), rpgContentPlugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(compiled.bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    // Both processes race on a fresh schema, including migration journal initialization.
    const concurrent = createRpgDatabase(config);
    try { await Promise.all([database.migrate(), concurrent.migrate()]); }
    finally { await concurrent.close(); }
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('replays migrations idempotently and rolls back transactions', async () => {
    await database.migrate();
    await database.verifyMigrations();
    const journal = await database.pool.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    expect(Number(journal.rows[0]?.count)).toBe(readMigrationFiles({ migrationsFolder: MIGRATIONS_DIRECTORY }).length);
    await expect(database.db.transaction(async (tx) => {
      await tx.insert(contentReleases).values({ contentHash: 'a'.repeat(64), game: 'test', format: 1, firstSeenAt: new Date(clock.nowMs()) });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await database.db.select().from(contentReleases)).toEqual([]);
  });

  it('verifies the RPG journal as well as the generic engine journal before boot', async () => {
    const rows = await database.pool.query<{id:number;hash:string}>('SELECT id,hash FROM rpg_migrations.__drizzle_migrations ORDER BY id');
    const row = rows.rows[0];
    if (!row) throw new Error('missing RPG journal fixture');
    try {
      await database.pool.query('UPDATE rpg_migrations.__drizzle_migrations SET hash=$1 WHERE id=$2', ['0'.repeat(64), row.id]);
      const engineOnly = createDatabase(config);
      try { await engineOnly.verifyMigrations(); } finally { await engineOnly.close(); }
      await expect(createRpgServer(config)).rejects.toThrow('database migration version differs for rpg');
    } finally {
      await database.pool.query('UPDATE rpg_migrations.__drizzle_migrations SET hash=$1 WHERE id=$2', [row.hash, row.id]);
    }
    await database.verifyMigrations();
  });

  it('boots RPG content, reports its hash, and records the injected clock once per content release', async () => {
    const app = await createRpgServer(config, { clock });
    try {
      const health = await app.inject('/health/ready');
      expect(health.statusCode).toBe(200);
      const content = await app.inject('/content');
      const dto = content.json<{ contentHash: string; game: string }>();
      expect(dto.game).toBe('rpg');
      expect(health.json<{ contentHash: string }>().contentHash).toBe(dto.contentHash);
      expect(content.body).not.toContain('collections');
      const rows = await database.db.select().from(contentReleases);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.firstSeenAt.getTime()).toBe(clock.nowMs());
    } finally { await app.close(); }
    const again = await createRpgServer(config, { clock: new ManualClock(2_000_000) });
    await again.close();
    expect((await database.db.select().from(contentReleases))[0]?.firstSeenAt.getTime()).toBe(clock.nowMs());
  });

  it.each<ProcessRole>(['api', 'live', 'worker'])('starts only modules assigned to %s and closes modules before the pool', async (role) => {
    const started: string[] = [];
    const stopped: string[] = [];
    let moduleDatabase: Database | undefined;
    const modules: ServerModule[] = (['ledger', 'live-host', 'jobs'] as const).map((name, index) => ({
      name, roles: [(['api', 'live', 'worker'] as const)[index] as ProcessRole],
      async register(app, context) {
        started.push(name); moduleDatabase = context.database;
        app.get(`/test/${name}`, async () => ({ nowMs: context.clock.nowMs() }));
        app.addHook('onClose', async () => { await context.database.ping(); stopped.push(name); });
      },
    }));
    const app = await createRpgServer({ ...config, roles: [role] }, { clock, modules });
    try {
      const active = role === 'api' ? 'ledger' : role === 'live' ? 'live-host' : 'jobs';
      expect(started).toEqual([active]);
      expect((await app.inject(`/test/${active}`)).json()).toEqual({ nowMs: clock.nowMs() });
      expect((await app.inject('/content')).statusCode).toBe(role === 'api' ? 200 : 404);
      expect((await app.inject('/health/ready')).statusCode).toBe(200);
    } finally { await app.close(); }
    expect(stopped).toEqual(started);
    await expect(moduleDatabase?.ping()).rejects.toThrow();
  });

  it('returns sanitized readiness failure while liveness remains available', async () => {
    let moduleDatabase: Database | undefined;
    const app = await createRpgServer(config, { modules: [{ name: 'debug', roles: ['api'],
      async register(_app, context) { moduleDatabase = context.database; },
    }] });
    try {
      await moduleDatabase?.close();
      const ready = await app.inject('/health/ready');
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ status: 'unavailable' });
      expect(ready.body).not.toMatch(/postgres|password|DATABASE_URL/);
      expect((await app.inject('/health/live')).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('closes the pool when a module fails during startup', async () => {
    let failedDatabase: Database | undefined;
    await expect(createServer({ config, game: 'rpg', modules: [{ name: 'debug', roles: ['api'],
      async register(_app, context) { failedDatabase = context.database; throw new Error('module boot failed'); },
    }] })).rejects.toThrow('module boot failed');
    expect(failedDatabase).toBeDefined();
    await expect(failedDatabase?.ping()).rejects.toThrow();
  });
});
