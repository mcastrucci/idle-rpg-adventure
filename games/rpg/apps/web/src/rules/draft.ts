import { AutomationRuleSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRule, ItemId, RuleAction, RuleCondition, SkillId, TargetSelector } from '@rpg/rpg-schema';

import { BASIC_ATTACK, selectorFits } from './catalog.ts';
import type { ConditionKey, RuleContext } from './catalog.ts';

/** Editor row: a rule plus a stable React key that survives reordering. */
export interface DraftRule {
  readonly key: number;
  readonly rule: AutomationRule;
}

/**
 * Server rules are already validated server-side; anything unexpected is kept as-is (so nothing is silently dropped)
 * and flagged by `validateRules`.
 */
export function toDraft(rules: readonly unknown[], firstKey = 0): DraftRule[] {
  return rules.map((raw, index) => {
    const parsed = AutomationRuleSchema.safeParse(raw);
    return { key: firstKey + index, rule: parsed.success ? parsed.data : (raw as AutomationRule) };
  });
}

export const NEW_RULE: AutomationRule = { when: {}, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } };

export function canAdd(drafts: readonly DraftRule[]): boolean {
  return drafts.length < MAX_AUTOMATION_RULES;
}

export function addRule(drafts: readonly DraftRule[], key: number): DraftRule[] {
  if (!canAdd(drafts)) return [...drafts];
  return [...drafts, { key, rule: structuredClone(NEW_RULE) }];
}

export function removeRule(drafts: readonly DraftRule[], index: number): DraftRule[] {
  return drafts.filter((_, i) => i !== index);
}

/** Moves the rule at `index` by `delta` (−1 up, +1 down); out-of-range moves are no-ops. */
export function moveRule(drafts: readonly DraftRule[], index: number, delta: -1 | 1): DraftRule[] {
  const target = index + delta;
  const next = [...drafts];
  const [moved] = next.splice(index, 1);
  if (moved === undefined || target < 0 || target > drafts.length - 1) return [...drafts];
  next.splice(target, 0, moved);
  return next;
}

export function replaceRule(drafts: readonly DraftRule[], index: number, rule: AutomationRule): DraftRule[] {
  return drafts.map((draft, i) => (i === index ? { ...draft, rule } : draft));
}

type ConditionValue<K extends ConditionKey> = NonNullable<RuleCondition[K]>;

/** Initial value when a condition is added; `null` when nothing can be offered (e.g. empty loadout). */
export function defaultConditionValue<K extends ConditionKey>(key: K, rule: AutomationRule, context: RuleContext): ConditionValue<K> | null {
  const values: { [P in ConditionKey]: ConditionValue<P> | null } = {
    selfHpBelowBp: 3500,
    allyHpBelowBp: 5000,
    selfHasHarmfulEffect: true,
    enemyTelegraphing: true,
    skillReady: 'useSkill' in rule.do && rule.do.useSkill !== BASIC_ATTACK ? rule.do.useSkill : context.loadout[0] ?? null,
    enemiesAtLeast: 2,
    hasConsumable: 'useConsumable' in rule.do ? rule.do.useConsumable : context.consumables[0] ?? null,
  };
  return values[key] as ConditionValue<K> | null;
}

export function setCondition<K extends ConditionKey>(rule: AutomationRule, key: K, value: ConditionValue<K>): AutomationRule {
  return { ...rule, when: { ...rule.when, [key]: value } };
}

export function clearCondition(rule: AutomationRule, key: ConditionKey): AutomationRule {
  const when = Object.fromEntries(Object.entries(rule.when).filter(([name]) => name !== key)) as RuleCondition;
  return { ...rule, when };
}

/** Switching skill keeps the target only if it still fits the new skill. */
export function setActionSkill(rule: AutomationRule, skill: SkillId, context: RuleContext): AutomationRule {
  const previous = 'useSkill' in rule.do ? rule.do.target : undefined;
  const action: RuleAction = previous !== undefined && selectorFits(previous, context.targetingOf(skill))
    ?{ useSkill: skill, target: previous }
    : { useSkill: skill };
  return { ...rule, do: action };
}

export function setActionTarget(rule: AutomationRule, target: TargetSelector | undefined): AutomationRule {
  if (!('useSkill' in rule.do)) return rule;
  return { ...rule, do: target === undefined ? { useSkill: rule.do.useSkill } : { useSkill: rule.do.useSkill, target } };
}

export function setActionConsumable(rule: AutomationRule, item: ItemId): AutomationRule {
  return { ...rule, do: { useConsumable: item } };
}

/** Switches between "use skill" and "use consumable" with a sensible first choice. */
export function setActionKind(rule: AutomationRule, kind: 'skill' | 'consumable', context: RuleContext): AutomationRule {
  if (kind === 'skill') return 'useSkill' in rule.do ? rule : { ...rule, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } };
  if ('useConsumable' in rule.do) return rule;
  const item = rule.when.hasConsumable ?? context.consumables[0];
  return item === undefined ? rule : { ...rule, do: { useConsumable: item } };
}

/** Wire form: exactly the schema shape with no `undefined` members, so the payload is the rules and nothing else. */
export function toRules(drafts: readonly DraftRule[]): AutomationRule[] {
  return drafts.map(({ rule }) => JSON.parse(JSON.stringify(rule)) as AutomationRule);
}
