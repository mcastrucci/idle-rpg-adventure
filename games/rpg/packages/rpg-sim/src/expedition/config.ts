/**
 * Config parsing and the activity → simulator kind convention.
 */
import { BP_SCALE } from '@engine/sim-core';
import type { IdleActivity } from '@rpg/rpg-schema';
import { ItemIdSchema } from '@rpg/rpg-schema';

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
 * The content idle activity a simulator of `kind` runs for the kernel-owned `activityId` (start request), or a reason
 * why it cannot: missing (`undefined`, e.g. a direct call without a target), unknown, or of another kind.
 */
export function idleActivityFor(
  content: RpgIdleContent,
  kind: IdleKind,
  activityId: string | undefined,
): { readonly ok: true; readonly activity: IdleActivity } | { readonly ok: false; readonly code: string; readonly message: string } {
  if (activityId === undefined) return { ok: false, code: 'rpg.noActivity', message: 'the start request carries no activityId' };
  const activity = Object.hasOwn(content.idleActivities, activityId) ? content.idleActivities[activityId] : undefined;
  if (activity === undefined) return { ok: false, code: 'rpg.unknownActivity', message: `unknown activity ${activityId}` };
  if (idleKindOf(activityId) !== kind) return { ok: false, code: 'rpg.activityKindMismatch', message: `${activityId} is not a ${kind} activity` };
  return { ok: true, activity };
}

/**
 * Validates untrusted config input; throws a `TypeError` on invalid input. Checks the shape and that consumable items
 * are content consumables (unique, `1 ≤ qty ≤ MAX_IDLE_CONSUMABLE_QTY`). Duration and activity are kernel-owned (start
 * request): `durationMin` and `activity` keys are rejected (the latter was part of the config before `rpg-idle@2.0.0`).
 */
export function parseRpgIdleConfig(input: unknown, content: RpgIdleContent): RpgIdleConfig {
  if (!isRecord(input)) throw new TypeError('config must be an object');
  onlyKeys(input, ['consumables', 'retreat'], 'config');

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
    consumables,
    retreat: { belowHpBp: intIn(retreat['belowHpBp'], 0, BP_SCALE, 'config.retreat.belowHpBp'), onlyWhenNoHealing },
  };
}
