/**
 * Weighted tables (data-model §1 `LootTable`, `EncounterTable`). Weights are positive integers; rolls use the
 * simulator's integer RNG (`rng.loot`, `rng.encounters`), so probabilities are `weight / totalWeight`.
 */
import { z } from 'zod';

import { EncounterTableIdSchema, EnemyIdSchema, ItemIdSchema, LootTableIdSchema } from './ids.ts';

const WeightSchema = z.int().positive();

/** Inclusive integer range with `min <= max`. */
export function intRange(min: number) {
  return z
    .strictObject({ min: z.int().min(min), max: z.int().min(min) })
    .refine((r) => r.min <= r.max, { message: '"min" must be <= "max"', path: ['max'] });
}

export const QtyRangeSchema = intRange(1);
export type QtyRange = z.output<typeof QtyRangeSchema>;
export const GoldRangeSchema = intRange(0);

export const LootEntrySchema = z.strictObject({
  item: ItemIdSchema,
  weight: WeightSchema,
  qty: QtyRangeSchema.default({ min: 1, max: 1 }),
});
export type LootEntry = z.output<typeof LootEntrySchema>;

export const GuaranteedDropSchema = z.strictObject({ item: ItemIdSchema, qty: QtyRangeSchema.default({ min: 1, max: 1 }) });

export const LootTableSchema = z
  .strictObject({
    id: LootTableIdSchema,
    /** Number of independent weighted rolls on `entries`. */
    rolls: z.int().min(0).default(1),
    /** Weight of rolling nothing (alongside `entries`). */
    nothingWeight: z.int().min(0).default(0),
    entries: z.array(LootEntrySchema).default([]),
    guaranteed: z.array(GuaranteedDropSchema).default([]),
    gold: GoldRangeSchema.optional(),
    deprecated: z.boolean().optional(),
  })
  .refine((t) => t.rolls === 0 || t.entries.length > 0, { message: 'rolls > 0 needs at least one entry', path: ['entries'] })
  .refine((t) => t.entries.length > 0 || t.guaranteed.length > 0 || t.gold !== undefined, {
    message: 'loot table drops nothing (no entries, guaranteed drops or gold)',
    path: [],
  });
export type LootTable = z.output<typeof LootTableSchema>;
export type LootTableInput = z.input<typeof LootTableSchema>;

export const EncounterGroupMemberSchema = z.strictObject({ enemy: EnemyIdSchema, count: z.int().positive().default(1) });

export const EncounterEntrySchema = z.strictObject({
  weight: WeightSchema,
  enemies: z.array(EncounterGroupMemberSchema).min(1),
});
export type EncounterEntry = z.output<typeof EncounterEntrySchema>;

export const EncounterTableSchema = z.strictObject({
  id: EncounterTableIdSchema,
  entries: z.array(EncounterEntrySchema).min(1),
  deprecated: z.boolean().optional(),
});
export type EncounterTable = z.output<typeof EncounterTableSchema>;
export type EncounterTableInput = z.input<typeof EncounterTableSchema>;
