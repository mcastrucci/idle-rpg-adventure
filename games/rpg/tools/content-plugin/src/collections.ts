/**
 * RPG collections as registered with the content compiler: the `@rpg/rpg-schema` collections mapped to their
 * directories under `games/rpg/content/` (docs/spec/content-format.md §1), plus the progression documents.
 */
import type { CollectionDefinition } from '@engine/content-compiler';
import { rpgCollections, XpCurveSchema, type RpgCollectionName } from '@rpg/rpg-schema';
import { z } from 'zod';

/** Directory of each `rpgCollections` entry. Typed exhaustively so a new schema collection fails to compile here. */
export const RPG_COLLECTION_DIRS = {
  enemies: 'enemies',
  skills: 'skills',
  items: 'items',
  lootTables: 'loot-tables',
  encounterTables: 'encounter-tables',
  resourceNodes: 'resource-nodes',
  idleActivities: 'idle-activities',
} as const satisfies Record<RpgCollectionName, string>;

/** ID of the (single) XP curve document. */
export const XP_CURVE_ID = 'progression:xp_curve';

/**
 * Progression document as stored in `progression/xp-curve.json`. The compiler only knows ID-keyed collections (no
 * singleton documents), so the curve carries an `id` in the `progression` namespace; its content is validated by
 * `XpCurveSchema` from `@rpg/rpg-schema` (issues are forwarded with their paths). The plugin's `validate` hook enforces
 * exactly one curve with {@link XP_CURVE_ID}.
 */
export const XpCurveDocumentSchema = z
  .strictObject({
    id: z.string().regex(/^progression:[a-z0-9_.]+$/, 'must be a namespaced ID like "progression:name"'),
    xpToNext: z.array(z.int().positive()).min(1),
  })
  .superRefine((doc, ctx) => {
    const result = XpCurveSchema.safeParse({ xpToNext: doc.xpToNext });
    if (result.success) return;
    for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

function stripSeparator(prefix: string): string {
  return prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
}

/** Every RPG game collection, keyed by collection name. */
export const RPG_CONTENT_COLLECTIONS: Readonly<Record<RpgCollectionName | 'progression', CollectionDefinition>> = {
  ...(Object.fromEntries(
    (Object.keys(RPG_COLLECTION_DIRS) as RpgCollectionName[]).map((name): [RpgCollectionName, CollectionDefinition] => [
      name,
      { dir: RPG_COLLECTION_DIRS[name], schema: rpgCollections[name].schema, idPrefix: stripSeparator(rpgCollections[name].idPrefix) },
    ]),
  ) as Record<RpgCollectionName, CollectionDefinition>),
  progression: { dir: 'progression', schema: XpCurveDocumentSchema, idPrefix: 'progression' },
};
