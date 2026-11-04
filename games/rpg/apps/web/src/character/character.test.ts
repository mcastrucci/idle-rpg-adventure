import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SkillSchema, XpCurveSchema } from '@rpg/rpg-schema';
import type { AutomationRules } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';
import { describe, expect, it } from 'vitest';

import { BASIC_ATTACK, HERO_SKILLS, KNOWN_SKILL_TARGETING } from '../rules/catalog.ts';
import { PRESETS } from '../rules/presets.ts';
import { adjustAllocation, allocatePayload, NO_ALLOCATION, pointsSpent, withAllocation } from './attributes.ts';
import {
  assignSlot, LOADOUT_PRESETS, presetLockedReason, ruleConflicts, rulesWithout, skillOptions, toLoadout, toSlots,
} from './loadout.ts';
import { levelProgress, XP_CURVE } from './progression.ts';
import { derivedStats, formatRatio, statRows } from './stats.ts';

const content = (path: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../content', path), 'utf8'));
function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}
const BULWARK_RULES = found(PRESETS.find((preset) => preset.id === 'bulwark')).rules;
const BULWARK = found(LOADOUT_PRESETS.find((preset) => preset.id === 'bulwark'));
const THORNBLADE = found(LOADOUT_PRESETS.find((preset) => preset.id === 'thornblade'));

describe('content mirrors (no client content endpoint yet)', () => {
  it('the XP curve matches progression/xp-curve.json', () => {
    const file = content('progression/xp-curve.json') as { xpToNext: unknown; tailGrowthBp: unknown };
    const curve = XpCurveSchema.parse({ xpToNext: file.xpToNext, tailGrowthBp: file.tailGrowthBp });
    expect(XP_CURVE).toEqual(curve);
  });

  it('hero skills match skills/region_1.json (cooldown, targeting)', () => {
    const skills = new Map((content('skills/region_1.json') as unknown[]).map((raw) => {
      const skill = SkillSchema.parse(raw);
      return [skill.id, skill] as const;
    }));
    for (const hero of HERO_SKILLS) {
      expect(skills.get(hero.id)?.cooldownTicks, hero.id).toBe(hero.cooldownTicks);
      expect(skills.get(hero.id)?.targeting, hero.id).toBe(KNOWN_SKILL_TARGETING[hero.id]);
    }
    expect(HERO_SKILLS.map((skill) => skill.id)).not.toContain(BASIC_ATTACK);
  });
});

describe('levelProgress', () => {
  it('uses the stored XP within the level', () => {
    expect(levelProgress(1, 0)).toMatchObject({ level: 1, xpIntoLevel: 0, xpToNext: 100, progressBp: 0 });
    expect(levelProgress(2, 125)).toMatchObject({ level: 2, xpIntoLevel: 125, xpToNext: 250, progressBp: 5000 });
  });

  it('has no level cap: levels past 6 follow the open-ended curve (#129)', () => {
    expect(levelProgress(6, 40)).toMatchObject({ level: 6, xpIntoLevel: 40, xpToNext: 1250, progressBp: 320, isMaxLevel: false });
    expect(levelProgress(7, 781)).toMatchObject({ level: 7, xpToNext: 1562, progressBp: 5000, isMaxLevel: false });
    expect(levelProgress(8, 0)).toMatchObject({ level: 8, xpToNext: 1952 });
    expect(levelProgress(40, 5)).toMatchObject({ level: 40, isMaxLevel: false });
    expect(levelProgress(100, 0)?.xpToNext).toBeGreaterThan(1_000_000_000);
  });

  it('returns null when the server values do not fit the curve', () => {
    expect(levelProgress(1, 100)).toBeNull();
    expect(levelProgress(6, 1250)).toBeNull(); // reaches level 7
    expect(levelProgress(100_000, 0)).toBeNull(); // beyond the safe-integer bound
  });
});

