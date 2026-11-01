/**
 * RPG extensions of the `@engine/world` area and location entities (docs/engine/world-model.md §2).
 *
 * Composition decision: the RPG adds **flat top-level fields** (as in docs/spec/content-format.md §3 and the engine's
 * own fixtures) instead of an `rpg: {}` sub-object. `RpgAreaSchema`/`RpgLocationSchema` are *strict* objects built
 * from the engine shape plus the RPG fields, so typos fail loudly in RPG content; the engine keeps parsing the same
 * JSON with its loose schemas and ignores the RPG fields. The bare field shapes are exported too
 * (`rpgAreaFields`, `rpgLocationFields`) so the content compiler's schema registry can merge them itself.
 *
 * Mapping from the pre-engine content format: `region:` → `area:`; location `kind`/`conquestPool` → engine `tags`
 * (e.g. `ordinary`, `boss_room`) and `completion.pool`; `region` back-reference → the area's `locations[]`;
 * `mandatoryBosses` → `completion.required` with `{ "game": "defeated", "enemy": … }`; `idle.activities` → engine
 * `activities` (restricted here to `idle:` IDs).
 */
import { AreaSchema, LocationSchema } from '@engine/world';
import { z } from 'zod';

import { EncounterTableIdSchema, IdleActivityIdSchema, LocalIdSchema, LootTableIdSchema, ResourceNodeIdSchema, TextKeySchema } from './ids.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------------------------------------------------

/** `[min, max]` recommended character level. */
export const LevelRangeSchema = z
  .tuple([z.int().positive(), z.int().positive()])
  .refine(([min, max]) => min <= max, { message: 'level range must be [min, max] with min <= max' });

export const rpgAreaFields = {
  nameKey: TextKeySchema.optional(),
  /** Difficulty tier; required for explorable areas. */
  difficulty: z.int().positive().optional(),
  recommendedLevel: LevelRangeSchema.optional(),
  /** Narrows the engine's generic activity IDs to RPG idle activities. */
  activities: z.array(IdleActivityIdSchema).optional(),
};

export const RpgAreaSchema = z
  .strictObject({ ...AreaSchema.shape, ...rpgAreaFields })
  .superRefine((area, ctx) => {
    if (area.kind !== 'explorable') return;
    if (area.difficulty === undefined) ctx.addIssue({ code: 'custom', path: ['difficulty'], message: 'explorable areas need "difficulty"' });
    if (area.recommendedLevel === undefined) {
      ctx.addIssue({ code: 'custom', path: ['recommendedLevel'], message: 'explorable areas need "recommendedLevel"' });
    }
  });
export type RpgArea = z.output<typeof RpgAreaSchema>;
export type RpgAreaInput = z.input<typeof RpgAreaSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------------------------------------------------

export const LocationResourceSchema = z.strictObject({ node: ResourceNodeIdSchema, lootTable: LootTableIdSchema });

/** Hotspot kinds. Provisional set; geometry lives in the Tiled scene (object name = hotspot ID). */
export const HOTSPOT_TYPES = ['lore', 'search', 'interact'] as const;
export const HotspotSchema = z.strictObject({
  id: LocalIdSchema,
  type: z.enum(HOTSPOT_TYPES),
  textKey: TextKeySchema,
});
export type Hotspot = z.output<typeof HotspotSchema>;

export const rpgLocationFields = {
  nameKey: TextKeySchema.optional(),
  /** Tiled scene path relative to the area folder, e.g. `scenes/old_well.tmj`. */
  scene: z.string().regex(/^[a-z0-9_/.-]+\.tmj$/, 'must be a .tmj path').optional(),
  encounters: EncounterTableIdSchema.optional(),
  resources: z.array(LocationResourceSchema).default([]),
  hotspots: z.array(HotspotSchema).default([]),
};

export const RpgLocationSchema = z
  .strictObject({ ...LocationSchema.shape, ...rpgLocationFields })
  .superRefine((location, ctx) => {
    const seen = new Set<string>();
    location.hotspots.forEach((hotspot, i) => {
      if (seen.has(hotspot.id)) ctx.addIssue({ code: 'custom', path: ['hotspots', i, 'id'], message: `duplicate hotspot "${hotspot.id}"` });
      seen.add(hotspot.id);
    });
  });
export type RpgLocation = z.output<typeof RpgLocationSchema>;
export type RpgLocationInput = z.input<typeof RpgLocationSchema>;
