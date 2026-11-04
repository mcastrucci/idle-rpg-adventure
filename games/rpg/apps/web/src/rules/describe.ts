import type { AutomationRule, RuleAction, RuleCondition, TargetSelector } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { decimalSeparator, t } from '../i18n/index.ts';
import { ID_LABELS } from '../content/labels.ts';
import { CONDITION_KEYS } from './catalog.ts';
import type { ConditionKey } from './catalog.ts';

/** `3500` → `35%`, `3550` → `35.5%`. Integer formatting only; display code, not game math. */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? `${whole}%` : `${whole}${decimalSeparator()}${String(rest).padStart(2, '0').replace(/0+$/, '')}%`;
}

type Phrases = { readonly [K in ConditionKey]: (value: NonNullable<RuleCondition[K]>, labels: ContentLabels) => string };

/** Sentence fragments ("If …"). Typed over every condition key, so a new schema condition fails to compile here. */
const CONDITION_PHRASES: Phrases = {
  selfHpBelowBp: (bp) => t('ui.rule.phrase.self_hp_below', { bp: formatBp(bp) }),
  allyHpBelowBp: (bp) => t('ui.rule.phrase.ally_hp_below', { bp: formatBp(bp) }),
  selfHasHarmfulEffect: () => t('ui.rule.phrase.harmful_effect'),
  enemyTelegraphing: () => t('ui.rule.phrase.enemy_winding_up'),
  skillReady: (id, labels) => t('ui.rule.phrase.skill_ready', { skill: labels.skill(id) }),
  enemiesAtLeast: (count) => t('ui.rule.phrase.enemies_at_least', { count }),
  hasConsumable: (id, labels) => t('ui.rule.phrase.carry', { item: labels.item(id) }),
};

/** Short chip labels for the rule cards. */
const CONDITION_CHIPS: Phrases = {
  selfHpBelowBp: (bp) => t('ui.rule.chip.self_hp_below', { bp: formatBp(bp) }),
  allyHpBelowBp: (bp) => t('ui.rule.chip.ally_hp_below', { bp: formatBp(bp) }),
  selfHasHarmfulEffect: () => t('ui.rule.chip.debuffed'),
  enemyTelegraphing: () => t('ui.rule.chip.enemy_winding_up'),
  skillReady: (id, labels) => t('ui.rule.chip.skill_ready', { skill: labels.skill(id) }),
  enemiesAtLeast: (count) => t('ui.rule.chip.enemies_at_least', { count }),
  hasConsumable: (id, labels) => t('ui.rule.chip.carry', { item: labels.item(id) }),
};

const TARGET_PHRASE_KEYS: Readonly<Record<TargetSelector, string>> = {
  self: 'ui.rule.target.self',
  lowestHpAlly: 'ui.rule.target.lowest_hp_ally',
  lowestHpEnemy: 'ui.rule.target.lowest_hp_enemy',
  highestHpEnemy: 'ui.rule.target.highest_hp_enemy',
  telegraphingEnemy: 'ui.rule.target.winding_up_enemy',
};

/** Sentence fragment naming a target selector ("the enemy with the lowest HP"). */
export function targetPhrase(selector: TargetSelector): string {
  return t(TARGET_PHRASE_KEYS[selector]);
}

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
  if ('useConsumable' in action) return t('ui.rule.action.use', { name: labels.item(action.useConsumable) });
  const name = labels.skill(action.useSkill);
  return action.target === undefined ? t('ui.rule.action.use', { name }) : t('ui.rule.action.use_on', { name, target: targetPhrase(action.target) });
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return t('ui.rule.and', { list: parts.slice(0, -1).join(', '), last: parts.at(-1) ?? '' });
}

/**
 * Plain-language summary of one rule, e.g. "If my HP is below 35%, use Minor healing potion." Conditions are ANDed
 * and an empty condition set always matches.
 */
export function describeRule(rule: AutomationRule, labels: ContentLabels = ID_LABELS): string {
  const conditions = describeConditions(rule.when, labels);
  const action = describeAction(rule.do, labels);
  if (conditions.length === 0) return t('ui.rule.always', { action });
  return t('ui.rule.if', { conditions: joinAnd(conditions), action });
}
