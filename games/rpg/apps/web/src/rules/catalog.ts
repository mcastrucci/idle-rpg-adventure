import { RuleConditionSchema, TARGET_SELECTORS } from '@rpg/rpg-schema';
import type { ItemId, RuleCondition, SkillId, SkillTargeting, TargetSelector } from '@rpg/rpg-schema';

/** Always equipped; the server adds it to the loadout when validating rules. */
export const BASIC_ATTACK: SkillId = 'skill:basic_attack';

/**
 * GAP (no client content endpoint): targeting of the Region 1 hero skills, mirrored from
 * `games/rpg/content/skills/region_1.json`. Used only to offer fitting target pickers and to reject incompatible
 * selectors before sending; the server re-validates against the real content. Unknown skills get every selector.
 */
export const KNOWN_SKILL_TARGETING: Readonly<Record<string, SkillTargeting>> = {
  'skill:basic_attack': 'enemy',
  'skill:shield_bash': 'enemy',
  'skill:guard': 'self',
  'skill:cleave': 'allEnemies',
  'skill:precise_strike': 'enemy',
  'skill:rend': 'enemy',
  'skill:mend': 'ally',
  'skill:second_wind': 'self',
};

/** GAP (no client content endpoint): Region 1 consumables (`games/rpg/content/items/region_1.json`). */
export const KNOWN_CONSUMABLES: readonly ItemId[] = ['item:minor_healing_potion', 'item:sap_tonic', 'item:healing_potion'];

/** Closed condition set, in display order. A test pins it to the schema so a new condition cannot be missed. */
export const CONDITION_KEYS = [
  'selfHpBelowBp', 'allyHpBelowBp', 'selfHasHarmfulEffect', 'enemyTelegraphing', 'skillReady', 'enemiesAtLeast', 'hasConsumable',
] as const satisfies readonly (keyof RuleCondition)[];
export type ConditionKey = typeof CONDITION_KEYS[number];
export const SCHEMA_CONDITION_KEYS: readonly string[] = Object.keys(RuleConditionSchema.shape);

/** What the editor may offer for one character. Built from the server's character, never from client-side state. */
export interface RuleContext {
  /** `basic_attack` first, then the loadout. */
  readonly equippedSkills: readonly SkillId[];
  /** Loadout only (what `skillReady` is useful for). */
  readonly loadout: readonly SkillId[];
  readonly consumables: readonly ItemId[];
  targetingOf(skill: string): SkillTargeting | undefined;
}

const isSkillId = (id: string): id is SkillId => /^skill:[a-z0-9_.]+$/.test(id);
const isItemId = (id: unknown): id is ItemId => typeof id === 'string' && /^item:[a-z0-9_.]+$/.test(id);

/**
 * Consumables also include any ID already present in the server's saved rules: the server accepted it, so it is a
 * real consumable even if the client's mirror does not list it.
 */
export function ruleContext(loadout: readonly string[], savedRules: readonly unknown[] = []): RuleContext {
  const equipped = loadout.filter((id): id is SkillId => isSkillId(id) && id !== BASIC_ATTACK);
  const consumables = new Set<ItemId>(KNOWN_CONSUMABLES);
  for (const rule of savedRules) {
    if (rule === null || typeof rule !== 'object') continue;
    const { when, do: action } = rule as { when?: { hasConsumable?: unknown }; do?: { useConsumable?: unknown } };
    for (const id of [when?.hasConsumable, action?.useConsumable]) if (isItemId(id)) consumables.add(id);
  }
  return {
    equippedSkills: [BASIC_ATTACK, ...equipped],
    loadout: equipped,
    consumables: [...consumables],
    targetingOf: (skill) => KNOWN_SKILL_TARGETING[skill],
  };
}

/**
 * Explicit selectors that fit a skill's targeting (the simulator's `resolveTargets` and the server's check agree).
 * Leaving the target unset uses the skill's default; `self` and area skills take no selector here.
 */
export function targetOptions(targeting: SkillTargeting | undefined): readonly TargetSelector[] {
  switch (targeting) {
    case 'enemy': return ['lowestHpEnemy', 'highestHpEnemy', 'telegraphingEnemy'];
    case 'ally': return ['lowestHpAlly', 'self'];
    case 'self': case 'allAllies': case 'allEnemies': return [];
    case undefined: return TARGET_SELECTORS;
  }
}

/** Whether the server would accept `selector` for a skill with this targeting (mirrors its validation). */
export function selectorFits(selector: TargetSelector, targeting: SkillTargeting | undefined): boolean {
  if (targeting === undefined) return true;
  if (selector === 'self') return targeting === 'self' || targeting === 'ally';
  if (selector === 'lowestHpAlly') return targeting === 'ally';
  return targeting === 'enemy';
}

/** One active hero skill as the loadout editor shows it. */
export interface HeroSkillInfo {
  readonly id: SkillId;
  readonly cooldownTicks: number;
  /** Catalog key of the short plain-language effect summary. */
  readonly summaryKey: string;
}

/**
 * GAP (no client content endpoint): the Region 1 hero skills that can go in an active slot, mirrored from
 * `games/rpg/content/skills/region_1.json` (`docs/design/region-1.md` §4.1). `basic_attack` is not listed: it is
 * always available outside the four slots. A test pins ids, cooldowns and targeting to the content file.
 */
export const HERO_SKILLS: readonly HeroSkillInfo[] = [
  { id: 'skill:shield_bash', cooldownTicks: 10, summaryKey: 'ui.skill.shield_bash.summary' },
  { id: 'skill:guard', cooldownTicks: 12, summaryKey: 'ui.skill.guard.summary' },
  { id: 'skill:cleave', cooldownTicks: 8, summaryKey: 'ui.skill.cleave.summary' },
  { id: 'skill:mend', cooldownTicks: 15, summaryKey: 'ui.skill.mend.summary' },
  { id: 'skill:precise_strike', cooldownTicks: 10, summaryKey: 'ui.skill.precise_strike.summary' },
  { id: 'skill:rend', cooldownTicks: 12, summaryKey: 'ui.skill.rend.summary' },
  { id: 'skill:second_wind', cooldownTicks: 20, summaryKey: 'ui.skill.second_wind.summary' },
];

/**
 * GAP (no unlock endpoint): the server's provisional unlocked set (`PROVISIONAL_STARTER_SKILLS`, see the server's
 * characters README). Skills in the character's saved loadout count as unlocked too; the server re-validates.
 */
export const PROVISIONAL_UNLOCKED_SKILLS: readonly SkillId[] = ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'];
