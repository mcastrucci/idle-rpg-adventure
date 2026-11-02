import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { accounts } from '../auth/schema.ts';

/** Generic actor identity/activity ownership; game-specific character state lives in the game package. */
export const actors = pgTable('actors', {
  actorId: uuid('actor_id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  gameId: text('game_id').notNull(),
  activityState: text('activity_state', { enum: ['none', 'live', 'expedition'] }).notNull().default('none'),
  activityId: uuid('activity_id'),
  version: integer('version').notNull().default(0),
}, table => [
  check('actors_game_id', sql`length(${table.gameId}) > 0`),
  check('actors_activity_state', sql`${table.activityState} IN ('none', 'live', 'expedition')`),
  check('actors_activity_identity', sql`(${table.activityState} = 'none') = (${table.activityId} IS NULL)`),
  check('actors_version', sql`${table.version} >= 0`),
  // Composite reference lets game extensions prove account/game ownership without trusting denormalized values.
  unique('actors_identity_owner_game').on(table.actorId, table.accountId, table.gameId),
]);
export type Actor = typeof actors.$inferSelect;
export type ActivityState = Actor['activityState'];
export type ActorActivity = { state: 'none'; activityId: null } | { state: 'live' | 'expedition'; activityId: string };
