import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Generic account identity. Game actors reference this stable UUID; upgrades never replace it. */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});
export const guestCredentials = pgTable('guest_credentials', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: uuid('account_id').notNull().unique().references(() => accounts.id, { onDelete: 'cascade' }),
  disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
});
export const emailCredentials = pgTable('email_credentials', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
});
export const authSessions = pgTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [index('auth_sessions_account_idx').on(table.accountId)]);
/** Renewable ownership lease, shared across live processes. Lease IDs prevent stale socket cleanup releasing a successor. */
export const liveSessions = pgTable('live_sessions', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  sessionHash: text('session_hash').notNull().references(() => authSessions.tokenHash, { onDelete: 'cascade' }),
  leaseId: uuid('lease_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
});
