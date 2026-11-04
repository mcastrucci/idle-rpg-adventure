import { AutomationRuleSchema } from '@rpg/rpg-schema';
import type { AutomationRule, SkillId } from '@rpg/rpg-schema';

import type { ContentLabels } from '../content/labels.ts';
import { ID_LABELS } from '../content/labels.ts';
import { t } from '../i18n/index.ts';
import { BASIC_ATTACK, HERO_SKILLS, PROVISIONAL_UNLOCKED_SKILLS } from '../rules/catalog.ts';
import type { HeroSkillInfo } from '../rules/catalog.ts';
import { skillsUsed } from '../rules/presets.ts';

/** PROVISIONAL (open decision #13): active slots; the server enforces the same limit. */
export const ACTIVE_SLOTS = 4;

/** Editor draft: one entry per slot, `null` when empty. Saved as the compacted list. */
export type SlotDraft = readonly (SkillId | null)[];

const isSkillId = (id: string): id is SkillId => /^skill:[a-z0-9_.]+$/.test(id);

export function toSlots(loadout: readonly string[]): SlotDraft {
  const skills = loadout.filter((id): id is SkillId => isSkillId(id) && id !== BASIC_ATTACK).slice(0, ACTIVE_SLOTS);
  return Array.from({ length: ACTIVE_SLOTS }, (_, i) => skills[i] ?? null);
}

/** The `skillLoadout` payload: filled slots in slot order. */
export function toLoadout(slots: SlotDraft): SkillId[] {
  return slots.filter((skill): skill is SkillId => skill !== null);
}

export function sameLoadout(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Puts `skill` in slot `index`. A skill can be equipped once, so choosing one that sits in another slot swaps the two
 * slots instead of duplicating it (the server rejects duplicates).
 */
export function assignSlot(slots: SlotDraft, index: number, skill: SkillId | null): SlotDraft {
  const next = [...slots];
  const from = skill === null ? -1 : next.indexOf(skill);
  if (from !== -1 && from !== index) next[from] = next[index] ?? null;
  next[index] = skill;
  return next;
}

export interface SkillOption extends HeroSkillInfo {
  readonly unlocked: boolean;
}

/** Hero skills with their unlock state: the provisional unlocked set plus anything the server already saved. */
export function skillOptions(savedLoadout: readonly string[]): SkillOption[] {
  const unlocked = new Set<string>([...PROVISIONAL_UNLOCKED_SKILLS, ...savedLoadout]);
  return HERO_SKILLS.map((skill) => ({ ...skill, unlocked: unlocked.has(skill.id) }));
}

export interface RuleConflict {
  /** Position in the saved rule list (0-based). */
  readonly index: number;
  readonly rule: AutomationRule;
  /** Skills the rule needs that the new loadout drops. */
  readonly missing: readonly SkillId[];
}

/**
 * Saved rules that would name a skill the new loadout no longer equips. The server validates rules against the
 * loadout in the same update and rejects the whole change (`invalid_configuration`), so these must be resolved first.
 */
export function ruleConflicts(rules: readonly unknown[], loadout: readonly SkillId[]): RuleConflict[] {
  const equipped = new Set<string>([BASIC_ATTACK, ...loadout]);
  const conflicts: RuleConflict[] = [];
  rules.forEach((raw, index) => {
    const parsed = AutomationRuleSchema.safeParse(raw);
    if (!parsed.success) return;
    const missing = skillsUsed([parsed.data]).filter((id) => !equipped.has(id));
    if (missing.length > 0) conflicts.push({ index, rule: parsed.data, missing });
  });
  return conflicts;
}

/** The saved rules minus the conflicting ones, in their original order. */
export function rulesWithout(rules: readonly unknown[], conflicts: readonly RuleConflict[]): unknown[] {
  const drop = new Set(conflicts.map((conflict) => conflict.index));
  return rules.filter((_, index) => !drop.has(index));
}

export interface LoadoutPreset {
  readonly id: 'bulwark' | 'thornblade';
  readonly loadout: readonly SkillId[];
}

/** Short description of a loadout preset. The Thornblade note names two skills, so those come from the content labels. */
export function loadoutPresetBlurb(preset: LoadoutPreset, labels: ContentLabels = ID_LABELS): string {
  return preset.id === 'bulwark'
    ? t('ui.loadout_preset.bulwark.blurb')
    : t('ui.loadout_preset.thornblade.blurb', { cleave: labels.skill('skill:cleave'), guard: labels.skill('skill:guard') });
}

/** Reference build loadouts, verbatim from docs/design/region-1.md §4.2 (provisional). */
export const LOADOUT_PRESETS: readonly LoadoutPreset[] = [
  {
    id: 'bulwark',
    loadout: ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
  },
  {
    id: 'thornblade',
    loadout: ['skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:cleave'],
  },
];

/** `null` when every preset skill is unlocked, otherwise why the preset is disabled. */
export function presetLockedReason(preset: LoadoutPreset, options: readonly SkillOption[], labels: ContentLabels = ID_LABELS): string | null {
  const unlocked = new Set(options.filter((option) => option.unlocked).map((option) => option.id));
  const locked = preset.loadout.filter((id) => !unlocked.has(id));
  if (locked.length === 0) return null;
  return t('ui.loadout.preset_locked', { count: locked.length, skills: locked.map((id) => labels.skill(id)).join(', ') });
}
