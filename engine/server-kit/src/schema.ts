import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export * from './auth/schema.ts';
export * from './actors/schema.ts';
export * from './commands/schema.ts';

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
