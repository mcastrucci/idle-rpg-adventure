/**
 * Compare-vs-equipped deltas for equip previews (`after − before` for every displayed number).
 */
import { ATTRIBUTES } from '@rpg/rpg-schema';

import type { Attribute, DerivedStats } from './derive.ts';

/** Every number a preview can show, in display order. */
export const STAT_DELTA_KEYS = [
  ...ATTRIBUTES,
  'maxHp',
  'power',
  'physicalPower',
  'magicPower',
  'armor',
  'resist',
  'critBp',
  'haste',
  'actionIntervalTicks',
  'healPower',
] as const;
export type StatDeltaKey = (typeof STAT_DELTA_KEYS)[number];
export type StatDelta = Readonly<Record<StatDeltaKey, number>>;

/** Flattens derived stats into the {@link StatDeltaKey} shape. */
export function flattenStats(stats: DerivedStats): StatDelta {
  const attrs = {} as Record<Attribute, number>;
  for (const attr of ATTRIBUTES) attrs[attr] = stats.attributes[attr];
  return {
    ...attrs,
    maxHp: stats.maxHp,
    power: stats.power,
    physicalPower: stats.powerBySchool.physical,
    magicPower: stats.powerBySchool.magic,
    armor: stats.armor,
    resist: stats.resist,
    critBp: stats.critBp,
    haste: stats.haste,
    actionIntervalTicks: stats.actionIntervalTicks,
    healPower: stats.healPower,
  };
}

/**
 * `after − before` per key. Note `actionIntervalTicks` is "lower is better": a negative delta is an improvement.
 */
export function statDelta(before: DerivedStats, after: DerivedStats): StatDelta {
  const a = flattenStats(before);
  const b = flattenStats(after);
  const out = {} as Record<StatDeltaKey, number>;
  for (const key of STAT_DELTA_KEYS) out[key] = b[key] - a[key];
  return out;
}

/** Keys whose delta is non-zero, in display order. */
export function changedStats(delta: StatDelta): StatDeltaKey[] {
  return STAT_DELTA_KEYS.filter((key) => delta[key] !== 0);
}
