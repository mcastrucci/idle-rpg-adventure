import type { LoadedContent } from '@engine/server-kit';
import { SceneGeometryMapSchema, validateWorld } from '@engine/world';
import { createRpgPredicateRegistry, rpgCollections, RpgAreaSchema, RpgLocationSchema, XpCurveSchema } from '@rpg/rpg-schema';

import { validateRpgReferences } from './references.ts';

/** Boot validates runtime schemas without importing the content compiler or game build tooling. */
export function validateRpgBundle(content: LoadedContent): void {
  const world = validateWorld(content.world, createRpgPredicateRegistry());
  if (!world.ok) throw new Error('compiled RPG world is invalid');
  for (const area of world.world.areas) RpgAreaSchema.parse(area);
  const locations = world.world.locations.map((location) => RpgLocationSchema.parse(location));
  if (content.format === 1) {
    if (content.scenes !== undefined || locations.some((location) => location.scene !== undefined)) throw new Error('format 1 RPG bundle cannot contain scenes');
  } else {
    if (content.scenes === undefined) throw new Error('format 2 RPG bundle needs scenes');
    const scenes = SceneGeometryMapSchema.parse(content.scenes);
    if (Object.keys(scenes).length === 0) throw new Error('format 2 RPG bundle needs scene geometry');
    const expected = locations.filter((location) => location.scene !== undefined).map((location) => location.id).sort();
    const actual = Object.keys(scenes).sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) throw new Error('RPG scene references and scene geometry locations do not match');
    for (const location of locations) {
      if (location.scene === undefined) continue;
      const scene = scenes[location.id];
      if (!scene) throw new Error(`missing scene geometry for ${location.id}`);
      const expectedResources = new Map<string, number>();
      const resourceIds = location.resources.map((resource) => {
        const ordinal = expectedResources.get(resource.node) ?? 0;
        expectedResources.set(resource.node, ordinal + 1);
        return `${resource.node}#${ordinal}`;
      });
      exactGeometryIds(location.id, 'exits', location.exits.map((exit) => exit.id), Object.keys(scene.exits));
      exactGeometryIds(location.id, 'hotspots', location.hotspots.map((hotspot) => hotspot.id), Object.keys(scene.hotspots));
      exactGeometryIds(location.id, 'resources', resourceIds, Object.keys(scene.resources));
      exactGeometryIds(location.id, 'enemyAnchors', location.enemyAnchors ?? [], Object.keys(scene.enemyAnchors));
    }
  }
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

function exactGeometryIds(location: string, field: string, expectedIds: readonly string[], actualIds: readonly string[]): void {
  const expected = [...expectedIds].sort();
  const actual = [...actualIds].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`${location} ${field} geometry names do not match RPG JSON`);
  }
}
