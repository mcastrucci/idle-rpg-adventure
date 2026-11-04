import { AutomationRulesSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRules } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { t } from '../i18n/index.ts';
import { ID_LABELS } from '../content/labels.ts';
import type { RuleContext } from './catalog.ts';
import { selectorFits } from './catalog.ts';
import { targetPhrase } from './describe.ts';

export interface RuleIssue {
  /** Rule position (0-based), or `null` for list-level problems. */
  readonly index: number | null;
  readonly message: string;
}

export type RulesValidation =
  | { readonly ok: true; readonly rules: AutomationRules }
  | { readonly ok: false; readonly issues: readonly RuleIssue[] };

/**
 * Client-side gate before Save: the shared `AutomationRulesSchema` (closed conditions/actions, slot limit) plus the
 * server's character checks that the client can reproduce (skills equipped, known consumables, selector fits the
 * skill). The server validates again against real content; its answer always wins.
 */
export function validateRules(input: readonly unknown[], context: RuleContext, labels: ContentLabels = ID_LABELS): RulesValidation {
  const parsed = AutomationRulesSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue): RuleIssue => {
      const [first] = issue.path;
      if (typeof first === 'number') return { index: first, message: t('ui.validate.invalid_rule', { path: issue.path.slice(1).join('.') || t('ui.validate.rule_word'), message: issue.message }) };
      if (input.length > MAX_AUTOMATION_RULES) return { index: null, message: t('ui.validate.at_most', { max: MAX_AUTOMATION_RULES }) };
      return { index: null, message: issue.message };
    });
    return { ok: false, issues };
  }

  const equipped = new Set<string>(context.equippedSkills);
  const consumables = new Set<string>(context.consumables);
  const issues: RuleIssue[] = [];
  parsed.data.forEach((rule, index) => {
    const add = (message: string) => issues.push({ index, message });
    if (rule.when.skillReady !== undefined && !equipped.has(rule.when.skillReady)) add(t('ui.validate.not_in_loadout', { skill: labels.skill(rule.when.skillReady) }));
    if (rule.when.hasConsumable !== undefined && !consumables.has(rule.when.hasConsumable)) add(t('ui.validate.unknown_consumable', { item: labels.item(rule.when.hasConsumable) }));
    const action = rule.do;
    if ('useConsumable' in action) {
      if (!consumables.has(action.useConsumable)) add(t('ui.validate.unknown_consumable', { item: labels.item(action.useConsumable) }));
      return;
    }
    if (!equipped.has(action.useSkill)) add(t('ui.validate.not_in_loadout', { skill: labels.skill(action.useSkill) }));
    if (action.target !== undefined && !selectorFits(action.target, context.targetingOf(action.useSkill))) {
      add(t('ui.validate.cannot_target', { skill: labels.skill(action.useSkill), target: targetPhrase(action.target) }));
    }
  });
  return issues.length === 0 ? { ok: true, rules: parsed.data } : { ok: false, issues };
}
