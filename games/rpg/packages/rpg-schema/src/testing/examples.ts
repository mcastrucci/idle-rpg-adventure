/**
 * Example content (from the specs where they exist) shared by the tests. Valid unless stated otherwise.
 */
import type { z } from 'zod';

/** docs/spec/content-format.md §3 `skill.json`. */
export const shieldBash = {
  id: 'skill:shield_bash',
  cooldownTicks: 8,
  windupTicks: 0,
  targeting: 'enemy',
  effects: [
    { type: 'damage', coeffBp: 8000, school: 'physical' },
    { type: 'taunt', duration: { value: 3, unit: 'attacks' } },
  ],
};

export const crushingBlow = {
  id: 'skill:crushing_blow',
  cooldownTicks: 12,
  windupTicks: 3,
  targeting: 'enemy',
  effects: [
    { type: 'damage', coeffBp: 25000, school: 'physical' },
    { type: 'stun', duration: { value: 2, unit: 'ticks' } },
  ],
};

/** docs/spec/combat-engine.md §6. */
export const specAutomationRules = [
  { when: { selfHpBelowBp: 3500 }, do: { useConsumable: 'item:minor_healing_potion' } },
  { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
  { when: { allyHpBelowBp: 5000, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'lowestHpAlly' } },
  { when: { skillReady: 'skill:cleave', enemiesAtLeast: 2 }, do: { useSkill: 'skill:cleave' } },
  { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
];

export const minorHealingPotion = {
  id: 'item:minor_healing_potion',
  kind: 'consumable',
  value: 5,
  stackable: true,
  maxStack: 20,
  use: [{ type: 'heal', coeffBp: 3000, to: 'self' }],
};

export const rustySword = {
  id: 'item:rusty_sword',
  kind: 'equipment',
  slot: 'weapon',
  stats: { power: 4, critBp: 150 },
  value: 12,
};

export const thornbackBoar = {
  id: 'enemy:thornback_boar',
  rank: 'normal',
  level: 2,
  stats: { maxHp: 60, power: 8, armor: 3 },
  skills: ['skill:basic_attack', 'skill:gore'],
  ai: [
    { when: { skillReady: 'skill:gore', selfHpBelowBp: 5000 }, do: { useSkill: 'skill:gore', target: 'lowestHpEnemy' } },
    { when: {}, do: { useSkill: 'skill:basic_attack' } },
  ],
  xp: 15,
  lootTable: 'loot:boar_common',
  tags: ['beast'],
};

export const hollowMatriarch = {
  id: 'enemy:hollow_matriarch',
  rank: 'boss',
  level: 6,
  stats: { maxHp: 900, power: 20, armor: 10, resist: 5 },
  skills: ['skill:basic_attack', 'skill:crushing_blow', 'skill:summon_roots'],
  ai: [{ when: {}, do: { useSkill: 'skill:basic_attack' } }],
  xp: 400,
  lootTable: 'loot:matriarch',
  phases: [
    { fromHpBp: 10000, rotation: ['skill:basic_attack', 'skill:crushing_blow'], telegraphs: ['skill:crushing_blow'] },
    { fromHpBp: 4000, rotation: ['skill:summon_roots', 'skill:crushing_blow', 'skill:basic_attack'], telegraphs: ['skill:crushing_blow'] },
  ],
};

export const boarLoot = {
  id: 'loot:boar_common',
  rolls: 1,
  nothingWeight: 50,
  entries: [
    { item: 'item:boar_hide', weight: 40, qty: { min: 1, max: 2 } },
    { item: 'item:minor_healing_potion', weight: 10 },
  ],
  guaranteed: [{ item: 'item:raw_meat' }],
  gold: { min: 1, max: 4 },
};

export const wellEncounters = {
  id: 'enc:verdant_hollow.well',
  entries: [
    { weight: 70, enemies: [{ enemy: 'enemy:thornback_boar' }] },
    { weight: 30, enemies: [{ enemy: 'enemy:thornback_boar', count: 2 }] },
  ],
};

export const glowcap = { id: 'res:glowcap', gatherTicks: 6 };

export const huntActivity = {
  id: 'idle:verdant_hollow.hunt',
  encountersPerHour: 12,
  encounterTable: 'enc:verdant_hollow.hunt',
  resourceYields: [{ node: 'res:glowcap', lootTable: 'loot:glowcap_gather', rollsPerHour: 2 }],
};

/** content-format §3 region.json, migrated to the engine area model. */
export const verdantHollow = {
  id: 'area:verdant_hollow',
  kind: 'explorable',
  nameKey: 'area.verdant_hollow.name',
  difficulty: 1,
  recommendedLevel: [1, 6],
  startLocation: 'loc:verdant_hollow.portal_clearing',
  locations: ['loc:verdant_hollow.portal_clearing', 'loc:verdant_hollow.old_well', 'loc:verdant_hollow.well_bottom'],
  completion: {
    pool: { tag: 'ordinary' },
    thresholdBp: 7000,
    required: { all: [{ game: 'defeated', enemy: 'enemy:hollow_matriarch' }] },
    frozen: { poolSize: 10, requiredCount: 7, at: '2026-12-01' },
  },
  activities: ['idle:verdant_hollow.hunt', 'idle:verdant_hollow.gather'],
};

/** content-format §3 location.json, migrated to the engine location model. */
export const oldWell = {
  id: 'loc:verdant_hollow.old_well',
  tags: ['ordinary'],
  scene: 'scenes/old_well.tmj',
  exits: [
    { id: 'exit:verdant_hollow.old_well.north', to: 'loc:verdant_hollow.portal_clearing' },
    {
      id: 'exit:verdant_hollow.old_well.down',
      to: 'loc:verdant_hollow.well_bottom',
      requires: { hasItem: { item: 'item:rope', qty: 1 } },
    },
  ],
  encounters: 'enc:verdant_hollow.well',
  resources: [{ node: 'res:glowcap', lootTable: 'loot:glowcap_gather' }],
  hotspots: [{ id: 'inscription', type: 'lore', textKey: 'lore.old_well.inscription' }],
};

export const xpCurve = { xpToNext: [100, 250, 450, 700, 1000] };

/** Paths (dot-joined) of every issue of a failed parse; `[]` when the parse succeeded. */
export function issuePaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}
