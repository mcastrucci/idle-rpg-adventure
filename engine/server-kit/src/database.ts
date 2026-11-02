import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import type { ServerConfig } from './config.ts';
import * as schema from './schema.ts';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));
const LEGACY_LIVE_MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations-live', import.meta.url));
const LIVE_HOST_SCHEMA = 'live_host_migrations';
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
          await preflightLegacyLiveInstances(client, sets[0] ?? ENGINE_MIGRATIONS);
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

/**
 * The live-host migration was historically optional. Before engine migration 0005 exists, recognize only the exact
 * legacy journal and table shape. 0005 is idempotent so Drizzle can still apply any missing engine prefix normally.
 */
async function preflightLegacyLiveInstances(client: pg.PoolClient, engine: MigrationSet): Promise<void> {
  const engineMigrations = readMigrationFiles({ migrationsFolder: engine.directory });
  const liveMigration = engineMigrations.find(migration => migration.sql.some(statement =>
    statement.includes('CREATE TABLE IF NOT EXISTS "live_instances"')));
  if (!liveMigration) throw new Error('live-host consolidation migration is missing from the engine chain');

  const engineJournal = await client.query<{ exists: boolean }>(`SELECT to_regclass('"${engine.schema}".__drizzle_migrations') IS NOT NULL AS exists`);
  if (engineJournal.rows[0]?.exists) {
    const alreadyApplied = await client.query<{ applied: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "${engine.schema}".__drizzle_migrations WHERE hash=$1) AS applied`, [liveMigration.hash]);
    if (alreadyApplied.rows[0]?.applied) return;
  }

  const legacySchema = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists`, [LIVE_HOST_SCHEMA]);
  const legacyJournalExists = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('"${LIVE_HOST_SCHEMA}".__drizzle_migrations') IS NOT NULL AS exists`);
  const tableExists = await client.query<{ exists: boolean }>(`SELECT to_regclass('public.live_instances') IS NOT NULL AS exists`);
  const hasSchema = legacySchema.rows[0]?.exists ?? false;
  const hasJournal = legacyJournalExists.rows[0]?.exists ?? false;
  const hasTable = tableExists.rows[0]?.exists ?? false;
  if (!hasSchema && !hasJournal && !hasTable) return;
  if (!hasSchema || !hasJournal || !hasTable) throw new Error('legacy live-host migration state is incomplete; refusing migration adoption');

  const expected = readMigrationFiles({ migrationsFolder: LEGACY_LIVE_MIGRATIONS_DIRECTORY });
  if (expected.length !== 1) throw new Error('legacy live-host migration history is unexpected');
  const applied = await client.query<{ hash: string; created_at: string }>(
    `SELECT hash, created_at FROM "${LIVE_HOST_SCHEMA}".__drizzle_migrations ORDER BY created_at, id`);
  if (applied.rows.length !== 1 || applied.rows[0]?.hash !== expected[0]?.hash ||
      Number(applied.rows[0]?.created_at) !== expected[0]?.folderMillis) {
    throw new Error('legacy live-host migration journal differs; refusing migration adoption');
  }
  await assertLegacyLiveInstanceLayout(client);
}

async function assertLegacyLiveInstanceLayout(client: pg.PoolClient): Promise<void> {
  const relation = await client.query<{ kind: string; persistence: string; row_security: boolean; force_row_security: boolean;
      trigger_count: string; rule_count: string }>(
    `SELECT relation.relkind AS kind, relation.relpersistence AS persistence, relation.relrowsecurity AS row_security,
       relation.relforcerowsecurity AS force_row_security,
       (SELECT count(*) FROM pg_trigger WHERE tgrelid=relation.oid AND NOT tgisinternal) AS trigger_count,
       (SELECT count(*) FROM pg_rewrite WHERE ev_class=relation.oid AND rulename <> '_RETURN') AS rule_count
     FROM pg_class relation WHERE relation.oid='public.live_instances'::regclass`);
  const relationRow = relation.rows[0];
  if (!relationRow || relationRow.kind !== 'r' || relationRow.persistence !== 'p' || relationRow.row_security ||
      relationRow.force_row_security || Number(relationRow.trigger_count) !== 0 || Number(relationRow.rule_count) !== 0) {
    throw new Error('legacy live_instances relation differs; refusing migration adoption');
  }

  const columns = await client.query<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema='public' AND table_name='live_instances' ORDER BY ordinal_position`);
  const expected = [
    ['instance_id', 'uuid', 'NO'], ['game_id', 'text', 'NO'], ['game_version', 'text', 'NO'],
    ['content_hash', 'text', 'NO'], ['participants', 'jsonb', 'NO'], ['status', 'text', 'NO'],
    ['node_id', 'text', 'NO'], ['lease_generation', 'int4', 'NO'], ['lease_expires_at', 'timestamptz', 'NO'],
    ['checkpoint', 'jsonb', 'NO'], ['checkpoint_seq', 'int4', 'NO'], ['outcome', 'text', 'YES'],
    ['result', 'jsonb', 'YES'], ['created_at', 'timestamptz', 'NO'], ['updated_at', 'timestamptz', 'NO'],
    ['closed_at', 'timestamptz', 'YES'],
  ];
  if (columns.rows.length !== expected.length || expected.some(([name, type, nullable], index) => {
    const actual = columns.rows[index];
    return actual?.column_name !== name || actual?.udt_name !== type || actual?.is_nullable !== nullable || actual?.column_default !== null;
  })) throw new Error('legacy live_instances columns differ; refusing migration adoption');

  const constraints = await client.query<{ name: string; type: string; definition: string; validated: boolean;
      deferrable: boolean; deferred: boolean; is_local: boolean; inheritance_count: number }>(
    `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition,
       convalidated AS validated, condeferrable AS deferrable, condeferred AS deferred,
       conislocal AS is_local, coninhcount AS inheritance_count
     FROM pg_constraint WHERE conrelid='public.live_instances'::regclass ORDER BY conname`);
  const expectedConstraints: Record<string, { type: string; expression: string }> = {
    live_instances_pkey: { type: 'p', expression: 'primary key instance_id' },
    live_instances_status: { type: 'c', expression: "status = any array['active'::text, 'closed'::text]" },
    live_instances_closed: { type: 'c', expression: "status = 'closed'::text = closed_at is not null" },
    live_instances_participants: { type: 'c', expression: "jsonb_typeof participants = 'array'::text and jsonb_array_length participants > 0" },
    live_instances_generation: { type: 'c', expression: 'lease_generation >= 1' },
    live_instances_checkpoint_seq: { type: 'c', expression: 'checkpoint_seq >= 0' },
    live_instances_ids: { type: 'c', expression: 'length game_id > 0 and length node_id > 0' },
  };
  const byName = new Map(constraints.rows.map(row => [row.name, { ...row, definition: normalizeExpression(row.definition) }]));
  if (byName.size !== Object.keys(expectedConstraints).length || Object.entries(expectedConstraints).some(([name, expectedConstraint]) => {
    const actual = byName.get(name);
    return !actual || actual.type !== expectedConstraint.type || actual.definition !== expectedConstraint.expression ||
      !actual.validated || actual.deferrable || actual.deferred || !actual.is_local || actual.inheritance_count !== 0;
  })) throw new Error('legacy live_instances constraints differ; refusing migration adoption');

  const indexes = await client.query<{ name: string; is_unique: boolean; valid: boolean; ready: boolean; is_primary: boolean;
      access_method: string; key_count: number; attribute_count: number; key: string; predicate: string | null }>(
    `SELECT index_relation.relname AS name, idx.indisunique AS is_unique, idx.indisvalid AS valid, idx.indisready AS ready,
       idx.indisprimary AS is_primary, am.amname AS access_method, idx.indnkeyatts AS key_count,
       idx.indnatts AS attribute_count, pg_get_indexdef(idx.indexrelid, 1, true) AS key,
       pg_get_expr(idx.indpred, idx.indrelid) AS predicate
     FROM pg_index idx JOIN pg_class index_relation ON index_relation.oid=idx.indexrelid
       JOIN pg_am am ON am.oid=index_relation.relam
     WHERE idx.indrelid='public.live_instances'::regclass ORDER BY index_relation.relname`);
  const pkIndex = indexes.rows.find(row => row.name === 'live_instances_pkey');
  const leaseIndex = indexes.rows.find(row => row.name === 'live_instances_lease_idx');
  if (indexes.rows.length !== 2 || !pkIndex?.is_primary || !pkIndex.is_unique || !pkIndex.valid || !pkIndex.ready ||
      pkIndex.access_method !== 'btree' || pkIndex.key_count !== 1 || pkIndex.attribute_count !== 1 || pkIndex.key !== 'instance_id' ||
      !leaseIndex || leaseIndex.is_primary || leaseIndex.is_unique || !leaseIndex.valid || !leaseIndex.ready ||
      leaseIndex.access_method !== 'btree' || leaseIndex.key_count !== 1 || leaseIndex.attribute_count !== 1 ||
      leaseIndex.key !== 'lease_expires_at' || normalizeExpression(leaseIndex.predicate ?? '') !== "status = 'active'::text") {
    throw new Error('legacy live_instances index differs; refusing migration adoption');
  }
}

function normalizeCatalog(value: string): string {
  return value.replaceAll('"', '').replaceAll(/\s+/g, ' ').toLowerCase();
}

/** PostgreSQL adds cosmetic parentheses around CHECK/index expressions; replace them with spaces to preserve tokens. */
function normalizeExpression(value: string): string {
  const source = normalizeCatalog(value).replace(/^check\s*/, '');
  let normalized = '';
  let inString = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      normalized += character;
      if (inString && source[index + 1] === "'") normalized += source[++index];
      else inString = !inString;
    } else if (!inString && (character === '(' || character === ')')) {
      normalized += ' ';
    } else {
      normalized += character;
    }
  }
  return normalized.replaceAll(/\s+/g, ' ').trim();
}
