import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { characters } from '../characters/schema.ts';

/** Full replay input and timeline are private server data; HTTP DTOs are constructed by the expedition service. */
export const expeditions = pgTable('rpg_expeditions', {
  id: uuid('id').primaryKey(),
  actorId: uuid('actor_id').notNull().references(() => characters.actorId),
  accountId: uuid('account_id').notNull(),
  areaId: text('area_id').notNull(),
  activityId: text('activity_id').notNull(),
  status: text('status', { enum: ['running', 'completed', 'cancelled'] }).notNull(),
  startsAtMs: bigint('starts_at_ms', { mode: 'number' }).notNull(),
  plannedEndsAtMs: bigint('planned_ends_at_ms', { mode: 'number' }).notNull(),
  endsAtMs: bigint('ends_at_ms', { mode: 'number' }).notNull(),
  durationMin: integer('duration_min').notNull(),
  paceBp: integer('pace_bp').notNull(),
  seed: text('seed').notNull(),
  revision: integer('revision').notNull().default(0),
  kernelVersion: text('kernel_version').notNull(),
  simulatorId: text('simulator_id').notNull(),
  simulatorVersion: text('simulator_version').notNull(),
  contentHash: text('content_hash').notNull(),
  budget: integer('budget').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  snapshot: jsonb('snapshot').$type<{ participants: readonly Record<string, unknown>[]; xpCurve: readonly number[] }>().notNull(),
  escrow: jsonb('escrow').$type<readonly Record<string, unknown>[]>().notNull(),
  timelineCompressed: text('timeline_compressed').notNull(),
  timelineHash: text('timeline_hash').notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
  settledReason: text('settled_reason', { enum: ['completed', 'cancelled', 'version_unavailable'] }),
  settledCutoff: integer('settled_cutoff'),
  outcome: text('outcome', { enum: ['completed', 'retreated', 'failed'] }),
  terminalReport: jsonb('terminal_report').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [
  check('rpg_expeditions_status', sql`${table.status} IN ('running', 'completed', 'cancelled')`),
  check('rpg_expeditions_times', sql`${table.startsAtMs} >= 0 AND ${table.plannedEndsAtMs} >= ${table.startsAtMs} AND ${table.endsAtMs} >= ${table.startsAtMs} AND ${table.endsAtMs} <= ${table.plannedEndsAtMs}`),
  check('rpg_expeditions_parameters', sql`${table.durationMin} > 0 AND ${table.paceBp} > 0 AND ${table.budget} > 0 AND ${table.revision} >= 0`),
  check('rpg_expeditions_snapshot', sql`jsonb_typeof(${table.config}) = 'object' AND jsonb_typeof(${table.snapshot}) = 'object' AND jsonb_typeof(${table.escrow}) = 'array'`),
  check('rpg_expeditions_settled_state', sql`(${table.status} = 'running' AND ${table.settledAt} IS NULL AND ${table.settledReason} IS NULL AND ${table.settledCutoff} IS NULL AND ${table.outcome} IS NULL AND ${table.terminalReport} IS NULL) OR (${table.status} = 'cancelled' AND ${table.settledAt} IS NOT NULL AND ((${table.settledReason} = 'cancelled' AND ${table.settledCutoff} IS NOT NULL) OR (${table.settledReason} = 'version_unavailable' AND ${table.settledCutoff} IS NULL)) AND ${table.outcome} IS NULL) OR (${table.status} = 'completed' AND ${table.settledAt} IS NOT NULL AND ${table.settledReason} = 'completed' AND ${table.settledCutoff} IS NOT NULL AND ${table.outcome} IS NOT NULL)`),
  index('rpg_expeditions_actor_created').on(table.actorId, table.createdAt),
  index('rpg_expeditions_running_end').on(table.endsAtMs).where(sql`${table.status} = 'running'`),
]);

export type Expedition = typeof expeditions.$inferSelect;

/** Persisted world completion inputs. Only trusted game services write these; there is no client completion API. */
export const rpgAreaDiscoveries = pgTable('rpg_area_discoveries', {
  actorId: uuid('actor_id').notNull().references(() => characters.actorId, { onDelete: 'cascade' }),
  areaId: text('area_id').notNull(), locationId: text('location_id').notNull(),
  discoveredAt: timestamp('discovered_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [unique('rpg_area_discoveries_pk').on(table.actorId, table.areaId, table.locationId)]);

export const rpgCompletedAreas = pgTable('rpg_completed_areas', {
  actorId: uuid('actor_id').notNull().references(() => characters.actorId, { onDelete: 'cascade' }),
  areaId: text('area_id').notNull(), completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [unique('rpg_completed_areas_pk').on(table.actorId, table.areaId)]);

export const rpgActorObjectives = pgTable('rpg_actor_objectives', {
  actorId: uuid('actor_id').notNull().references(() => characters.actorId, { onDelete: 'cascade' }),
  objectiveKey: text('objective_key').notNull(), recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [unique('rpg_actor_objectives_pk').on(table.actorId, table.objectiveKey)]);
