import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import type { ServerConfig } from './config.ts';
import * as schema from './schema.ts';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));
/** Each layer owns its SQL and journal; game extensions follow the engine's migrations. */
export interface MigrationSet {
  readonly id: string;
  readonly directory: string;
  readonly schema: string;
}
export const ENGINE_MIGRATIONS: MigrationSet = { id: 'engine', directory: MIGRATIONS_DIRECTORY, schema: 'drizzle' };
export interface DatabaseOptions {
  readonly migrationSets?: readonly MigrationSet[];
  readonly onIdleError?: (error: Error) => void;
}

function migrationSets(options: DatabaseOptions): readonly MigrationSet[] {
  const sets = [ENGINE_MIGRATIONS, ...(options.migrationSets ?? [])];
  const ids = new Set<string>();
  const schemas = new Set<string>();
  for (const set of sets) {
    if (!/^[a-z][a-z0-9_]*$/.test(set.id) || !/^[a-z][a-z0-9_]*$/.test(set.schema) || !set.directory ||
        ids.has(set.id) || schemas.has(set.schema)) throw new Error('migration sets need unique safe IDs and journal schemas');
    ids.add(set.id); schemas.add(set.schema);
  }
  return sets.map((set) => ({ ...set }));
}

export function createDatabase(config: Pick<ServerConfig, 'databaseUrl' | 'poolMax' | 'databaseTimeoutMs'>, options: DatabaseOptions = {}) {
  const sets = migrationSets(options);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax,
    connectionTimeoutMillis: config.databaseTimeoutMs, query_timeout: config.databaseTimeoutMs,
    statement_timeout: config.databaseTimeoutMs, idleTimeoutMillis: 30000 });
  // Idle connection failures emit outside a query promise, including sockets still closing after pool.end().
  // Always consume the event; applications can subscribe or provide a safe telemetry callback.
  pool.on('error', (error: Error) => { options.onIdleError?.(error); });
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
        try {
          for (const set of sets) {
            await migrate(drizzle(client), { migrationsFolder: set.directory, migrationsSchema: set.schema });
          }
        }
        finally { await client.query('SELECT pg_advisory_unlock(4815162342)'); }
      } finally { client.release(); }
    },
    async verifyMigrations(): Promise<void> {
      for (const set of sets) {
        const expected = readMigrationFiles({ migrationsFolder: set.directory });
        // Journal schema identifiers are validated above, never derived from a request.
        const applied = await pool.query<{ hash: string; created_at: string }>(
          `SELECT hash, created_at FROM "${set.schema}".__drizzle_migrations ORDER BY created_at, id`);
        if (applied.rows.length !== expected.length || expected.some((migration, index) =>
          applied.rows[index]?.hash !== migration.hash || Number(applied.rows[index]?.created_at) !== migration.folderMillis)) {
          throw new Error(`database migration version differs for ${set.id}; run the matching migration command`);
        }
      }
    },
    close(): Promise<void> { closing ??= pool.end(); return closing; },
  };
}
export type Database = ReturnType<typeof createDatabase>;
