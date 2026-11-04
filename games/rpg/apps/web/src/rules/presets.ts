import type { AutomationRules, SkillId } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { displayId, ID_LABELS } from '../content/labels.ts';
import { t } from '../i18n/index.ts';
import { BASIC_ATTACK } from './catalog.ts';
import type { RuleContext } from './catalog.ts';

export interface RulePreset {
  readonly id: 'bulwark' | 'thornblade';
  readonly rules: AutomationRules;
}

const PRESET_NAME_KEYS = { bulwark: 'ui.preset.bulwark.name', thornblade: 'ui.preset.thornblade.name' } as const;
const RULE_PRESET_BLURB_KEYS = { bulwark: 'ui.preset.bulwark.rules_blurb', thornblade: 'ui.preset.thornblade.rules_blurb' } as const;

/** Display name of a reference build (shared by rule presets and loadout presets). */
export function presetName(id: RulePreset['id']): string {
  return t(PRESET_NAME_KEYS[id]);
}

export function rulePresetBlurb(preset: RulePreset): string {
  return t(RULE_PRESET_BLURB_KEYS[preset.id]);
}

const POTION = 'item:minor_healing_potion';

/** Reference build rule sets, verbatim from docs/design/region-1.md §4.3 (provisional numbers). */
export const PRESETS: readonly RulePreset[] = [
  {
    id: 'bulwark',
    rules: [
      { when: { selfHpBelowBp: 4000, hasConsumable: POTION }, do: { useConsumable: POTION } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
      { when: {}, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } },
    ],
  },
  {
    id: 'thornblade',
    rules: [
      { when: { selfHpBelowBp: 4000, hasConsumable: POTION }, do: { useConsumable: POTION } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:second_wind' }, do: { useSkill: 'skill:second_wind' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
      { when: { skillReady: 'skill:rend' }, do: { useSkill: 'skill:rend', target: 'highestHpEnemy' } },
      { when: {}, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } },
    ],
  },
];

/** Skills a rule set uses (conditions and actions). */
export function skillsUsed(rules: AutomationRules): SkillId[] {
  const used = new Set<SkillId>();
  for (const rule of rules) {
    if (rule.when.skillReady !== undefined) used.add(rule.when.skillReady);
    if ('useSkill' in rule.do) used.add(rule.do.useSkill);
  }
  return [...used];
}

/** `null` when the preset can be applied, otherwise the reason it is disabled (missing loadout skills). */
export function presetUnavailableReason(preset: RulePreset, context: RuleContext, labels: ContentLabels = ID_LABELS): string | null {
  const equipped = new Set<string>(context.equippedSkills);
  const missing = skillsUsed(preset.rules).filter((id) => !equipped.has(id));
  if (missing.length === 0) return null;
  return t('ui.preset.needs_skills', { skills: missing.map((id) => labels.skill(id)).join(', ') });
}

/** Deep copy so edits never mutate the preset constants. */
export function presetRules(preset: RulePreset): AutomationRules {
  return structuredClone(preset.rules) as AutomationRules;
}
