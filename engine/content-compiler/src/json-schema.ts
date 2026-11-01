/**
 * JSON Schema export for editor autocompletion (ADR-0008). Schemas describe the *input* JSON files; world entities
 * extended by the game get an `allOf` of the engine schema and the game extension.
 */
import { z } from 'zod';

import { WORLD_COLLECTIONS } from './compile.ts';
import type { ContentGamePlugin, WorldCollectionName } from './plugin.ts';

export interface CollectionJsonSchema {
  readonly collection: string;
  readonly dir: string;
  readonly schema: Record<string, unknown>;
}

export function exportJsonSchemas(plugin: ContentGamePlugin): CollectionJsonSchema[] {
  const toJson = (schema: z.ZodType): Record<string, unknown> =>
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;
  const out: CollectionJsonSchema[] = [];
  for (const name of Object.keys(WORLD_COLLECTIONS) as WorldCollectionName[]) {
    const def = WORLD_COLLECTIONS[name];
    const extension = plugin.extend?.[name];
    const schema = extension ? z.intersection(def.schema, extension) : def.schema;
    out.push({ collection: name, dir: def.dir, schema: toJson(schema) });
  }
  for (const name of Object.keys(plugin.collections).sort()) {
    const def = plugin.collections[name];
    if (def) out.push({ collection: name, dir: def.dir, schema: toJson(def.schema) });
  }
  return out;
}
