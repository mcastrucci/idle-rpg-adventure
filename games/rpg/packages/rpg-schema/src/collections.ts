/**
 * Plugin-ready description of the RPG content (no dependency on the content compiler): ID-keyed collections, singleton
 * documents, extensions of engine entities, and JSON Schema export (content-format §4 `schema` command).
 */
import { z } from 'zod';

import { EnemySchema } from './enemies.ts';
import { IdleActivitySchema, ResourceNodeSchema } from './gathering.ts';
import { ItemSchema } from './items.ts';
import { XpCurveSchema } from './progression.ts';
import { SkillSchema } from './skills.ts';
import { EncounterTableSchema, LootTableSchema } from './tables.ts';
import { RpgAreaSchema, RpgLocationSchema, rpgAreaFields, rpgLocationFields } from './world.ts';

export interface RpgCollectionDef {
  readonly schema: z.ZodType;
  /** Every document ID in the collection starts with this prefix (namespace + `:`). */
  readonly idPrefix: string;
}

/** ID-keyed content collections owned by the RPG, keyed by collection name (matches the `content/` folder names). */
export const rpgCollections = {
  enemies: { schema: EnemySchema, idPrefix: 'enemy:' },
  skills: { schema: SkillSchema, idPrefix: 'skill:' },
  items: { schema: ItemSchema, idPrefix: 'item:' },
  lootTables: { schema: LootTableSchema, idPrefix: 'loot:' },
  encounterTables: { schema: EncounterTableSchema, idPrefix: 'enc:' },
  resourceNodes: { schema: ResourceNodeSchema, idPrefix: 'res:' },
  idleActivities: { schema: IdleActivitySchema, idPrefix: 'idle:' },
} as const satisfies Record<string, RpgCollectionDef>;
export type RpgCollectionName = keyof typeof rpgCollections;

/** Single documents (not ID-keyed). */
export const rpgSingletons = {
  xpCurve: { schema: XpCurveSchema, path: 'progression/xp-curve.json' },
} as const;

/** RPG versions of engine entities: full strict schemas plus the bare added fields. */
export const rpgEntityExtensions = {
  area: { schema: RpgAreaSchema, fields: rpgAreaFields },
  location: { schema: RpgLocationSchema, fields: rpgLocationFields },
} as const;

/**
 * JSON Schemas (draft 2020-12) for every RPG document type, describing the authored (input) form, for editor
 * autocompletion. Keys: collection names, singleton names, `area`, `location`.
 */
export function rpgJsonSchemas(): Record<string, unknown> {
  const all: Record<string, z.ZodType> = {
    ...Object.fromEntries(Object.entries(rpgCollections).map(([name, def]) => [name, def.schema])),
    ...Object.fromEntries(Object.entries(rpgSingletons).map(([name, def]) => [name, def.schema])),
    area: RpgAreaSchema,
    location: RpgLocationSchema,
  };
  return Object.fromEntries(Object.entries(all).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]));
}
