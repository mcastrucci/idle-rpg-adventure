import { AutomationRulesSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRules } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { has, t } from '../i18n/index.ts';
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

/** The slice of a Zod issue the translator needs (keeps raw `issue.message` text out of the UI). */
interface SchemaIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

/** Last string segment of an issue path (the condition or action field), or `null` at the rule / list level. */
function leafOf(path: readonly PropertyKey[]): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i];
    if (typeof segment === 'string') return segment;
  }
  return null;
}

/**
 * Translated explanation of a Zod issue. Keyed by issue code and field (`ui.validate.zod.<code>.<field>`), then by code
 * alone (`ui.validate.zod.<code>`), then a generic message: the English Zod text is never shown.
 */
export function describeSchemaIssue(issue: SchemaIssue): string {
  const leaf = leafOf(issue.path);
  const specific = leaf === null ? null : `ui.validate.zod.${issue.code}.${leaf}`;
  if (specific !== null && has(specific)) return t(specific);
  const byCode = `ui.validate.zod.${issue.code}`;
  return has(byCode) ? t(byCode) : t('ui.validate.zod.fallback');
}

/** Translated name of the field an issue points at; the generic word when the path names no known field. */
function describeSchemaPath(path: readonly PropertyKey[]): string {
  const leaf = leafOf(path.slice(1));
  return leaf !== null && has(`ui.validate.field.${leaf}`) ? t(`ui.validate.field.${leaf}`) : t('ui.validate.rule_word');
}

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
      if (typeof first === 'number') return { index: first, message: t('ui.validate.invalid_rule', { path: describeSchemaPath(issue.path), message: describeSchemaIssue(issue) }) };
      if (input.length > MAX_AUTOMATION_RULES) return { index: null, message: t('ui.validate.at_most', { max: MAX_AUTOMATION_RULES }) };
      return { index: null, message: describeSchemaIssue(issue) };
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
