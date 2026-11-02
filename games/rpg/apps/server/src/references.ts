/** Runtime reference integrity for format-1 RPG bundles. No compiler or build plugin is imported at runtime. */
import { isGameRequirement, walkRequirement } from '@engine/world';
import type { World } from '@engine/world';

const REFERENCES = [
  ['lootTables', 'entries.*.item', 'items'],
  ['lootTables', 'guaranteed.*.item', 'items'],
  ['merchants', 'offers.*.item', 'items'],
  ['merchants', 'offers.*.requiresCompletedArea', 'areas'],
  ['encounterTables', 'entries.*.enemies.*.enemy', 'enemies'],
  ['enemies', 'skills.*', 'skills'],
  ['enemies', 'ai.*.when.skillReady', 'skills'],
  ['enemies', 'lootTable', 'lootTables'],
  ['idleActivities', 'encounterTable', 'encounterTables'],
  ['idleActivities', 'resourceYields.*.node', 'resourceNodes'],
  ['idleActivities', 'resourceYields.*.lootTable', 'lootTables'],
  ['areas', 'activities.*', 'idleActivities'],
  ['locations', 'encounters', 'encounterTables'],
  ['locations', 'resources.*.node', 'resourceNodes'],
  ['locations', 'resources.*.lootTable', 'lootTables'],
] as const;

function* valuesAt(value: unknown, path: readonly string[]): Generator<unknown> {
  if (path.length === 0) { yield value; return; }
  const [head, ...tail] = path;
  if (head === '*' && Array.isArray(value)) {
    for (const child of value) yield* valuesAt(child, tail);
  } else if (head !== undefined && value !== null && typeof value === 'object' && Object.hasOwn(value, head)) {
    yield* valuesAt((value as Record<string, unknown>)[head], tail);
  }
}

/** Called only after entity schemas and engine world references have been validated. */
export function validateRpgReferences(world: World, collections: Readonly<Record<string, readonly unknown[]>>): void {
  const all: Readonly<Record<string, readonly unknown[]>> = { ...collections, areas: world.areas, locations: world.locations, routes: world.routes };
  const ids = new Map<string, Set<string>>();
  const globalIds = new Set<string>();
  for (const [name, entities] of Object.entries(all)) {
    const collectionIds = new Set<string>();
    for (const raw of entities) {
      const entity = raw as { id?: unknown };
      if (typeof entity.id !== 'string') throw new Error(`missing entity ID in ${name}`);
      if (globalIds.has(entity.id)) throw new Error(`duplicate entity ID: ${entity.id}`);
      globalIds.add(entity.id); collectionIds.add(entity.id);
    }
    ids.set(name, collectionIds);
  }
  const check = (id: unknown, target: string): void => {
    if (typeof id !== 'string' || !ids.get(target)?.has(id)) throw new Error(`unresolved RPG reference ${String(id)} in ${target}`);
  };
  for (const [source, path, target] of REFERENCES) {
    for (const entity of all[source] ?? []) {
      for (const id of valuesAt(entity, path.split('.'))) check(id, target);
    }
  }
  const requirements = [
    ...world.areas.flatMap((area) => [area.completion?.required, area.revealedBy]),
    ...world.locations.flatMap((location) => location.exits.map((exit) => exit.requires)),
    ...world.routes.map((route) => route.requires),
  ];
  for (const requirement of requirements) {
    if (requirement === undefined) continue;
    walkRequirement(requirement, (node) => {
      if (isGameRequirement(node)) {
        if (node.game === 'defeated') check(node['enemy'], 'enemies');
      } else if ('hasItem' in node) check(node.hasItem.item, 'items');
    });
  }
}