describe('derived stat rows', () => {
  it('show exactly what rpg-stats derives, with explanations from the formula table', () => {
    const attributes = { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 };
    const expected = deriveStats({ level: 1, attributes, equipment: [] }, DEFAULT_STAT_FORMULAS);
    const rows = statRows(derivedStats(1, attributes));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey['maxHp']?.value).toBe(expected.maxHp);
    expect(byKey['physicalPower']?.value).toBe(expected.powerBySchool.physical);
    expect(byKey['critBp']?.text).toBe('5.8%');
    expect(byKey['actionIntervalTicks']?.text).toBe(`${expected.actionIntervalTicks} ticks`);
    expect(byKey['maxHp']?.explanation).toBe('50 + 8 per VIT + 10 per level above 1.');
    expect(byKey['armor']?.explanation).toContain('0.5 per VIT');
  });

  it('formats bp ratios', () => {
    expect(formatRatio(15_000)).toBe('1.5');
    expect(formatRatio(5_000)).toBe('0.5');
    expect(formatRatio(20_000)).toBe('2');
    expect(formatRatio(12_345)).toBe('1.2345');
  });
});

describe('loadout draft', () => {
  it('fills four slots from the server loadout and compacts empty slots on save', () => {
    const slots = toSlots(['skill:guard', 'skill:basic_attack', 'skill:mend']);
    expect(slots).toEqual(['skill:guard', 'skill:mend', null, null]);
    expect(toLoadout(assignSlot(slots, 0, null))).toEqual(['skill:mend']);
  });

  it('swaps instead of duplicating a skill already in another slot', () => {
    const slots = toSlots(BULWARK.loadout);
    expect(assignSlot(slots, 0, 'skill:mend')).toEqual(['skill:mend', 'skill:guard', 'skill:cleave', 'skill:shield_bash']);
    expect(assignSlot(toSlots(['skill:guard']), 2, 'skill:guard')).toEqual([null, null, 'skill:guard', null]);
  });

  it('marks only the provisional starter kit (plus saved skills) as unlocked', () => {
    const unlocked = (saved: string[]) => skillOptions(saved).filter((option) => option.unlocked).map((option) => option.id);
    expect(unlocked([])).toEqual(BULWARK.loadout);
    expect(unlocked(['skill:rend'])).toContain('skill:rend');
    expect(presetLockedReason(BULWARK, skillOptions([]))).toBeNull();
    expect(presetLockedReason(THORNBLADE, skillOptions([]))).toBe('Precise Strike, Rend, Second Wind are not unlocked yet.');
  });

  it('finds the rules that name a skill the new loadout drops', () => {
    const loadout = ['skill:shield_bash', 'skill:guard', 'skill:cleave'] as const;
    const conflicts = ruleConflicts(BULWARK_RULES, [...loadout]);
    expect(conflicts.map((conflict) => [conflict.index, conflict.missing])).toEqual([[2, ['skill:mend']]]);
    const remaining = rulesWithout(BULWARK_RULES, conflicts) as AutomationRules;
    expect(remaining).toHaveLength(BULWARK_RULES.length - 1);
    expect(ruleConflicts(remaining, [...loadout])).toEqual([]);
    expect(ruleConflicts([{ when: {}, do: { useSkill: BASIC_ATTACK } }, 'garbage'], [])).toEqual([]);
  });
});

describe('attribute allocation', () => {
  it('spends only earned points and never goes negative', () => {
    let allocation = adjustAllocation(NO_ALLOCATION, 'VIT', 1, 2);
    allocation = adjustAllocation(allocation, 'STR', 1, 2);
    expect(adjustAllocation(allocation, 'AGI', 1, 2)).toBe(allocation);
    expect(adjustAllocation(NO_ALLOCATION, 'AGI', -1, 2)).toBe(NO_ALLOCATION);
    expect(pointsSpent(allocation)).toBe(2);
    expect(allocatePayload(allocation)).toEqual({ STR: 1, VIT: 1 });
    expect(withAllocation({ STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, allocation)).toEqual({ STR: 10, AGI: 4, INT: 2, VIT: 11, SPI: 5 });
  });
});
