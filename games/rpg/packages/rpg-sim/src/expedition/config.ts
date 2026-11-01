/**
 * Config parsing and the activity → simulator kind convention.
 */
import { BP_SCALE } from '@engine/sim-core';
import { IdleActivityIdSchema, ItemIdSchema } from '@rpg/rpg-schema';

import type { RpgIdleContent } from './content.ts';
import type { IdleConsumable, RpgIdleConfig } from './types.ts';

/** Idle simulator kinds; the simulator ID is `rpg.<kind>`. */
export const IDLE_KINDS = ['hunt', 'gather'] as const;
export type IdleKind = (typeof IDLE_KINDS)[number];

/** Upper bound of one consumable stack brought on an expedition (sanity cap, not a game rule). */
export const MAX_IDLE_CONSUMABLE_QTY = 999;

/**
 * **Mapping rule:** the kind of an idle activity is the last segment of its content ID, after the final `.` (or the
 * `:` when there is no `.`): `idle:region_1.hunt` → `hunt`, `idle:region_1.gather` → `gather`, `idle:hunt` → `hunt`
 * (activity IDs are per area, design region-1 §9 Q-B14). Activities whose kind is not in {@link IDLE_KINDS} get no
 * simulator (`unregisteredActivities` reports them). The content schema has no `kind` field; if one is added, this
 * rule becomes a lookup of that field.
 */
export function idleKindOf(activityId: string): IdleKind | null {
  const m = /[.:]([a-z0-9_]+)$/.exec(activityId);
  const kind = m?.[1];
  return kind !== undefined && (IDLE_KINDS as readonly string[]).includes(kind) ? (kind as IdleKind) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new TypeError(`${name}: unknown key "${k}"`);
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/**
 * Validates untrusted config input for a simulator of `kind`; throws a `TypeError` on invalid input. Checks the shape,
 * that `activity` is a content idle activity of this kind, and that consumable items are content consumables
 * (unique, `1 ≤ qty ≤ MAX_IDLE_CONSUMABLE_QTY`). Durations are kernel-owned: a `durationMin` key is rejected.
 */
export function parseRpgIdleConfig(input: unknown, content: RpgIdleContent, kind: IdleKind): RpgIdleConfig {
  if (!isRecord(input)) throw new TypeError('config must be an object');
  onlyKeys(input, ['activity', 'consumables', 'retreat'], 'config');

  const activity = input['activity'];
  if (typeof activity !== 'string' || !IdleActivityIdSchema.safeParse(activity).success) {
    throw new TypeError('config.activity must be an idle activity ID');
  }
  if (content.idleActivities[activity] === undefined) throw new TypeError(`config.activity: unknown activity ${activity}`);
  if (idleKindOf(activity) !== kind) throw new TypeError(`config.activity: ${activity} is not a ${kind} activity`);

  const rawConsumables = input['consumables'];
  if (!Array.isArray(rawConsumables)) throw new TypeError('config.consumables must be an array');
  const seen = new Set<string>();
  const consumables: IdleConsumable[] = rawConsumables.map((c: unknown, i) => {
    const name = `config.consumables[${i}]`;
    if (!isRecord(c)) throw new TypeError(`${name} must be an object`);
    onlyKeys(c, ['item', 'qty'], name);
    const item = c['item'];
    if (typeof item !== 'string' || !ItemIdSchema.safeParse(item).success) throw new TypeError(`${name}.item must be an item ID`);
    if (content.combat.items[item]?.kind !== 'consumable') throw new TypeError(`${name}.item: ${item} is not a consumable`);
    if (seen.has(item)) throw new TypeError(`${name}.item: duplicate ${item}`);
    seen.add(item);
    return { item, qty: intIn(c['qty'], 1, MAX_IDLE_CONSUMABLE_QTY, `${name}.qty`) };
  });

  const retreat = input['retreat'];
  if (!isRecord(retreat)) throw new TypeError('config.retreat must be an object');
  onlyKeys(retreat, ['belowHpBp', 'onlyWhenNoHealing'], 'config.retreat');
  const onlyWhenNoHealing = retreat['onlyWhenNoHealing'];
  if (typeof onlyWhenNoHealing !== 'boolean') throw new TypeError('config.retreat.onlyWhenNoHealing must be a boolean');

  return {
    activity,
    consumables,
    retreat: { belowHpBp: intIn(retreat['belowHpBp'], 0, BP_SCALE, 'config.retreat.belowHpBp'), onlyWhenNoHealing },
  };
}
