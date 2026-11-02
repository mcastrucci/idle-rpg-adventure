import { ATTRIBUTES } from '@rpg/rpg-schema';

import type { AttributeKey } from '../api/types.ts';

export type AttributeValues = Readonly<Record<AttributeKey, number>>;

export const ATTRIBUTE_ORDER: readonly AttributeKey[] = ATTRIBUTES;

export const ATTRIBUTE_HINTS: Readonly<Record<AttributeKey, string>> = {
  STR: 'Physical power',
  AGI: 'Crit and haste',
  INT: 'Magic power',
  VIT: 'Max HP and armor',
  SPI: 'Heal power and resist',
};

export const NO_ALLOCATION: AttributeValues = { STR: 0, AGI: 0, INT: 0, VIT: 0, SPI: 0 };

export function pointsSpent(allocation: AttributeValues): number {
  return ATTRIBUTE_ORDER.reduce((sum, key) => sum + allocation[key], 0);
}

/**
 * Adds `delta` points to one attribute of a pending allocation. The server only accepts additive spending of earned
 * unspent points (no respec), so the pending value never goes below zero or above the points available.
 */
export function adjustAllocation(allocation: AttributeValues, key: AttributeKey, delta: number, unspentPoints: number): AttributeValues {
  const value = allocation[key] + delta;
  if (value < 0) return allocation;
  const next = { ...allocation, [key]: value };
  return pointsSpent(next) > unspentPoints ? allocation : next;
}

export function withAllocation(attributes: AttributeValues, allocation: AttributeValues): AttributeValues {
  const out = { ...attributes };
  for (const key of ATTRIBUTE_ORDER) out[key] += allocation[key];
  return out;
}

/** The server's `allocate` payload: only the attributes that receive points. */
export function allocatePayload(allocation: AttributeValues): Partial<Record<AttributeKey, number>> {
  const out: Partial<Record<AttributeKey, number>> = {};
  for (const key of ATTRIBUTE_ORDER) if (allocation[key] > 0) out[key] = allocation[key];
  return out;
}
