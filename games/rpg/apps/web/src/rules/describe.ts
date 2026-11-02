import type { AutomationRule, RuleAction, RuleCondition, TargetSelector } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { ID_LABELS } from '../content/labels.ts';
import { CONDITION_KEYS } from './catalog.ts';
import type { ConditionKey } from './catalog.ts';

/** `3500` → `35%`, `3550` → `35.5%`. Integer formatting only; display code, not game math. */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0+$/, '')}%`;
}

type Phrases = { readonly [K in ConditionKey]: (value: NonNullable<RuleCondition[K]>, labels: ContentLabels) => string };

/** Sentence fragments ("If …"). Typed over every condition key, so a new schema condition fails to compile here. */
const CONDITION_PHRASES: Phrases = {
  selfHpBelowBp: (bp) => `my HP is below ${formatBp(bp)}`,
  allyHpBelowBp: (bp) => `an ally's HP is below ${formatBp(bp)}`,
  selfHasHarmfulEffect: () => 'I have a harmful effect',
  enemyTelegraphing: () => 'an enemy is winding up an attack',
  skillReady: (id, labels) => `${labels.skill(id)} is ready`,
  enemiesAtLeast: (count) => (count === 1 ? 'there is at least 1 enemy' : `there are at least ${count} enemies`),
  hasConsumable: (id, labels) => `I carry ${labels.item(id)}`,
};

/** Short chip labels for the rule cards. */
const CONDITION_CHIPS: Phrases = {
  selfHpBelowBp: (bp) => `My HP < ${formatBp(bp)}`,
  allyHpBelowBp: (bp) => `Ally HP < ${formatBp(bp)}`,
  selfHasHarmfulEffect: () => 'I am debuffed',
  enemyTelegraphing: () => 'Enemy winding up',
  skillReady: (id, labels) => `${labels.skill(id)} ready`,
  enemiesAtLeast: (count) => `${count}+ ${count === 1 ? 'enemy' : 'enemies'}`,
  hasConsumable: (id, labels) => `Carrying ${labels.item(id)}`,
};

export const TARGET_PHRASES: Readonly<Record<TargetSelector, string>> = {
  self: 'myself',
  lowestHpAlly: 'the ally with the lowest HP',
  lowestHpEnemy: 'the enemy with the lowest HP',
  highestHpEnemy: 'the enemy with the highest HP',
  telegraphingEnemy: 'the enemy winding up an attack',
};

function present(when: RuleCondition): ConditionKey[] {
  return CONDITION_KEYS.filter((key) => when[key] !== undefined);
}

function phrase<K extends ConditionKey>(table: Phrases, key: K, when: RuleCondition, labels: ContentLabels): string {
  return table[key](when[key] as NonNullable<RuleCondition[K]>, labels);
}

export function describeConditions(when: RuleCondition, labels: ContentLabels = ID_LABELS): string[] {
  return present(when).map((key) => phrase(CONDITION_PHRASES, key, when, labels));
}

export function conditionChips(when: RuleCondition, labels: ContentLabels = ID_LABELS): { key: ConditionKey; label: string }[] {
  return present(when).map((key) => ({ key, label: phrase(CONDITION_CHIPS, key, when, labels) }));
}

export function describeAction(action: RuleAction, labels: ContentLabels = ID_LABELS): string {
  if ('useConsumable' in action) return `use ${labels.item(action.useConsumable)}`;
  const skill = `use ${labels.skill(action.useSkill)}`;
  return action.target === undefined ? skill : `${skill} on ${TARGET_PHRASES[action.target]}`;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Plain-language summary of one rule, e.g. "If my HP is below 35%, use Minor healing potion." Conditions are ANDed
 * and an empty condition set always matches.
 */
export function describeRule(rule: AutomationRule, labels: ContentLabels = ID_LABELS): string {
  const conditions = describeConditions(rule.when, labels);
  const action = describeAction(rule.do, labels);
  if (conditions.length === 0) return `Always ${action}.`;
  return `If ${joinAnd(conditions)}, ${action}.`;
}
