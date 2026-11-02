import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { accounts } from '../auth/schema.ts';

/** Retain the composite key after response expiry: deletion would permit a duplicate mutation. */
export const commandLog = pgTable('command_log', {
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  commandId: uuid('command_id').notNull(),
  operation: text('operation').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  tombstonedAt: timestamp('tombstoned_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.commandId] }),
  index('command_log_expiry_idx').on(table.expiresAt).where(sql`${table.tombstonedAt} IS NULL`),
  check('command_log_fingerprint', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
  check('command_log_response', sql`(${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL) OR (${table.responseStatus} IS NOT NULL AND ${table.responseStatus} BETWEEN 200 AND 599 AND ${table.responseBody} IS NOT NULL)`),
  check('command_log_tombstone', sql`${table.tombstonedAt} IS NULL OR (${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL)`),
]);
