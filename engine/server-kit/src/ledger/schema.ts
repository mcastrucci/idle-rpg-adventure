import { sql } from 'drizzle-orm';
import { bigint, check, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { actors } from '../actors/schema.ts';

/** Immutable request envelope for one ledger idempotency key. */
export const ledgerBatches = pgTable('ledger_batches', {
  sourceType: text('source_type').notNull(), sourceId: text('source_id').notNull(),
  fingerprint: text('fingerprint').notNull(), entryCount: integer('entry_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.sourceType, table.sourceId] }),
  check('ledger_batches_fingerprint', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
  check('ledger_batches_count', sql`${table.entryCount} >= 0`)]);

/** Append-only audit trail; a batch sequence is stable across retries. */
export const ledgerEntries = pgTable('ledger_entries', {
  entryNo: bigint('entry_no', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  id: uuid('id').defaultRandom().primaryKey(), actorId: uuid('actor_id').notNull().references(() => actors.actorId),
  assetKind: text('asset_kind').notNull(), assetRef: text('asset_ref').notNull(), qty: integer('qty').notNull(),
  fromContainer: text('from_container'), toContainer: text('to_container'), sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(), seq: integer('seq').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => [unique('ledger_entries_source_seq').on(table.sourceType, table.sourceId, table.seq),
  check('ledger_entries_asset_kind', sql`${table.assetKind} IN ('stack', 'currency', 'unique', 'unique_mint')`),
  check('ledger_entries_qty', sql`${table.qty} <> 0`), check('ledger_entries_seq', sql`${table.seq} >= 0`)]);

/** Materialized non-unique balances; the database prevents negative ownership. */
export const assetBalances = pgTable('asset_balances', {
  actorId: uuid('actor_id').notNull().references(() => actors.actorId), assetKind: text('asset_kind').notNull(),
  assetRef: text('asset_ref').notNull(), container: text('container').notNull(), qty: integer('qty').notNull(),
}, table => [primaryKey({ columns: [table.actorId, table.assetKind, table.assetRef, table.container] }),
  check('asset_balances_qty', sql`${table.qty} >= 0`),
  check('asset_balances_kind', sql`${table.assetKind} IN ('stack', 'currency')`)]);

/** Current ownership rows. Moving/equipping preserves the UUID and rolls JSON. */
export const itemInstances = pgTable('item_instances', {
  id: uuid('id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => actors.actorId),
  definition: text('definition').notNull(), container: text('container').notNull(), slot: text('slot'),
  rolls: jsonb('rolls').notNull().default({}), sourceType: text('source_type').notNull(), sourceId: text('source_id').notNull(),
  seq: integer('seq').notNull(), unit: integer('unit').notNull(),
}, table => [unique('item_instances_mint_key').on(table.sourceType, table.sourceId, table.seq, table.unit),
  check('item_instances_seq', sql`${table.seq} >= 0`), check('item_instances_unit', sql`${table.unit} >= 0`)]);

export type ItemInstanceRow = typeof itemInstances.$inferSelect;
