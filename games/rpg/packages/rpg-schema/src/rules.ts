/**
 * Automation rules (docs/spec/combat-engine.md §6) and enemy AI priority rules (§7). Shared by content validation,
 * server-side validation of player rule edits and the simulator. Conditions and actions are closed sets.
 *
 * Perspective: "ally"/"enemy" are relative to the actor evaluating the rule, so the same vocabulary serves heroes and
 * enemies.
 */
import { z } from 'zod';

import { ItemIdSchema, SkillIdSchema } from './ids.ts';
import { BpSchema } from './stats.ts';

/**
 * Maximum number of automation rules per character. **Provisional** (combat-engine §6 "Rule slots limited
 * (provisional: 6)"); to be confirmed with the skill/build system, docs/open-decisions.md #13.
 */
export const MAX_AUTOMATION_RULES = 6;

/** Sanity cap for enemy AI priority lists (content authoring, not a gameplay limit). */
export const MAX_AI_RULES = 16;

/** What kind of target a skill accepts. */
export const SKILL_TARGETINGS = ['self', 'ally', 'enemy', 'allAllies', 'allEnemies'] as const;
export const SkillTargetingSchema = z.enum(SKILL_TARGETINGS);
export type SkillTargeting = z.output<typeof SkillTargetingSchema>;

/** How a rule picks the concrete target of a single-target skill. */
export const TARGET_SELECTORS = ['self', 'lowestHpAlly', 'lowestHpEnemy', 'highestHpEnemy', 'telegraphingEnemy'] as const;
export const TargetSelectorSchema = z.enum(TARGET_SELECTORS);
export type TargetSelector = z.output<typeof TargetSelectorSchema>;

/** Conditions are ANDed; an empty object always matches (fallback rule). */
export const RuleConditionSchema = z.strictObject({
  /** Actor's HP is strictly below this share of its max HP. */
  selfHpBelowBp: BpSchema.optional(),
  /** Some living ally (actor included) is strictly below this share of max HP. */
  allyHpBelowBp: BpSchema.optional(),
  /** Some enemy is winding up a telegraphed action. */
  enemyTelegraphing: z.literal(true).optional(),
  /** The skill is equipped and off cooldown. */
  skillReady: SkillIdSchema.optional(),
  /** At least this many living enemies. */
  enemiesAtLeast: z.int().positive().optional(),
  /** The actor carries at least one of this consumable (escrowed for idle). */
  hasConsumable: ItemIdSchema.optional(),
});
export type RuleCondition = z.output<typeof RuleConditionSchema>;

export const UseSkillActionSchema = z.strictObject({
  useSkill: SkillIdSchema,
  target: TargetSelectorSchema.optional(),
});
export const UseConsumableActionSchema = z.strictObject({ useConsumable: ItemIdSchema });

export const RuleActionSchema = z.union([UseSkillActionSchema, UseConsumableActionSchema]);
export type RuleAction = z.output<typeof RuleActionSchema>;

export const AutomationRuleSchema = z.strictObject({ when: RuleConditionSchema, do: RuleActionSchema });
export type AutomationRule = z.output<typeof AutomationRuleSchema>;

/** Ordered list, evaluated top-down; first matching rule fires. */
export const AutomationRulesSchema = z
  .array(AutomationRuleSchema)
  .max(MAX_AUTOMATION_RULES, `at most ${MAX_AUTOMATION_RULES} automation rules (provisional slot limit)`);
export type AutomationRules = z.output<typeof AutomationRulesSchema>;

/** Enemy AI conditions: the automation vocabulary minus what only makes sense for heroes. */
export const AiConditionSchema = RuleConditionSchema.omit({ enemyTelegraphing: true, hasConsumable: true });
export type AiCondition = z.output<typeof AiConditionSchema>;

/** Enemy AI rule: same shape as an automation rule, but enemies only use skills. */
export const AiRuleSchema = z.strictObject({ when: AiConditionSchema, do: UseSkillActionSchema });
export type AiRule = z.output<typeof AiRuleSchema>;

export const AiRulesSchema = z.array(AiRuleSchema).min(1).max(MAX_AI_RULES);
