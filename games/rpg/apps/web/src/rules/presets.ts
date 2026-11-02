import type { AutomationRules, SkillId } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { ID_LABELS } from '../content/labels.ts';
import { BASIC_ATTACK } from './catalog.ts';
import type { RuleContext } from './catalog.ts';

export interface RulePreset {
  readonly id: 'bulwark' | 'thornblade';
  readonly name: string;
  readonly blurb: string;
  readonly rules: AutomationRules;
}

const POTION = 'item:minor_healing_potion';

/** Reference build rule sets, verbatim from docs/design/region-1.md §4.3 (provisional numbers). */
export const PRESETS: readonly RulePreset[] = [
  {
    id: 'bulwark',
    name: 'Bulwark',
    blurb: 'Tank: guard telegraphs, self-mend, cleave packs.',
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
    name: 'Thornblade',
    blurb: 'Striker: burst the weakest, bleed the toughest.',
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
  return `Needs ${missing.map((id) => labels.skill(id)).join(', ')} in your loadout.`;
}

/** Deep copy so edits never mutate the preset constants. */
export function presetRules(preset: RulePreset): AutomationRules {
  return structuredClone(preset.rules) as AutomationRules;
}
