import type { LoadedContent } from '@engine/server-kit';
import { validateWorld } from '@engine/world';
import { createRpgPredicateRegistry, rpgCollections, RpgAreaSchema, RpgLocationSchema, XpCurveSchema } from '@rpg/rpg-schema';

import { validateRpgReferences } from './references.ts';

/** Boot validates runtime schemas without importing the content compiler or game build tooling. */
export function validateRpgBundle(content: LoadedContent): void {
  const world = validateWorld(content.world, createRpgPredicateRegistry());
  if (!world.ok) throw new Error('compiled RPG world is invalid');
  for (const area of world.world.areas) RpgAreaSchema.parse(area);
  for (const location of world.world.locations) RpgLocationSchema.parse(location);
  const expected = [...Object.keys(rpgCollections), 'progression'];
  if (Object.keys(content.collections).some((name) => !expected.includes(name))) throw new Error('unknown compiled RPG collection');
  for (const [name, definition] of Object.entries(rpgCollections)) {
    const entities = content.collections[name];
    if (entities === undefined) throw new Error(`missing RPG collection: ${name}`);
    for (const entity of entities) definition.schema.parse(entity);
  }
  const progression = content.collections['progression'];
  if (progression?.length !== 1) throw new Error('expected one RPG XP curve');
  const curve = progression[0] as { id?: unknown; xpToNext?: unknown };
  if (curve.id !== 'progression:xp_curve') throw new Error('missing RPG XP curve');
  XpCurveSchema.parse({ xpToNext: curve.xpToNext });
  validateRpgReferences(world.world, content.collections);
}
