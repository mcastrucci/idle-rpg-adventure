import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liveInstances } from '@engine/server-kit';

import { characters } from '../characters/schema.ts';

/** Minimal durable facts for live analytics; gameplay/report data remains in its authoritative domain tables. */
export const rpgLiveEntries = pgTable('rpg_live_entries', {
  instanceId: uuid('instance_id').notNull(),
  actorId: uuid('actor_id').notNull(),
  areaId: text('area_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [
  primaryKey({ name: 'rpg_live_entries_pkey', columns: [table.instanceId, table.actorId] }),
  foreignKey({ name: 'rpg_live_entries_instance_fk', columns: [table.instanceId], foreignColumns: [liveInstances.instanceId] }).onDelete('cascade'),
  foreignKey({ name: 'rpg_live_entries_actor_fk', columns: [table.actorId], foreignColumns: [characters.actorId] }).onDelete('cascade'),
  check('rpg_live_entries_area', sql`length(${table.areaId}) > 0`),
]);

export const rpgLiveXpEvents = pgTable('rpg_live_xp_events', {
  instanceId: uuid('instance_id').notNull(),
  actorId: uuid('actor_id').notNull(),
  sourceId: text('source_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  /** `rpg-stats` retains XP overflow at max level, so the persisted delta is the actual applied total-XP change. */
  grantedXp: bigint('granted_xp', { mode: 'number' }).notNull(),
}, (table) => [
  primaryKey({ name: 'rpg_live_xp_events_semantic_key', columns: [table.instanceId, table.actorId, table.sourceId] }),
  foreignKey({ name: 'rpg_live_xp_events_instance_fk', columns: [table.instanceId], foreignColumns: [liveInstances.instanceId] }).onDelete('cascade'),
  foreignKey({ name: 'rpg_live_xp_events_actor_fk', columns: [table.actorId], foreignColumns: [characters.actorId] }).onDelete('cascade'),
  check('rpg_live_xp_events_source', sql`length(${table.sourceId}) > 0`),
  check('rpg_live_xp_events_granted_xp', sql`${table.grantedXp} > 0 AND ${table.grantedXp} <= 9007199254740991`),
]);
