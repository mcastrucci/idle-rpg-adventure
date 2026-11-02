import { MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRule } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { ruleContext, targetOptions } from './catalog.ts';
import {
  addRule, clearCondition, defaultConditionValue, moveRule, NEW_RULE, removeRule, setActionKind, setActionSkill, setCondition, toDraft, toRules,
} from './draft.ts';
import { PRESETS, presetRules, presetUnavailableReason } from './presets.ts';
import { validateRules } from './validate.ts';

const BULWARK_LOADOUT = ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'];
const THORNBLADE_LOADOUT = ['skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:cleave'];
const context = ruleContext(BULWARK_LOADOUT);
const rule = (when: AutomationRule['when'], action: AutomationRule['do']): AutomationRule => ({ when, do: action });

describe('rule drafts', () => {
  it('adds, removes and reorders with stable keys', () => {
    let drafts = toDraft([rule({}, { useSkill: 'skill:guard' })]);
    drafts = addRule(drafts, 7);
    expect(drafts.map((d) => d.key)).toEqual([0, 7]);
    expect(drafts[1]?.rule).toEqual(NEW_RULE);
    drafts = moveRule(drafts, 1, -1);
    expect(drafts.map((d) => d.key)).toEqual([7, 0]);
    expect(moveRule(drafts, 0, -1).map((d) => d.key)).toEqual([7, 0]);
    expect(moveRule(drafts, 1, 1).map((d) => d.key)).toEqual([7, 0]);
    expect(removeRule(drafts, 0).map((d) => d.key)).toEqual([0]);
  });

  it('never exceeds the slot limit', () => {
    let drafts = toDraft([]);
    for (let i = 0; i < MAX_AUTOMATION_RULES + 2; i++) drafts = addRule(drafts, i);
    expect(drafts).toHaveLength(MAX_AUTOMATION_RULES);
  });

  it('edits conditions and actions within the closed sets', () => {
    let r = rule({}, { useSkill: 'skill:mend', target: 'self' });
    expect(defaultConditionValue('skillReady', r, context)).toBe('skill:mend');
    r = setCondition(r, 'selfHpBelowBp', 4000);
    r = setCondition(r, 'skillReady', 'skill:mend');
    expect(r.when).toEqual({ selfHpBelowBp: 4000, skillReady: 'skill:mend' });
    expect(clearCondition(r, 'selfHpBelowBp').when).toEqual({ skillReady: 'skill:mend' });
    // Switching to an enemy skill drops the incompatible `self` target.
    expect(setActionSkill(r, 'skill:shield_bash', context).do).toEqual({ useSkill: 'skill:shield_bash' });
    expect(setActionSkill(rule({}, { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' }), 'skill:shield_bash', context).do)
      .toEqual({ useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' });
    expect(setActionKind(r, 'consumable', context).do).toEqual({ useConsumable: 'item:minor_healing_potion' });
    expect(defaultConditionValue('skillReady', NEW_RULE, ruleContext([]))).toBeNull();
  });

  it('serializes without undefined members', () => {
    const drafts = toDraft([rule({ selfHpBelowBp: 3000 }, { useSkill: 'skill:mend', target: undefined } as unknown as AutomationRule['do'])]);
    expect(JSON.stringify(toRules(drafts))).toBe('[{"when":{"selfHpBelowBp":3000},"do":{"useSkill":"skill:mend"}}]');
  });

  it('offers target selectors that fit the skill targeting', () => {
    expect(targetOptions(context.targetingOf('skill:shield_bash'))).toEqual(['lowestHpEnemy', 'highestHpEnemy', 'telegraphingEnemy']);
    expect(targetOptions(context.targetingOf('skill:mend'))).toEqual(['lowestHpAlly', 'self']);
    expect(targetOptions(context.targetingOf('skill:guard'))).toEqual([]);
    expect(targetOptions(context.targetingOf('skill:cleave'))).toEqual([]);
  });
});

describe('validateRules', () => {
  it('accepts valid rules, including the always-matching empty condition', () => {
    const result = validateRules([rule({ selfHpBelowBp: 4000 }, { useSkill: 'skill:mend', target: 'self' }), rule({}, { useSkill: 'skill:basic_attack' })], context);
    expect(result.ok).toBe(true);
  });

  it('rejects schema violations (shared AutomationRulesSchema)', () => {
    const tooMany = Array.from({ length: MAX_AUTOMATION_RULES + 1 }, () => rule({}, { useSkill: 'skill:basic_attack' }));
    expect(validateRules(tooMany, context)).toMatchObject({ ok: false, issues: [{ index: null }] });
    expect(validateRules([{ when: { selfHpBelowBp: 20000 }, do: { useSkill: 'skill:guard' } }], context)).toMatchObject({ ok: false, issues: [{ index: 0 }] });
    expect(validateRules([{ when: { unknown: true }, do: { useSkill: 'skill:guard' } }], context).ok).toBe(false);
  });

  it('mirrors the server character checks', () => {
    const cases: [AutomationRule, string][] = [
      [rule({ skillReady: 'skill:rend' }, { useSkill: 'skill:guard' }), 'Rend is not in your loadout.'],
      [rule({}, { useSkill: 'skill:rend' }), 'Rend is not in your loadout.'],
      [rule({}, { useConsumable: 'item:glowcap' }), 'Glowcap is not a known consumable.'],
      [rule({ hasConsumable: 'item:glowcap' }, { useSkill: 'skill:guard' }), 'Glowcap is not a known consumable.'],
      [rule({}, { useSkill: 'skill:mend', target: 'lowestHpEnemy' }), 'Mend cannot target the enemy with the lowest HP.'],
      [rule({}, { useSkill: 'skill:shield_bash', target: 'self' }), 'Shield bash cannot target myself.'],
    ];
    for (const [r, message] of cases) expect(validateRules([r], context)).toEqual({ ok: false, issues: [{ index: 0, message }] });
  });

  it('trusts consumables the server already accepted', () => {
    const saved = [rule({}, { useConsumable: 'item:test_tonic' })];
    expect(validateRules(saved, ruleContext(BULWARK_LOADOUT, saved)).ok).toBe(true);
  });
});

function preset(id: string) {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
}

describe('presets', () => {
  const bulwark = preset('bulwark');
  const thornblade = preset('thornblade');
  it('match docs/design/region-1.md §4.3 and validate for their own loadout', () => {
    expect(bulwark.rules).toHaveLength(6);
    expect(thornblade.rules).toHaveLength(6);
    expect(validateRules(presetRules(bulwark), context).ok).toBe(true);
    expect(validateRules(presetRules(thornblade), ruleContext(THORNBLADE_LOADOUT)).ok).toBe(true);
  });

  it('are disabled with a reason when their skills are not in the loadout', () => {
    expect(presetUnavailableReason(bulwark, context)).toBeNull();
    expect(presetUnavailableReason(thornblade, context)).toBe('Needs Second wind, Precise strike, Rend in your loadout.');
  });

  it('are copied, never shared', () => {
    const copy = presetRules(bulwark);
    (copy[0]?.when as { selfHpBelowBp?: number }).selfHpBelowBp = 1;
    expect(bulwark.rules[0]?.when.selfHpBelowBp).toBe(4000);
  });
});
