import { check, foreignKey, index, jsonb, pgTable, timestamp, unique, uniqueIndex, uuid, text, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { characters } from '../characters/schema.ts';

/** Durable live death and corpse record; corpse contents themselves remain authoritative ledger holdings. */
export const liveDeaths = pgTable('rpg_live_deaths', {
  deathId: uuid('death_id').primaryKey(), actorId: uuid('actor_id').notNull(), instanceId: uuid('instance_id').notNull(),
  areaId: text('area_id').notNull(), locationId: text('location_id').notNull(), occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(), status: text('status').notNull(),
  xpBeforeLevel: integer('xp_before_level').notNull(), xpBeforeIntoLevel: integer('xp_before_into_level').notNull(), xpBeforeTotal: integer('xp_before_total').notNull(),
  xpLost: integer('xp_lost').notNull(), xpAfterLevel: integer('xp_after_level').notNull(), xpAfterIntoLevel: integer('xp_after_into_level').notNull(), xpAfterTotal: integer('xp_after_total').notNull(),
  causes: jsonb('causes').$type<readonly { sourceId: string; label: string; damage: number }[]>().notNull(),
  bagSnapshot: jsonb('bag_snapshot').$type<{ stacks: { item: string; qty: number }[]; gold: number;
    uniques: { itemId: string; definition: string; slot: string | null; rolls: unknown }[] }>().notNull(),
}, table => [
  foreignKey({ name: 'rpg_live_deaths_actor_fk', columns: [table.actorId], foreignColumns: [characters.actorId] }).onDelete('cascade'),
  unique('rpg_live_deaths_instance_actor').on(table.instanceId, table.actorId),
  uniqueIndex('rpg_live_deaths_one_active_actor').on(table.actorId).where(sql`${table.status} = 'active'`),
  index('rpg_live_deaths_actor_recent').on(table.actorId, table.occurredAt.desc()),
  check('rpg_live_deaths_status', sql`${table.status} IN ('active','recovered','expired','invalidated')`),
  check('rpg_live_deaths_xp', sql`${table.xpBeforeLevel} >= 1 AND ${table.xpBeforeIntoLevel} >= 0 AND ${table.xpBeforeTotal} >= 0 AND ${table.xpLost} >= 0 AND ${table.xpAfterLevel} >= 1 AND ${table.xpAfterIntoLevel} >= 0 AND ${table.xpAfterTotal} >= 0`),
]);
