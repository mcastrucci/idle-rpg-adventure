import { DEFAULT_STAT_FORMULAS, deriveStats, flattenStats } from '@rpg/rpg-stats';
import type { AttributeMap, DerivedStats, StatDelta, StatFormulaTable } from '@rpg/rpg-stats';

import { decimalSeparator, t } from '../i18n/index.ts';
import { formatBp } from '../rules/describe.ts';

/** Display names of every stat the client shows (derived stats here, the server's summary rows, item comparisons). */
export const STAT_LABEL_KEYS = {
  STR: 'ui.stat.str', AGI: 'ui.stat.agi', INT: 'ui.stat.int', VIT: 'ui.stat.vit', SPI: 'ui.stat.spi',
  maxHp: 'ui.stat.max_hp', physicalPower: 'ui.stat.physical_power', magicPower: 'ui.stat.magic_power', armor: 'ui.stat.armor',
  resist: 'ui.stat.resist', critBp: 'ui.stat.crit', haste: 'ui.stat.haste', actionIntervalTicks: 'ui.stat.interval',
  healPower: 'ui.stat.heal_power',
} as const;

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
  return rest === 0 ? String(whole) : `${whole}${decimalSeparator()}${String(rest).padStart(4, '0').replace(/0+$/, '')}`;
}

export function formatStat(key: DisplayedStat, value: number): string {
  if (key === 'critBp') return formatBp(value);
  if (key === 'actionIntervalTicks') return t('ui.unit.ticks', { count: value });
  return String(value);
}

export function statRows(stats: DerivedStats, table: StatFormulaTable = DEFAULT_STAT_FORMULAS): StatRow[] {
  const flat = flattenStats(stats);
  const level = (perLevel: number) => (perLevel > 0 ? t('ui.stats.per_level', { n: perLevel }) : '');
  const { maxHp, power, armor, resist, crit, haste, healPower } = table;
  const explanations: Record<DisplayedStat, string> = {
    maxHp: t('ui.stats.explain.max_hp', { base: maxHp.base, perVit: maxHp.perVit, level: level(maxHp.perLevel) }),
    physicalPower: t('ui.stats.explain.physical_power', { ratio: formatRatio(power.perStrBp), level: level(power.perLevel) }),
    magicPower: t('ui.stats.explain.magic_power', { ratio: formatRatio(power.perIntBp), level: level(power.perLevel) }),
    armor: t('ui.stats.explain.armor', { ratio: formatRatio(armor.perVitBp) }),
    resist: t('ui.stats.explain.resist', { ratio: formatRatio(resist.perSpiBp) }),
    critBp: t('ui.stats.explain.crit', { base: formatBp(crit.baseBp), perAgi: formatBp(crit.perAgiBp), cap: formatBp(crit.capBp) }),
    actionIntervalTicks: t('ui.stats.explain.interval', {
      haste: stats.haste, ratio: formatRatio(haste.perAgiBp), base: haste.baseActionIntervalTicks, min: haste.minActionIntervalTicks,
    }),
    healPower: t('ui.stats.explain.heal_power', { ratio: formatRatio(healPower.perSpiBp), level: level(healPower.perLevel) }),
  };
  return DISPLAYED_STATS.map((key) => {
    const value = flat[key];
    return { key, label: t(STAT_LABEL_KEYS[key]), value, text: formatStat(key, value), explanation: explanations[key], lowerIsBetter: key === 'actionIntervalTicks' };
  });
}

/** Signed preview text for a stat change (`+8`, `−0.2%`, `−1 tick`), or `null` when unchanged. */
export function formatDelta(key: DisplayedStat, delta: StatDelta): string | null {
  const value = delta[key];
  if (value === 0) return null;
  const sign = value > 0 ? '+' : '−';
  return `${sign}${formatStat(key, Math.abs(value))}`;
}
