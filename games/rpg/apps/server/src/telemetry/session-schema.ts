import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { accounts } from '@engine/server-kit';

/** Server-authenticated socket connection intervals; these do not represent foreground or gameplay activity. */
export const rpgConnectionSessions = pgTable('rpg_connection_sessions', {
  connectionId: uuid('connection_id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
}, table => [
  foreignKey({ name: 'rpg_connection_sessions_account_fk', columns: [table.accountId], foreignColumns: [accounts.id] }).onDelete('cascade'),
  check('rpg_connection_sessions_time_order', sql`${table.startedAt} <= ${table.lastSeenAt} AND (${table.endedAt} IS NULL OR ${table.lastSeenAt} <= ${table.endedAt})`),
  index('rpg_connection_sessions_account_idx').on(table.accountId),
]);

export type RpgConnectionSession = typeof rpgConnectionSessions.$inferSelect;
