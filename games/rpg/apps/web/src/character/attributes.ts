import { ATTRIBUTES } from '@rpg/rpg-schema';

import type { AttributeKey } from '../api/types.ts';
import { t } from '../i18n/index.ts';

export type AttributeValues = Readonly<Record<AttributeKey, number>>;

export const ATTRIBUTE_ORDER: readonly AttributeKey[] = ATTRIBUTES;

const ATTRIBUTE_HINT_KEYS: Readonly<Record<AttributeKey, string>> = {
  STR: 'ui.attribute.hint_str',
  AGI: 'ui.attribute.hint_agi',
  INT: 'ui.attribute.hint_int',
  VIT: 'ui.attribute.hint_vit',
  SPI: 'ui.attribute.hint_spi',
};

const ATTRIBUTE_NAME_KEYS: Readonly<Record<AttributeKey, string>> = {
  STR: 'ui.attribute.name_str',
  AGI: 'ui.attribute.name_agi',
  INT: 'ui.attribute.name_int',
  VIT: 'ui.attribute.name_vit',
  SPI: 'ui.attribute.name_spi',
};

/** One-line explanation of what an attribute improves. */
export function attributeHint(key: AttributeKey): string {
  return t(ATTRIBUTE_HINT_KEYS[key]);
}

/** Short attribute label (`STR` / `FUE`); the server key stays the identity, this is display only. */
export function attributeName(key: AttributeKey): string {
  return t(ATTRIBUTE_NAME_KEYS[key]);
}

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
