/**
 * Resource (gather) nodes and idle activities (data-model §1 `IdleActivity`, docs/spec/idle-simulation.md).
 *
 * Idle activities are per area (e.g. `idle:verdant_hollow.hunt`) and listed in the engine area's `activities`.
 * `encountersPerHour` is content-tuned pacing (open decision #16).
 */
import { TagSchema } from '@engine/world';
import { z } from 'zod';

import { EncounterTableIdSchema, IdleActivityIdSchema, LootTableIdSchema, ResourceNodeIdSchema, TextKeySchema } from './ids.ts';

export const ResourceNodeSchema = z.strictObject({
  id: ResourceNodeIdSchema,
  nameKey: TextKeySchema.optional(),
  /** Ticks a gather action takes in live play. */
  gatherTicks: z.int().positive(),
  tags: z.array(TagSchema).default([]),
  deprecated: z.boolean().optional(),
});
export type ResourceNode = z.output<typeof ResourceNodeSchema>;

export const ResourceYieldSchema = z.strictObject({
  node: ResourceNodeIdSchema,
  lootTable: LootTableIdSchema,
  /** Loot-table rolls per hour of idle time. */
  rollsPerHour: z.int().positive(),
});
export type ResourceYield = z.output<typeof ResourceYieldSchema>;

export const IdleActivitySchema = z
  .strictObject({
    id: IdleActivityIdSchema,
    nameKey: TextKeySchema.optional(),
    /** Encounters rolled per hour of idle time; 0 for pure gathering. */
    encountersPerHour: z.int().min(0),
    encounterTable: EncounterTableIdSchema.optional(),
    resourceYields: z.array(ResourceYieldSchema).default([]),
    tags: z.array(TagSchema).default([]),
    deprecated: z.boolean().optional(),
  })
  .refine((a) => (a.encountersPerHour > 0) === (a.encounterTable !== undefined), {
    message: '"encounterTable" is required exactly when "encountersPerHour" > 0',
    path: ['encounterTable'],
  })
  .refine((a) => a.encountersPerHour > 0 || a.resourceYields.length > 0, {
    message: 'idle activity yields nothing (no encounters and no resource yields)',
    path: [],
  });
export type IdleActivity = z.output<typeof IdleActivitySchema>;
export type IdleActivityInput = z.input<typeof IdleActivitySchema>;
