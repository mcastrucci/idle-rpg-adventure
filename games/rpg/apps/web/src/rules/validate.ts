import { AutomationRulesSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRules } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { ID_LABELS } from '../content/labels.ts';
import type { RuleContext } from './catalog.ts';
import { selectorFits } from './catalog.ts';
import { TARGET_PHRASES } from './describe.ts';

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
      if (typeof first === 'number') return { index: first, message: `Not a valid rule (${issue.path.slice(1).join('.') || 'rule'}: ${issue.message}).` };
      if (input.length > MAX_AUTOMATION_RULES) return { index: null, message: `At most ${MAX_AUTOMATION_RULES} rules.` };
      return { index: null, message: issue.message };
    });
    return { ok: false, issues };
  }

  const equipped = new Set<string>(context.equippedSkills);
  const consumables = new Set<string>(context.consumables);
  const issues: RuleIssue[] = [];
  parsed.data.forEach((rule, index) => {
    const add = (message: string) => issues.push({ index, message });
    if (rule.when.skillReady !== undefined && !equipped.has(rule.when.skillReady)) add(`${labels.skill(rule.when.skillReady)} is not in your loadout.`);
    if (rule.when.hasConsumable !== undefined && !consumables.has(rule.when.hasConsumable)) add(`${labels.item(rule.when.hasConsumable)} is not a known consumable.`);
    const action = rule.do;
    if ('useConsumable' in action) {
      if (!consumables.has(action.useConsumable)) add(`${labels.item(action.useConsumable)} is not a known consumable.`);
      return;
    }
    if (!equipped.has(action.useSkill)) add(`${labels.skill(action.useSkill)} is not in your loadout.`);
    if (action.target !== undefined && !selectorFits(action.target, context.targetingOf(action.useSkill))) {
      add(`${labels.skill(action.useSkill)} cannot target ${TARGET_PHRASES[action.target]}.`);
    }
  });
  return issues.length === 0 ? { ok: true, rules: parsed.data } : { ok: false, issues };
}
