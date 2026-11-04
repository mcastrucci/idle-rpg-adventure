import type { StatSummaryKey } from '@rpg/protocol';

import { formatBp } from '../rules/describe.ts';

/** Row labels for the server's stat summary (`StatSummaryDto.rows[].key`). Names only; every number comes from the server. */
const LABELS: Readonly<Record<StatSummaryKey, string>> = {
  STR: 'STR', AGI: 'AGI', INT: 'INT', VIT: 'VIT', SPI: 'SPI',
  maxHp: 'Max HP', physicalPower: 'Physical power', magicPower: 'Magic power', armor: 'Armor', resist: 'Resist',
  critBp: 'Crit chance', haste: 'Haste', actionIntervalTicks: 'Action interval', healPower: 'Heal power',
};

export function summaryLabel(key: StatSummaryKey): string {
  return LABELS[key];
}

/** Plain value (`12`, `5.8%`, `6 ticks`). */
export function summaryValue(key: StatSummaryKey, value: number): string {
  if (key === 'critBp') return formatBp(value);
  if (key === 'actionIntervalTicks') return `${value} ${Math.abs(value) === 1 ? 'tick' : 'ticks'}`;
  return String(value);
}

/** Signed change (`+8`, `−0.2%`, `−1 tick`); `—` when nothing changes. */
export function summaryChange(key: StatSummaryKey, value: number): string {
  if (value === 0) return '—';
  return `${value > 0 ? '+' : '−'}${summaryValue(key, Math.abs(value))}`;
}

/** A change is good unless it raises the action interval (lower is better there). */
export function isImprovement(key: StatSummaryKey, value: number): boolean {
  return key === 'actionIntervalTicks' ? value < 0 : value > 0;
}
