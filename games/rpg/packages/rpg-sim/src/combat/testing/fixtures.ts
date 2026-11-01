/**
 * Small test content (not game content): skills, a potion, two normal enemies and a boss with a telegraphed heavy
 * strike, plus two hero builds mirroring the `@rpg/rpg-stats` reference builds (bruiser/tank, striker/sustain), which
 * that package does not export. Parsed through the `@rpg/rpg-schema` schemas so defaults are filled like compiled
 * content.
 */
import { AutomationRulesSchema, EnemySchema, ItemSchema, SkillSchema } from '@rpg/rpg-schema';
import type { AutomationRule, EquipmentItem, Item, Skill, SkillInput, Enemy, EnemyInput, ItemInput } from '@rpg/rpg-schema';
import type { DeriveStatsInput } from '@rpg/rpg-stats';

import { step } from '../engine.ts';
import type { CombatPolicy } from '../engine.ts';
import type { CombatContent, CombatEvent, CombatInput, CombatSetup, CombatState, HeroSetup } from '../types.ts';

const skill = (s: SkillInput): Skill => SkillSchema.parse(s);
const enemy = (e: EnemyInput): Enemy => EnemySchema.parse(e);
const item = (i: ItemInput): Item => ItemSchema.parse(i);
export const rules = (r: unknown): AutomationRule[] => AutomationRulesSchema.parse(r);

export const SKILLS = {
  strike: skill({ id: 'skill:strike', cooldownTicks: 0, windupTicks: 0, targeting: 'enemy', effects: [{ type: 'damage', coeffBp: 10_000, school: 'physical' }] }),
  shieldBash: skill({
    id: 'skill:shield_bash',
    cooldownTicks: 8,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [
      { type: 'damage', coeffBp: 8000, school: 'physical' },
      { type: 'taunt', duration: { value: 3, unit: 'attacks' } },
    ],
  }),
  /** The manual response to a telegraph: a big armor buff on self for a few ticks plus a small shield. */
  guard: skill({
    id: 'skill:guard',
    cooldownTicks: 10,
    windupTicks: 0,
    targeting: 'self',
    effects: [
      { type: 'stat_mod', stat: 'armor', flat: 300, duration: { value: 6, unit: 'ticks' } },
      { type: 'shield', coeffBp: 20_000, duration: { value: 1, unit: 'attacks' } },
    ],
  }),
  mend: skill({ id: 'skill:mend', cooldownTicks: 6, windupTicks: 0, targeting: 'ally', effects: [{ type: 'heal', coeffBp: 20_000 }] }),
  firebolt: skill({
    id: 'skill:firebolt',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [
      { type: 'damage', coeffBp: 10_000, school: 'magic' },
      { type: 'dot', coeffBp: 2000, school: 'magic', periodTicks: 2, duration: { value: 6, unit: 'ticks' } },
    ],
  }),
  regrowth: skill({
    id: 'skill:regrowth',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'ally',
    effects: [{ type: 'hot', coeffBp: 5000, duration: { value: 4, unit: 'ticks' } }],
  }),
  hex: skill({
    id: 'skill:hex',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [{ type: 'stat_mod', stat: 'power', deltaBp: -5000, duration: { value: 2, unit: 'actions' } }],
  }),
  rally: skill({
    id: 'skill:rally',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'self',
    effects: [{ type: 'stat_mod', stat: 'STR', flat: 20, duration: { value: 2, unit: 'actions' } }],
  }),
  concuss: skill({
    id: 'skill:concuss',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [{ type: 'stun', duration: { value: 2, unit: 'actions' } }],
  }),
  daze: skill({
    id: 'skill:daze',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [{ type: 'stun', duration: { value: 3, unit: 'ticks' } }],
  }),
  purify: skill({ id: 'skill:purify', cooldownTicks: 0, windupTicks: 0, targeting: 'ally', effects: [{ type: 'cleanse' }] }),
  cleave: skill({
    id: 'skill:cleave',
    cooldownTicks: 4,
    windupTicks: 0,
    targeting: 'allEnemies',
    effects: [{ type: 'damage', coeffBp: 6000, school: 'physical' }],
  }),
  bite: skill({ id: 'skill:bite', cooldownTicks: 0, windupTicks: 0, targeting: 'enemy', effects: [{ type: 'damage', coeffBp: 10_000, school: 'physical' }] }),
  venom: skill({
    id: 'skill:venom',
    cooldownTicks: 0,
    windupTicks: 0,
    targeting: 'enemy',
    effects: [
      { type: 'dot', coeffBp: 5000, school: 'physical', periodTicks: 1, duration: { value: 3, unit: 'ticks' } },
      { type: 'stat_mod', stat: 'armor', flat: -5, duration: { value: 10, unit: 'ticks' } },
    ],
  }),
  heavyStrike: skill({
    id: 'skill:heavy_strike',
    cooldownTicks: 12,
    windupTicks: 4,
    targeting: 'enemy',
    effects: [{ type: 'damage', coeffBp: 45_000, school: 'physical' }],
  }),
} as const;

