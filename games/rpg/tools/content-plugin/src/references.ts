/**
 * Cross-document references of RPG content, resolved by the content compiler (`ref.unknown` when the target is
 * missing). Intra-document references (an enemy's AI/rotation/telegraph skills being in its own `skills`) are checked by
 * the `@rpg/rpg-schema` schemas; this list makes sure every referenced ID exists in its collection.
 */
import { referencesAt, type CompiledContent, type JsonPath, type ReferenceCheck } from '@engine/content-compiler';
import { isGameRequirement, walkRequirement, type Requirement } from '@engine/world';

export function rpgReferences(content: CompiledContent): ReferenceCheck[] {
  return [
    // Tables.
    ...referencesAt(content, 'lootTables', 'entries.*.item', 'items'),
    ...referencesAt(content, 'lootTables', 'guaranteed.*.item', 'items'),
    ...referencesAt(content, 'merchants', 'offers.*.item', 'items'),
    ...referencesAt(content, 'merchants', 'offers.*.requiresCompletedArea', 'areas'),
    ...referencesAt(content, 'encounterTables', 'entries.*.enemies.*.enemy', 'enemies'),

    // Enemies: skill list (AI rules, rotations and telegraphs are a subset of it, checked by the schema), the AI's
    // `skillReady` condition (not covered by the schema subset check), loot.
    ...referencesAt(content, 'enemies', 'skills.*', 'skills'),
    ...referencesAt(content, 'enemies', 'ai.*.when.skillReady', 'skills'),
    ...referencesAt(content, 'enemies', 'lootTable', 'lootTables'),

    // Idle activities.
    ...referencesAt(content, 'idleActivities', 'encounterTable', 'encounterTables'),
    ...referencesAt(content, 'idleActivities', 'resourceYields.*.node', 'resourceNodes'),
    ...referencesAt(content, 'idleActivities', 'resourceYields.*.lootTable', 'lootTables'),

    // World extensions.
    ...referencesAt(content, 'areas', 'activities.*', 'idleActivities'),
    ...referencesAt(content, 'locations', 'encounters', 'encounterTables'),
    ...referencesAt(content, 'locations', 'resources.*.node', 'resourceNodes'),
    ...referencesAt(content, 'locations', 'resources.*.lootTable', 'lootTables'),

    // Requirements anywhere in the world (completion, reveal, exits, routes).
    ...requirementReferences(content),
  ];
}

/** Requirement trees of every world entity, with their path relative to the entity. */
function* worldRequirements(content: CompiledContent): Generator<[collection: string, id: string, req: Requirement, path: JsonPath]> {
  for (const area of content.world.areas) {
    if (area.completion?.required) yield ['areas', area.id, area.completion.required, ['completion', 'required']];
    if (area.revealedBy) yield ['areas', area.id, area.revealedBy, ['revealedBy']];
  }
  for (const location of content.world.locations) {
    for (const [i, exit] of location.exits.entries()) {
      if (exit.requires) yield ['locations', location.id, exit.requires, ['exits', i, 'requires']];
    }
  }
  for (const route of content.world.routes) {
    if (route.requires) yield ['routes', route.id, route.requires, ['requires']];
  }
}

/**
 * Game references inside requirements: `{ "game": "defeated", "enemy" }` → enemies, `{ "hasItem": { "item" } }` → items
 * (the engine validates predicate arguments and world references, not game/economy IDs).
 */
export function requirementReferences(content: CompiledContent): ReferenceCheck[] {
  const found: ReferenceCheck[] = [];
  for (const [collection, from, req, base] of worldRequirements(content)) {
    walkRequirement(req, (node, rel) => {
      if (isGameRequirement(node)) {
        if (node.game === 'defeated') found.push({ collection, from, path: [...base, ...rel, 'enemy'], id: node['enemy'], to: 'enemies' });
      } else if ('hasItem' in node) {
        found.push({ collection, from, path: [...base, ...rel, 'hasItem', 'item'], id: node.hasItem.item, to: 'items' });
      }
    });
  }
  return found;
}

/** Enemy IDs required by `defeated` predicates in an area's completion rule (with their path in the area). */
export function completionDefeatedEnemies(content: CompiledContent): { area: string; enemy: unknown; path: JsonPath }[] {
  const found: { area: string; enemy: unknown; path: JsonPath }[] = [];
  for (const area of content.world.areas) {
    const required = area.completion?.required;
    if (!required) continue;
    walkRequirement(required, (node, rel) => {
      if (isGameRequirement(node) && node.game === 'defeated') {
        found.push({ area: area.id, enemy: node['enemy'], path: ['completion', 'required', ...rel, 'enemy'] });
      }
    });
  }
  return found;
}
