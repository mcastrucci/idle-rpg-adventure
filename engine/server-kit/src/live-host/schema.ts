import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { JsonValue, StoredParticipant } from '@engine/live-kernel';

/**
 * Live instance ownership and recovery state (ADR-0012). Owned by its own migration set (`LIVE_HOST_MIGRATIONS`) so the
 * module stays optional. `participants` mirrors the generic `participants[]` model; activity locks stay on `actors`.
 * Writes after creation are fenced on (node_id, lease_generation, checkpoint_seq) and an unexpired lease.
 */
export const liveInstances = pgTable('live_instances', {
  instanceId: uuid('instance_id').primaryKey(),
  gameId: text('game_id').notNull(),
  gameVersion: text('game_version').notNull(),
  contentHash: text('content_hash').notNull(),
  participants: jsonb('participants').$type<StoredParticipant[]>().notNull(),
  status: text('status', { enum: ['active', 'closed'] }).notNull(),
  nodeId: text('node_id').notNull(),
  leaseGeneration: integer('lease_generation').notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  checkpoint: jsonb('checkpoint').$type<JsonValue>().notNull(),
  checkpointSeq: integer('checkpoint_seq').notNull(),
  outcome: text('outcome'),
  result: jsonb('result').$type<JsonValue>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  check('live_instances_status', sql`${table.status} IN ('active', 'closed')`),
  check('live_instances_closed', sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`),
  check('live_instances_participants', sql`jsonb_typeof(${table.participants}) = 'array' AND jsonb_array_length(${table.participants}) > 0`),
  check('live_instances_generation', sql`${table.leaseGeneration} >= 1`),
  check('live_instances_checkpoint_seq', sql`${table.checkpointSeq} >= 0`),
  check('live_instances_ids', sql`length(${table.gameId}) > 0 AND length(${table.nodeId}) > 0`),
  index('live_instances_lease_idx').on(table.leaseExpiresAt).where(sql`${table.status} = 'active'`),
]);
export type LiveInstanceRow = typeof liveInstances.$inferSelect;
