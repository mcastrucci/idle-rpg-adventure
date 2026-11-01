/**
 * Per-actor views of the world map and of an area (world-model §6, fog of war). Computed server-side; the client only
 * receives the result.
 */
import { discoveredIn, hasVisited, type EvalContext } from './actor.ts';
import { evaluateCompletion, type CompletionStatus } from './completion.ts';
import type { PredicateRegistry } from './registry.ts';
import { evaluateOptional } from './requirements.ts';
import {
  SECRET_TAG,
  type Area,
  type AreaId,
  type AreaKind,
  type Location,
  type LocationId,
  type RouteId,
  type World,
} from './schemas.ts';

export type AreaVisibility = 'known' | 'locked' | 'hidden';

/** Reason used when a known area has no route at all from an area the actor can reach. */
export const NO_ROUTE_REASON = 'world.noRouteFromReachableArea';

export interface AreaMapView {
  readonly id: AreaId;
  readonly kind: AreaKind;
  readonly visibility: AreaVisibility;
  /** Why the area is locked (empty unless `visibility === 'locked'`). */
  readonly reasons: readonly string[];
  readonly completion: CompletionStatus;
}

export interface RouteView {
  readonly id: RouteId;
  readonly from: AreaId;
  readonly to: AreaId;
  /** Both ends are not hidden: the client may draw this route. */
  readonly visible: boolean;
  /** The route's own requirement holds. */
  readonly unlocked: boolean;
  readonly reasons: readonly string[];
}

export interface WorldView {
  readonly areas: readonly AreaMapView[];
  readonly routes: readonly RouteView[];
}

/**
 * Computes world-map visibility for the actor in `ctx`:
 *
 * - **reachable** areas: hubs, plus every area reached from a reachable area through an unlocked route;
 * - **base** areas: hubs and areas the actor visited;
 * - an area is *seen* if it is a base area, the target of a route leaving a base area (one hop, not transitive), or
 *   its `revealedBy` requirement holds;
 * - seen + reachable → `known`; seen but not reachable → `locked` (with reasons); otherwise `hidden`.
 */
export function computeWorldView<G>(world: World, ctx: EvalContext<G>, registry: PredicateRegistry<G>): WorldView {
  const routeStates = world.routes.map((route) => ({
    route,
    result: evaluateOptional(route.requires, ctx, registry),
  }));

  // Reachability from hubs through unlocked routes.
  const reachable = new Set<AreaId>(world.areas.filter((a) => a.kind === 'hub').map((a) => a.id));
  const queue = [...reachable];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const { route, result } of routeStates) {
      if (route.from === current && result.ok && !reachable.has(route.to)) {
        reachable.add(route.to);
        queue.push(route.to);
      }
    }
  }

  const base = new Set<AreaId>(
    world.areas.filter((a) => a.kind === 'hub' || hasVisited(ctx.actor, a.id)).map((a) => a.id),
  );
  const seen = new Set<AreaId>(base);
  for (const { route } of routeStates) {
    if (base.has(route.from)) seen.add(route.to);
  }
  for (const area of world.areas) {
    if (area.revealedBy && evaluateOptional(area.revealedBy, ctx, registry).ok) seen.add(area.id);
  }

  const areas = world.areas.map((area): AreaMapView => {
    const completion = evaluateCompletion(area, world.locations, ctx, registry);
    const common = { id: area.id, kind: area.kind, completion };
    if (!seen.has(area.id)) return { ...common, visibility: 'hidden', reasons: [] };
    if (reachable.has(area.id)) return { ...common, visibility: 'known', reasons: [] };
    const reasons = routeStates
      .filter(({ route }) => route.to === area.id && reachable.has(route.from))
      .flatMap(({ result }) => result.reasons);
    return { ...common, visibility: 'locked', reasons: reasons.length > 0 ? [...new Set(reasons)] : [NO_ROUTE_REASON] };
  });

  const hidden = new Set(areas.filter((a) => a.visibility === 'hidden').map((a) => a.id));
  const routes = routeStates.map(
    ({ route, result }): RouteView => ({
      id: route.id,
      from: route.from,
      to: route.to,
      visible: !hidden.has(route.from) && !hidden.has(route.to),
      unlocked: result.ok,
      reasons: result.reasons,
    }),
  );
  return { areas, routes };
}

export interface LocationView {
  readonly id: LocationId;
  readonly tags: readonly string[];
  readonly isStart: boolean;
}

export interface ExitView {
  readonly id: string;
  readonly from: LocationId;
  readonly unlocked: boolean;
  readonly reasons: readonly string[];
  readonly tags: readonly string[];
}

export interface KnownExitView extends ExitView {
  readonly to: LocationId;
}

export interface AreaView {
  readonly areaId: AreaId;
  /** Discovered locations, in area order. */
  readonly locations: readonly LocationView[];
  /** Exits between discovered locations. */
  readonly exits: readonly KnownExitView[];
  /** Exits from discovered locations to undiscovered ones; the target is withheld. Secret exits are omitted. */
  readonly unknownExits: readonly ExitView[];
  readonly completion: CompletionStatus;
}

/** Computes what the actor knows about one area's location graph. */
export function computeAreaView<G>(
  area: Area,
  locations: readonly Location[],
  ctx: EvalContext<G>,
  registry: PredicateRegistry<G>,
): AreaView {
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const discovered = discoveredIn(ctx.actor, area.id);
  const visible = area.locations
    .filter((id) => discovered.has(id))
    .map((id) => byId.get(id))
    .filter((loc): loc is Location => loc !== undefined);

  const exits: KnownExitView[] = [];
  const unknownExits: ExitView[] = [];
  for (const loc of visible) {
    for (const exit of loc.exits) {
      const result = evaluateOptional(exit.requires, ctx, registry);
      const view: ExitView = { id: exit.id, from: loc.id, unlocked: result.ok, reasons: result.reasons, tags: exit.tags };
      if (discovered.has(exit.to)) exits.push({ ...view, to: exit.to });
      else if (!exit.tags.includes(SECRET_TAG)) unknownExits.push(view);
    }
  }

  return {
    areaId: area.id,
    locations: visible.map((loc) => ({ id: loc.id, tags: loc.tags, isStart: loc.id === area.startLocation })),
    exits,
    unknownExits,
    completion: evaluateCompletion(area, locations, ctx, registry),
  };
}