export const POTION = item({
  id: 'item:minor_healing_potion',
  kind: 'consumable',
  value: 5,
  stackable: true,
  maxStack: 20,
  use: [{ type: 'heal', coeffBp: 3000, to: 'self' }],
});

export const ENEMIES = {
  wolf: enemy({
    id: 'enemy:wolf',
    rank: 'normal',
    level: 2,
    stats: { maxHp: 60, power: 8, armor: 2 },
    skills: ['skill:bite'],
    ai: [{ when: {}, do: { useSkill: 'skill:bite' } }],
    xp: 10,
  }),
  spider: enemy({
    id: 'enemy:spider',
    rank: 'normal',
    level: 3,
    stats: { maxHp: 70, power: 8, haste: 50 },
    skills: ['skill:bite', 'skill:venom'],
    ai: [
      { when: { selfHpBelowBp: 9000 }, do: { useSkill: 'skill:venom', target: 'highestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:bite' } },
    ],
    xp: 12,
  }),
  golem: enemy({
    id: 'enemy:golem',
    rank: 'boss',
    level: 5,
    stats: { maxHp: 270, power: 20, armor: 10, critBp: 500 },
    skills: ['skill:bite', 'skill:heavy_strike'],
    ai: [{ when: {}, do: { useSkill: 'skill:bite' } }],
    xp: 300,
    phases: [
      { fromHpBp: 10_000, rotation: ['skill:bite', 'skill:bite', 'skill:heavy_strike'], telegraphs: ['skill:heavy_strike'] },
      { fromHpBp: 5000, rotation: ['skill:heavy_strike', 'skill:bite'], telegraphs: ['skill:heavy_strike'] },
    ],
  }),
  /** Training dummies: lots of HP, weak bite; `fastDummy` acts every 2 ticks, `dummy` every 6. */
  dummy: enemy({
    id: 'enemy:dummy',
    rank: 'normal',
    level: 1,
    stats: { maxHp: 5000, power: 6 },
    skills: ['skill:bite'],
    ai: [{ when: {}, do: { useSkill: 'skill:bite' } }],
    xp: 0,
  }),
  fastDummy: enemy({
    id: 'enemy:fast_dummy',
    rank: 'normal',
    level: 1,
    stats: { maxHp: 5000, power: 6, haste: 300 },
    skills: ['skill:bite'],
    ai: [{ when: {}, do: { useSkill: 'skill:bite' } }],
    xp: 0,
  }),
  /** Practically unkillable, deals the 1-damage minimum: for timeouts and long runs. */
  wall: enemy({
    id: 'enemy:wall',
    rank: 'normal',
    level: 1,
    stats: { maxHp: 10_000_000, power: 1 },
    skills: ['skill:bite'],
    ai: [{ when: {}, do: { useSkill: 'skill:bite' } }],
    xp: 0,
  }),
} as const;

export const CONTENT: CombatContent = {
  skills: Object.fromEntries(Object.values(SKILLS).map((s) => [s.id, s])),
  items: { [POTION.id]: POTION },
  enemies: Object.fromEntries(Object.values(ENEMIES).map((e) => [e.id, e])),
};

function gear(id: string, slot: EquipmentItem['slot'], stats: EquipmentItem['stats']): EquipmentItem {
  return { id: `item:${id}`, kind: 'equipment', slot, stats, value: 10, tags: [], stackable: false };
}

/** Bruiser/tank at level 5 (mirrors `@rpg/rpg-stats` testing `BRUISER`). */
export const BRUISER_L5: DeriveStatsInput = {
  level: 5,
  attributes: { STR: 12, AGI: 3, INT: 1, VIT: 18, SPI: 3 },
  equipment: [
    gear('training_mace', 'weapon', { power: 4 }),
    gear('wooden_shield', 'offhand', { armor: 6, maxHp: 10 }),
    gear('padded_vest', 'chest', { armor: 4, VIT: 2 }),
  ],
};

