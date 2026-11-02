import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { actors } from '@engine/server-kit';
import type { AutomationRules, SkillId } from '@rpg/rpg-schema';

import type { CharacterAttributes } from './validation.ts';

/** Game-owned actor extension. The composite FK prevents spoofing the owner used by the per-game unique key. */
export const characters = pgTable('rpg_characters', {
  actorId: uuid('actor_id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  gameId: text('game_id').notNull().default('rpg'),
  name: text('name').notNull(),
  level: integer('level').notNull().default(1),
  xp: integer('xp').notNull().default(0),
  attributes: jsonb('attributes').$type<CharacterAttributes>().notNull(),
  unspentPoints: integer('unspent_points').notNull().default(0),
  skillLoadout: jsonb('skill_loadout').$type<SkillId[]>().notNull(),
  automationRules: jsonb('automation_rules').$type<AutomationRules>().notNull(),
}, table => [
  foreignKey({ name: 'rpg_characters_actor_owner_game', columns: [table.actorId, table.accountId, table.gameId],
    foreignColumns: [actors.actorId, actors.accountId, actors.gameId] }),
  unique('rpg_characters_one_per_account_game').on(table.accountId, table.gameId),
  check('rpg_characters_game', sql`${table.gameId} = 'rpg'`),
  check('rpg_characters_name', sql`length(trim(${table.name})) BETWEEN 1 AND 32`),
  check('rpg_characters_progress', sql`${table.level} >= 1 AND ${table.xp} >= 0 AND ${table.unspentPoints} >= 0`),
  check('rpg_characters_loadout', sql`jsonb_typeof(${table.skillLoadout}) = 'array' AND jsonb_array_length(${table.skillLoadout}) <= 4`),
  check('rpg_characters_rules', sql`jsonb_typeof(${table.automationRules}) = 'array' AND jsonb_array_length(${table.automationRules}) <= 6`),
]);
export type Character = typeof characters.$inferSelect;
