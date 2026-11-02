import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export * from './auth/schema.ts';
export * from './actors/schema.ts';
export * from './commands/schema.ts';
export * from './ledger/schema.ts';
export * from './live-host/schema.ts';

/** Identifies immutable content versions observed by this deployment; game content stays in compiled bundles. */
export const contentReleases = pgTable('content_releases', {
  contentHash: text('content_hash').primaryKey(),
  game: text('game').notNull(),
  format: integer('format').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [
  check('content_releases_hash', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check('content_releases_format', sql`${table.format} > 0`),
]);

/** Durable application-clock schedules; pg-boss owns the runnable queue and execution state. */
export const scheduledJobs = pgTable('scheduled_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  singletonKey: text('singleton_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  dueAtMs: bigint('due_at_ms', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  promotedAt: timestamp('promoted_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('scheduled_jobs_name_key_unique').on(table.name, table.singletonKey),
  check('scheduled_jobs_name', sql`length(${table.name}) > 0`),
  check('scheduled_jobs_singleton_key', sql`length(${table.singletonKey}) > 0`),
  check('scheduled_jobs_due_at_ms', sql`${table.dueAtMs} >= 0`),
  index('scheduled_jobs_due_idx').on(table.dueAtMs).where(sql`${table.promotedAt} IS NULL`),
]);
