/**
 * Read-only index of the content the live exploration plugin needs: explorable areas, RPG locations (exits, hotspots,
 * resource nodes, encounter table) and the RPG requirement predicates. Built once per plugin from the verified bundle.
 */
import { validateWorld } from '@engine/world';
import type { PredicateRegistry } from '@engine/world';
import { createRpgPredicateRegistry, RpgLocationSchema } from '@rpg/rpg-schema';
import type { Hotspot, RpgGameContext, RpgLocation } from '@rpg/rpg-schema';

export interface LiveResourceNode {
  /** Instance-local node ID: `<resource id>#<ordinal among the same resource in this location>`, e.g. `res:glowcap#1`. */
  readonly nodeId: string;
  readonly resource: string;
  readonly lootTable: string;
}

export interface LiveLocation {
  readonly id: string;
  readonly area: string;
  readonly tags: ReadonlySet<string>;
  readonly exits: RpgLocation['exits'];
  readonly hotspots: readonly Hotspot[];
  readonly resources: readonly LiveResourceNode[];
  readonly encounters: string | undefined;
}

export interface LiveArea {
  readonly id: string;
  readonly startLocation: string;
  readonly locations: readonly string[];
}

export interface LiveWorld {
  readonly areas: ReadonlyMap<string, LiveArea>;
  readonly locations: ReadonlyMap<string, LiveLocation>;
  readonly predicates: PredicateRegistry<RpgGameContext>;
}

/** Location tags with exploration rules (world-model tags authored in content). */
export const SAFE_TAG = 'safe';
export const BOSS_ROOM_TAG = 'boss_room';
export const SECRET_TAG = 'secret';

export function buildLiveWorld(world: unknown): LiveWorld {
  const predicates = createRpgPredicateRegistry();
  const result = validateWorld(world, predicates);
  if (!result.ok) throw new Error('RPG content world failed runtime validation');
  const areas = new Map<string, LiveArea>();
  const areaOf = new Map<string, string>();
  for (const area of result.world.areas) {
    if (area.kind !== 'explorable' || area.startLocation === undefined) continue;
    areas.set(area.id, { id: area.id, startLocation: area.startLocation, locations: [...area.locations] });
    for (const location of area.locations) areaOf.set(location, area.id);
  }
  const raw = (world as { locations?: unknown[] }).locations ?? [];
  const locations = new Map<string, LiveLocation>();
  for (const entry of raw) {
    const location = RpgLocationSchema.parse(entry);
    const area = areaOf.get(location.id);
    if (area === undefined) continue;
    const ordinals = new Map<string, number>();
    const resources = location.resources.map((resource) => {
      const ordinal = ordinals.get(resource.node) ?? 0;
      ordinals.set(resource.node, ordinal + 1);
      return { nodeId: `${resource.node}#${ordinal}`, resource: resource.node, lootTable: resource.lootTable };
    });
    locations.set(location.id, { id: location.id, area, tags: new Set(location.tags), exits: location.exits,
      hotspots: location.hotspots, resources, encounters: location.encounters });
  }
  return { areas, locations, predicates };
}
