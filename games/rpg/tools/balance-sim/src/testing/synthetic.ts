/**
 * A tiny synthetic content set and scenario with outcomes known in advance (test fixture, not content):
 * - `enemy:t_dummy` (1 HP, harmless self-buff) dies to the hero's first hit at tick 1;
 * - `enemy:t_brute` (huge HP and power) acts first on equal initiative and one-shots the hero at tick 1.
 */
import {
  EncounterTableSchema,
  EnemySchema,
  IdleActivitySchema,
  ItemSchema,
  LootTableSchema,
  SkillSchema,
} from '@rpg/rpg-schema';
import { AutomationRulesSchema } from '@rpg/rpg-schema';

import type { BalanceContent } from '../content.ts';
import type { HeroBuildDef, Scenario } from '../scenario.ts';

const skills = [
  SkillSchema.parse({
    id: 'skill:t_hit',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [{ type: 'damage', coeffBp: 10000, school: 'physical' }],
  }),
  SkillSchema.parse({
    id: 'skill:t_idle',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'self',
    effects: [{ type: 'stat_mod', stat: 'armor', flat: 1, duration: { value: 1, unit: 'ticks' } }],
  }),
];

const enemies = [
  EnemySchema.parse({
    id: 'enemy:t_dummy',
    rank: 'normal',
    level: 1,
    stats: { maxHp: 1, power: 0 },
    skills: ['skill:t_idle'],
    ai: [{ when: {}, do: { useSkill: 'skill:t_idle' } }],
    xp: 7,
    lootTable: 'loot:t_dummy',
  }),
  EnemySchema.parse({
    id: 'enemy:t_brute',
    rank: 'normal',
    level: 1,
    stats: { maxHp: 100000, power: 100000 },
    skills: ['skill:t_hit'],
    ai: [{ when: {}, do: { useSkill: 'skill:t_hit' } }],
    xp: 1000,
  }),
];

const items = [
  ItemSchema.parse({ id: 'item:t_trinket', kind: 'material', value: 3, stackable: true, maxStack: 99 }),
  ItemSchema.parse({ id: 'item:t_potion', kind: 'consumable', value: 1, stackable: true, maxStack: 20, use: [{ type: 'heal', coeffBp: 3000, to: 'self' }] }),
];

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

export const SYNTHETIC_CONTENT: BalanceContent = {
  contentHash: 'synthetic',
  combat: { skills: byId(skills), items: byId(items), enemies: byId(enemies) },
  encounterTables: byId([
    EncounterTableSchema.parse({ id: 'enc:t_easy', entries: [{ weight: 1, enemies: [{ enemy: 'enemy:t_dummy', count: 1 }] }] }),
    EncounterTableSchema.parse({ id: 'enc:t_hard', entries: [{ weight: 1, enemies: [{ enemy: 'enemy:t_brute', count: 1 }] }] }),
  ]),
  lootTables: byId([
    LootTableSchema.parse({ id: 'loot:t_dummy', rolls: 0, guaranteed: [{ item: 'item:t_trinket', qty: { min: 1, max: 1 } }], gold: { min: 2, max: 2 } }),
  ]),
  idleActivities: byId([
    IdleActivitySchema.parse({ id: 'idle:t_easy', encountersPerHour: 10, encounterTable: 'enc:t_easy' }),
    IdleActivitySchema.parse({ id: 'idle:t_hard', encountersPerHour: 10, encounterTable: 'enc:t_hard' }),
  ]),
};

const LOADOUT = {
  skills: ['skill:t_hit'],
  rules: AutomationRulesSchema.parse([{ when: {}, do: { useSkill: 'skill:t_hit' } }]),
};

export const SYNTHETIC_BUILD: HeroBuildDef = {
  key: 'tester',
  name: 'Tester',
  attributesByLevel: { 1: { STR: 10, AGI: 0, INT: 0, VIT: 0, SPI: 0 }, 2: { STR: 11, AGI: 0, INT: 0, VIT: 0, SPI: 0 } },
  gearByLevel: () => [],
  loadout: LOADOUT,
  bossLoadout: LOADOUT,
  live: {},
};

export const SYNTHETIC_SCENARIO: Scenario = {
  name: 'synthetic',
  builds: [SYNTHETIC_BUILD],
  cellTables: ['enc:t_easy', 'enc:t_hard'],
  boss: 'enemy:t_brute',
  potion: 'item:t_potion',
  cellPotions: 0,
  bossPotions: 0,
  idleActivities: ['idle:t_easy', 'idle:t_hard'],
  idlePotionsPerHour: 0,
  liveRoute: {
    name: 'synthetic route',
    encountersPerHour: 4,
    tables: ['enc:t_easy', 'enc:t_hard'],
    skipGroupsOnlyOf: ['enemy:t_brute'],
    restBetweenFightsBp: 0,
    potionsPerHour: 0,
  },
};
