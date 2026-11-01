import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import type { ServerConfig } from './config.ts';
import * as schema from './schema.ts';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));
export function createDatabase(config: Pick<ServerConfig, 'databaseUrl' | 'poolMax' | 'databaseTimeoutMs'>) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax,
    connectionTimeoutMillis: config.databaseTimeoutMs, query_timeout: config.databaseTimeoutMs,
    statement_timeout: config.databaseTimeoutMs, idleTimeoutMillis: 30000 });
  const db = drizzle(pool, { schema });
  let closing: Promise<void> | undefined;
  return {
    db,
    pool,
    async ping(): Promise<void> { await pool.query('SELECT 1'); },
    async migrate(): Promise<void> {
      const client = await pool.connect();
      try {
        // Session lock serializes journal creation and migration application across booting processes.
        await client.query('SELECT pg_advisory_lock(4815162342)');
        try { await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIRECTORY }); }
        finally { await client.query('SELECT pg_advisory_unlock(4815162342)'); }
      } finally { client.release(); }
    },
    async verifyMigrations(): Promise<void> {
      const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIRECTORY });
      const applied = await pool.query<{ hash: string; created_at: string }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id');
      if (applied.rows.length !== expected.length || expected.some((migration, index) =>
        applied.rows[index]?.hash !== migration.hash || Number(applied.rows[index]?.created_at) !== migration.folderMillis)) {
        throw new Error('database migration version differs from this server; run the matching migration command');
      }
    },
    close(): Promise<void> { closing ??= pool.end(); return closing; },
  };
}
export type Database = ReturnType<typeof createDatabase>;
