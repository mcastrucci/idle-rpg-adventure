/**
 * Per-actor world progress (world-model §4) as plain, read-only data. The server builds it from `area_progress`,
 * `world_flags` and economy balances; tests build it with {@link createActorWorldState}.
 */
import type { AreaId, LocationId } from './schemas.ts';

export interface ActorWorldState {
  /** Discovered locations, per area. */
  readonly discovered: ReadonlyMap<AreaId, ReadonlySet<LocationId>>;
  /** Areas whose completion has been recorded (`completed_at` is permanent). */
  readonly completedAreas: ReadonlySet<AreaId>;
  /** Areas the actor has entered at least once (besides those with discoveries). */
  readonly visitedAreas: ReadonlySet<AreaId>;
  /** Actor/world flags set by story events. */
  readonly flags: ReadonlySet<string>;
  /** Opaque objective keys recorded by the game through `recordObjective(actor, key)`. */
  readonly objectives: ReadonlySet<string>;
  /** Quantity the actor holds of an item (backed by economy balances). */
  itemQty(item: string): number;
}

/**
 * Evaluation context for requirements. `game` carries whatever extra state the game's predicates need (e.g. a level);
 * engine predicates only read `actor`.
 */
export interface EvalContext<G = unknown> {
  readonly actor: ActorWorldState;
  readonly game: G;
}

/** Plain-JSON form of {@link ActorWorldState}, convenient for tests, fixtures and DB row mapping. */
export interface ActorWorldStateInit {
  readonly discovered?: Readonly<Record<AreaId, readonly LocationId[]>>;
  readonly completedAreas?: readonly AreaId[];
  readonly visitedAreas?: readonly AreaId[];
  readonly flags?: readonly string[];
  readonly objectives?: readonly string[];
  readonly items?: Readonly<Record<string, number>>;
}

export function createActorWorldState(init: ActorWorldStateInit = {}): ActorWorldState {
  const discovered = new Map<AreaId, ReadonlySet<LocationId>>();
  for (const [area, locations] of Object.entries(init.discovered ?? {}) as [AreaId, readonly LocationId[]][]) {
    discovered.set(area, new Set(locations));
  }
  const items = new Map(Object.entries(init.items ?? {}));
  return {
    discovered,
    completedAreas: new Set(init.completedAreas ?? []),
    visitedAreas: new Set(init.visitedAreas ?? []),
    flags: new Set(init.flags ?? []),
    objectives: new Set(init.objectives ?? []),
    itemQty: (item) => items.get(item) ?? 0,
  };
}

/** Discovered locations of one area (empty set if none). */
export function discoveredIn(actor: ActorWorldState, area: AreaId): ReadonlySet<LocationId> {
  return actor.discovered.get(area) ?? EMPTY;
}

/** Whether the actor discovered a location in any area. */
export function hasDiscovered(actor: ActorWorldState, location: LocationId): boolean {
  for (const set of actor.discovered.values()) {
    if (set.has(location)) return true;
  }
  return false;
}

/** An area counts as visited if marked so, if it has discoveries, or if it was completed. */
export function hasVisited(actor: ActorWorldState, area: AreaId): boolean {
  return actor.visitedAreas.has(area) || discoveredIn(actor, area).size > 0 || actor.completedAreas.has(area);
}

const EMPTY: ReadonlySet<LocationId> = new Set();
