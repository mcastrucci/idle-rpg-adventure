import { DEFAULT_STAT_FORMULAS, deriveStats, flattenStats } from '@rpg/rpg-stats';
import type { AttributeMap, DerivedStats, StatDelta, StatFormulaTable } from '@rpg/rpg-stats';

import { formatBp } from '../rules/describe.ts';

/** Derived stats shown on the Character screen, in display order. */
export const DISPLAYED_STATS = [
  'maxHp', 'physicalPower', 'magicPower', 'armor', 'resist', 'critBp', 'actionIntervalTicks', 'healPower',
] as const;
export type DisplayedStat = typeof DISPLAYED_STATS[number];

export interface StatRow {
  readonly key: DisplayedStat;
  readonly label: string;
  readonly value: number;
  /** Formatted value (`5.8%`, `6 ticks`). */
  readonly text: string;
  /** One-line explanation built from the formula table, so it never drifts from the numbers. */
  readonly explanation: string;
  /** `actionIntervalTicks` is better when lower. */
  readonly lowerIsBetter: boolean;
}

/**
 * Display copy of the server's stat derivation: same shared `@rpg/rpg-stats` code and the same provisional table
 * (open decision #2). GAP: no inventory yet, so stats are shown without gear; the server stays authoritative.
 */
export function derivedStats(level: number, attributes: AttributeMap, table: StatFormulaTable = DEFAULT_STAT_FORMULAS): DerivedStats {
  return deriveStats({ level, attributes, equipment: [] }, table);
}

/** `15000` → `1.5` (bp ratio as a short decimal). */
export function formatRatio(bp: number): string {
  const whole = Math.trunc(bp / 10_000);
  const rest = bp % 10_000;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(4, '0').replace(/0+$/, '')}`;
}

export function formatStat(key: DisplayedStat, value: number): string {
  if (key === 'critBp') return formatBp(value);
  if (key === 'actionIntervalTicks') return `${value} ${value === 1 ? 'tick' : 'ticks'}`;
  return String(value);
}

export function statRows(stats: DerivedStats, table: StatFormulaTable = DEFAULT_STAT_FORMULAS): StatRow[] {
  const flat = flattenStats(stats);
  const lvl = (perLevel: number) => (perLevel > 0 ? ` + ${perLevel} per level above 1` : '');
  const { maxHp, power, armor, resist, crit, haste, healPower } = table;
  const explanations: Record<DisplayedStat, [label: string, explanation: string]> = {
    maxHp: ['Max HP', `${maxHp.base} + ${maxHp.perVit} per VIT${lvl(maxHp.perLevel)}.`],
    physicalPower: ['Physical power', `${formatRatio(power.perStrBp)} per STR${lvl(power.perLevel)}. Scales physical skills.`],
    magicPower: ['Magic power', `${formatRatio(power.perIntBp)} per INT${lvl(power.perLevel)}. Scales magic skills.`],
    armor: ['Armor', `${formatRatio(armor.perVitBp)} per VIT. Reduces physical damage taken.`],
    resist: ['Resist', `${formatRatio(resist.perSpiBp)} per SPI. Reduces magic damage taken.`],
    critBp: ['Crit chance', `${formatBp(crit.baseBp)} + ${formatBp(crit.perAgiBp)} per AGI, at most ${formatBp(crit.capBp)}.`],
    actionIntervalTicks: ['Action interval',
      `Time between actions. Haste ${stats.haste} (${formatRatio(haste.perAgiBp)} per AGI) shortens it from ${haste.baseActionIntervalTicks}; never below ${haste.minActionIntervalTicks}.`],
    healPower: ['Heal power', `${formatRatio(healPower.perSpiBp)} per SPI${lvl(healPower.perLevel)}. Scales healing skills.`],
  };
  return DISPLAYED_STATS.map((key) => {
    const [label, explanation] = explanations[key];
    const value = flat[key];
    return { key, label, value, text: formatStat(key, value), explanation, lowerIsBetter: key === 'actionIntervalTicks' };
  });
}

/** Signed preview text for a stat change (`+8`, `−0.2%`, `−1 tick`), or `null` when unchanged. */
export function formatDelta(key: DisplayedStat, delta: StatDelta): string | null {
  const value = delta[key];
  if (value === 0) return null;
  const sign = value > 0 ? '+' : '−';
  return `${sign}${formatStat(key, Math.abs(value))}`;
}
