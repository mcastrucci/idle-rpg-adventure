/**
 * Item definitions (data-model §1 `ItemDef`). Discriminated by `kind`.
 *
 * Stacking: equipment is never stackable (each piece is an `item_instances` row). Other kinds declare
 * `stackable`; a stackable item must declare `maxStack >= 2`, a non-stackable one must omit it.
 */
import { TagSchema } from '@engine/world';
import { z } from 'zod';

import { EffectSchema, isNegatedByGuard } from './effects.ts';
import { ItemIdSchema, TextKeySchema } from './ids.ts';
import { StatMapSchema } from './stats.ts';

/** Equipment slots. Provisional (open decision #13 covers the final build system). */
export const EQUIPMENT_SLOTS = ['weapon', 'offhand', 'head', 'chest', 'legs', 'hands', 'feet', 'accessory'] as const;
export const EquipmentSlotSchema = z.enum(EQUIPMENT_SLOTS);
export type EquipmentSlot = z.output<typeof EquipmentSlotSchema>;

const common = {
  id: ItemIdSchema,
  nameKey: TextKeySchema.optional(),
  /** Vendor value in gold. */
  value: z.int().min(0),
  tags: z.array(TagSchema).default([]),
  deprecated: z.boolean().optional(),
};

const stacking = {
  stackable: z.boolean(),
  maxStack: z.int().min(2).optional(),
};

function stackingIsConsistent(item: { stackable: boolean; maxStack?: number | undefined }): boolean {
  return item.stackable === (item.maxStack !== undefined);
}
const STACKING_MESSAGE = 'stackable items need "maxStack" (>= 2); non-stackable items must omit it';

export const EquipmentItemSchema = z.strictObject({
  ...common,
  kind: z.literal('equipment'),
  slot: EquipmentSlotSchema,
  stats: StatMapSchema.default({}),
  levelRequired: z.int().positive().optional(),
  stackable: z.literal(false).default(false),
});

export const ConsumableItemSchema = z
  .strictObject({
    ...common,
    ...stacking,
    kind: z.literal('consumable'),
    /** Effects applied to the user when consumed. */
    use: z.array(EffectSchema).min(1),
  })
  .refine(stackingIsConsistent, { message: STACKING_MESSAGE, path: ['maxStack'] })
  .refine((item) => !item.use.some(isNegatedByGuard), {
    message: 'negatedByGuard only applies to attack skills, not consumables',
    path: ['use'],
  });

export const MaterialItemSchema = z
  .strictObject({ ...common, ...stacking, kind: z.literal('material') })
  .refine(stackingIsConsistent, { message: STACKING_MESSAGE, path: ['maxStack'] });

export const QuestItemSchema = z
  .strictObject({ ...common, ...stacking, kind: z.literal('quest') })
  .refine(stackingIsConsistent, { message: STACKING_MESSAGE, path: ['maxStack'] });

export const ItemSchema = z.discriminatedUnion('kind', [
  EquipmentItemSchema,
  ConsumableItemSchema,
  MaterialItemSchema,
  QuestItemSchema,
]);
export type Item = z.output<typeof ItemSchema>;
export type ItemInput = z.input<typeof ItemSchema>;
export type ItemKind = Item['kind'];
export type EquipmentItem = z.output<typeof EquipmentItemSchema>;
export type ConsumableItem = z.output<typeof ConsumableItemSchema>;
