import type { StatSummaryKey } from '@rpg/protocol';

import { t } from '../i18n/index.ts';
import { formatBp } from '../rules/describe.ts';
import { STAT_LABEL_KEYS } from './stats.ts';

/** Row labels for the server's stat summary (`StatSummaryDto.rows[].key`). Names only; every number comes from the server. */
export function summaryLabel(key: StatSummaryKey): string {
  return t(STAT_LABEL_KEYS[key]);
}

/** Plain value (`12`, `5.8%`, `6 ticks`). */
export function summaryValue(key: StatSummaryKey, value: number): string {
  if (key === 'critBp') return formatBp(value);
  if (key === 'actionIntervalTicks') return t('ui.unit.ticks', { count: Math.abs(value) });
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