/** Striker/sustain at level 5 (mirrors `@rpg/rpg-stats` testing `STRIKER`). */
export const STRIKER_L5: DeriveStatsInput = {
  level: 5,
  attributes: { STR: 2, AGI: 12, INT: 13, VIT: 4, SPI: 10 },
  equipment: [
    gear('apprentice_staff', 'weapon', { power: 3, critBp: 100 }),
    gear('charm_of_mending', 'accessory', { healPower: 4, SPI: 1 }),
    gear('light_boots', 'feet', { haste: 6, AGI: 1 }),
  ],
};

export const NAIVE_RULES = rules([{ when: {}, do: { useSkill: 'skill:strike', target: 'lowestHpEnemy' } }]);

export function bruiser(overrides: Partial<HeroSetup> = {}): HeroSetup {
  return {
    id: 'hero:a',
    build: BRUISER_L5,
    skills: ['skill:strike', 'skill:shield_bash', 'skill:guard'],
    rules: NAIVE_RULES,
    ...overrides,
  };
}

export function striker(overrides: Partial<HeroSetup> = {}): HeroSetup {
  return {
    id: 'hero:b',
    build: STRIKER_L5,
    skills: ['skill:firebolt', 'skill:mend', 'skill:purify'],
    rules: rules([
      { when: { allyHpBelowBp: 5000, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'lowestHpAlly' } },
      { when: {}, do: { useSkill: 'skill:firebolt', target: 'lowestHpEnemy' } },
    ]),
    ...overrides,
  };
}

/** Party of two vs a wolf and a spider. */
export function partySetup(): CombatSetup {
  return {
    heroes: [
      bruiser({
        rules: rules([
          { when: { selfHpBelowBp: 3500 }, do: { useConsumable: 'item:minor_healing_potion' } },
          { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'highestHpEnemy' } },
          { when: {}, do: { useSkill: 'skill:strike', target: 'lowestHpEnemy' } },
        ]),
        consumables: [{ item: 'item:minor_healing_potion', qty: 2 }],
      }),
      striker(),
    ],
    enemies: [
      { id: 'enemy:1', enemy: 'enemy:wolf' },
      { id: 'enemy:2', enemy: 'enemy:spider' },
    ],
    content: CONTENT,
  };
}

/** Solo bruiser vs the golem boss. */
export function bossSetup(heroRules: AutomationRule[] = NAIVE_RULES): CombatSetup {
  return {
    heroes: [bruiser({ rules: heroRules })],
    enemies: [{ id: 'enemy:boss', enemy: 'enemy:golem' }],
    content: CONTENT,
  };
}

/** Automation that answers telegraphs with guard. */
export const GUARD_RULES = rules([
  { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
  { when: {}, do: { useSkill: 'skill:strike', target: 'lowestHpEnemy' } },
]);

/**
 * Scripted live player on top of naive automation: as soon as an enemy telegraphs, queue `guard` (it resolves at the
 * hero's next ready action).
 */
export const manualGuardPolicy: CombatPolicy = (state) => {
  const hero = state.actors.find((a) => a.id === 'hero:a');
  if (hero === undefined || !hero.alive || hero.queued !== null) return [];
  const telegraphing = state.actors.some((a) => a.side === 'enemy' && a.alive && a.windup !== null);
  const guardReady = (hero.cooldowns['skill:guard'] ?? 0) <= state.tick + 1;
  return telegraphing && guardReady ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:guard' }] : [];
};

/** Bruiser self-healing against the wall: never ends on its own (for timeouts and the 10 000-tick benchmark). */
export function stalemateSetup(): CombatSetup {
  return {
    heroes: [
      bruiser({
        skills: ['skill:strike', 'skill:regrowth'],
        rules: rules([
          { when: { selfHpBelowBp: 9000 }, do: { useSkill: 'skill:regrowth', target: 'self' } },
          { when: {}, do: { useSkill: 'skill:strike' } },
        ]),
      }),
    ],
    enemies: [{ id: 'enemy:wall', enemy: 'enemy:wall' }],
    content: CONTENT,
  };
}

/** Events of one type, typed. */
export function ofType<T extends CombatEvent['type']>(events: readonly CombatEvent[], type: T): Extract<CombatEvent, { type: T }>[] {
  return events.filter((e): e is Extract<CombatEvent, { type: T }> => e.type === type);
}

/** Steps `state` `n` times with no inputs (or `inputsAt(tick)`), collecting events. */
export function advance(
  state: CombatState,
  n: number,
  inputsAt: (tick: number) => readonly CombatInput[] = () => [],
): { state: CombatState; events: CombatEvent[] } {
  const events: CombatEvent[] = [];
  let s = state;
  for (let i = 0; i < n && s.outcome === null; i++) {
    const r = step(s, inputsAt(s.tick + 1));
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}
