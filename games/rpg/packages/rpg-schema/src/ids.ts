/**
 * Namespaced RPG content IDs (docs/spec/content-format.md §2). `area:` and `loc:` belong to `@engine/world` and are
 * re-exported from there; the namespaces below are owned by the RPG.
 */
import { z } from 'zod';

/** RPG-owned ID namespaces. Stable: never rename (ADR-0008). */
export const RPG_ID_NAMESPACES = {
  enemy: 'enemy',
  skill: 'skill',
  item: 'item',
  loot: 'loot',
  encounterTable: 'enc',
  resourceNode: 'res',
  idleActivity: 'idle',
} as const;

/** Same name pattern as `@engine/world` (`<ns>:` followed by lowercase letters, digits, `_` and `.`). */
function idInNamespace<N extends string>(namespace: N) {
  return z
    .string()
    .regex(new RegExp(`^${namespace}:[a-z0-9_.]+$`), `must be a namespaced ID like "${namespace}:name"`)
    .transform((value) => value as `${N}:${string}`);
}

export const EnemyIdSchema = idInNamespace('enemy');
export const SkillIdSchema = idInNamespace('skill');
export const ItemIdSchema = idInNamespace('item');
export const LootTableIdSchema = idInNamespace('loot');
export const EncounterTableIdSchema = idInNamespace('enc');
export const ResourceNodeIdSchema = idInNamespace('res');
export const IdleActivityIdSchema = idInNamespace('idle');

export type EnemyId = `enemy:${string}`;
export type SkillId = `skill:${string}`;
export type ItemId = `item:${string}`;
export type LootTableId = `loot:${string}`;
export type EncounterTableId = `enc:${string}`;
export type ResourceNodeId = `res:${string}`;
export type IdleActivityId = `idle:${string}`;

/** i18n key (content-format §5), e.g. `lore.old_well.inscription`. */
export const TextKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*$/, 'must be a dotted i18n key');

/** Local (non-namespaced) identifier, e.g. a hotspot ID matching a Tiled object name. */
export const LocalIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase snake identifier');

export { AreaIdSchema, LocationIdSchema, type AreaId, type LocationId } from '@engine/world';
