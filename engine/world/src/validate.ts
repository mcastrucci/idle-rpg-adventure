/**
 * Pure graph validation of a world (world-model §7), used by the content compiler. Returns every problem found as a
 * structured error; never throws on bad content.
 *
 * Not covered (future work): satisfiability of requirements (e.g. a route requiring the completion of an area that is
 * only reachable through that route), item/flag reference checks (owned by the game/economy content), and diffing a
 * frozen baseline against the previously *published* pool (needs the previous build; here we only check internal
 * consistency and that the pool did not shrink).
 */
import { completionBaseline, poolLocations, requiredCountFor } from './completion.ts';
import type { PredicateRegistry } from './registry.ts';
import { gameArgs, walkRequirement } from './requirements.ts';
import {
  isGameRequirement,
  SECRET_TAG,
  WorldSchema,
  type AreaId,
  type Location,
  type LocationId,
  type Requirement,
  type World,
} from './schemas.ts';

export type ValidationCode =
  | 'schema.invalid'
  | 'id.duplicate'
  | 'ref.unknownArea'
  | 'ref.unknownLocation'
  | 'world.noHub'
  | 'area.missingStartLocation'
  | 'area.startLocationOutsideArea'
  | 'area.locationUnreachable'
  | 'area.unreachableFromHub'
  | 'location.unassigned'
  | 'location.multipleAreas'
  | 'exit.crossArea'
  | 'completion.infeasible'
  | 'completion.frozenInconsistent'
  | 'completion.poolShrunk'
  | 'requirement.unknownPredicate'
  | 'requirement.invalidArgs';

export interface ValidationError {
  readonly code: ValidationCode;
  /** Path inside the world document, e.g. `['areas', 1, 'completion', 'frozen']`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type WorldValidationResult =
  | { readonly ok: true; readonly world: World; readonly errors: readonly [] }
  | { readonly ok: false; readonly world?: World; readonly errors: readonly ValidationError[] };

/** Parses `input` with {@link WorldSchema} and, if it parses, runs {@link validateWorldGraph}. */
export function validateWorld<G>(input: unknown, registry: PredicateRegistry<G>): WorldValidationResult {
  const parsed = WorldSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema.invalid',
        path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: issue.message,
      })),
    };
  }
  const errors = validateWorldGraph(parsed.data, registry);
  return errors.length === 0 ? { ok: true, world: parsed.data, errors: [] } : { ok: false, world: parsed.data, errors };
}

/** Runs every graph check on an already parsed world. */
export function validateWorldGraph<G>(world: World, registry: PredicateRegistry<G>): ValidationError[] {
  const errors: ValidationError[] = [];
  const report = (code: ValidationCode, path: readonly (string | number)[], message: string): void => {
    errors.push({ code, path, message });
  };

  // Duplicate IDs (per collection; exit IDs are global).
  checkDuplicates(world.areas.map((a, i) => [a.id, ['areas', i, 'id']]), report);
  checkDuplicates(world.locations.map((l, i) => [l.id, ['locations', i, 'id']]), report);
  checkDuplicates(world.routes.map((r, i) => [r.id, ['routes', i, 'id']]), report);
  checkDuplicates(
    world.locations.flatMap((l, i) => l.exits.map((e, j) => [e.id, ['locations', i, 'exits', j, 'id']] as const)),
    report,
  );

  const areaIds = new Set<AreaId>(world.areas.map((a) => a.id));
  const locationById = new Map<LocationId, Location>(world.locations.map((l) => [l.id, l]));
  const locationIndex = new Map<LocationId, number>(world.locations.map((l, i) => [l.id, i]));

  // Location ownership.
  const ownerOf = new Map<LocationId, AreaId>();
  world.areas.forEach((area, i) => {
    checkDuplicates(area.locations.map((id, j) => [id, ['areas', i, 'locations', j]]), report);
    area.locations.forEach((id, j) => {
      if (!locationById.has(id)) {
        report('ref.unknownLocation', ['areas', i, 'locations', j], `Unknown location "${id}"`);
        return;
      }
      const owner = ownerOf.get(id);
      if (owner !== undefined && owner !== area.id) {
        report('location.multipleAreas', ['areas', i, 'locations', j], `Location "${id}" already belongs to "${owner}"`);
      } else {
        ownerOf.set(id, area.id);
      }
    });
  });
  world.locations.forEach((loc, i) => {
    if (!ownerOf.has(loc.id)) report('location.unassigned', ['locations', i, 'id'], `Location "${loc.id}" is in no area`);
  });

  // Exits.
  world.locations.forEach((loc, i) => {
    loc.exits.forEach((exit, j) => {
      const path = ['locations', i, 'exits', j];
      if (!locationById.has(exit.to)) {
        report('ref.unknownLocation', [...path, 'to'], `Exit "${exit.id}" targets unknown location "${exit.to}"`);
      } else if (ownerOf.get(exit.to) !== ownerOf.get(loc.id)) {
        report('exit.crossArea', [...path, 'to'], `Exit "${exit.id}" leaves its area; use a route between areas`);
      }
      if (exit.requires) checkRequirement(exit.requires, [...path, 'requires']);
    });
  });

  // Routes.
  world.routes.forEach((route, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!areaIds.has(route[end])) report('ref.unknownArea', ['routes', i, end], `Unknown area "${route[end]}"`);
    }
    if (route.requires) checkRequirement(route.requires, ['routes', i, 'requires']);
  });

  // Hub reachability (ignoring requirements).
  const hubs = world.areas.filter((a) => a.kind === 'hub').map((a) => a.id);
  if (hubs.length === 0) {
    report('world.noHub', ['areas'], 'The world has no hub area');
  } else {
    const reached = bfs(hubs, (id) => world.routes.filter((r) => r.from === id).map((r) => r.to));
    world.areas.forEach((area, i) => {
      if (area.kind !== 'hub' && !reached.has(area.id)) {
        report('area.unreachableFromHub', ['areas', i, 'id'], `Area "${area.id}" cannot be reached from any hub`);
      }
    });
  }

  // Per-area graph and completion.
  world.areas.forEach((area, i) => {
    const areaPath = ['areas', i];
    if (area.revealedBy) checkRequirement(area.revealedBy, [...areaPath, 'revealedBy']);
    if (area.completion?.required) checkRequirement(area.completion.required, [...areaPath, 'completion', 'required']);

    const start = area.startLocation;
    const own = (id: LocationId): boolean => ownerOf.get(id) === area.id;
    if (start === undefined) {
      if (area.locations.length > 0) {
        report('area.missingStartLocation', [...areaPath, 'startLocation'], `Area "${area.id}" has locations but no start`);
      }
    } else if (!locationById.has(start)) {
      report('ref.unknownLocation', [...areaPath, 'startLocation'], `Unknown start location "${start}"`);
    } else if (!own(start)) {
      report('area.startLocationOutsideArea', [...areaPath, 'startLocation'], `"${start}" is not in "${area.id}"`);
    }
    const startOk = start !== undefined && own(start);

    const neighbours = (secretAllowed: boolean) => (id: LocationId) =>
      (locationById.get(id)?.exits ?? [])
        .filter((e) => own(e.to) && (secretAllowed || !e.tags.includes(SECRET_TAG)))
        .map((e) => e.to);

    if (startOk) {
      const reached = bfs([start], neighbours(true));
      for (const id of area.locations) {
        if (own(id) && !reached.has(id)) {
          report('area.locationUnreachable', ['locations', locationIndex.get(id) ?? -1, 'id'], `"${id}" is unreachable from "${start}"`);
        }
      }
    }

    const rule = area.completion;
    if (!rule) return;
    const completionPath = [...areaPath, 'completion'];
    const pool = poolLocations(area, rule, world.locations);
    if (rule.frozen) {
      const expected = requiredCountFor(rule.frozen.poolSize, rule.thresholdBp);
      if (rule.frozen.requiredCount !== expected) {
        report(
          'completion.frozenInconsistent',
          [...completionPath, 'frozen', 'requiredCount'],
          `Frozen requiredCount ${rule.frozen.requiredCount} ≠ ceil(${rule.frozen.poolSize} × ${rule.thresholdBp} / 10000) = ${expected}`,
        );
      }
      if (pool.length < rule.frozen.poolSize) {
        report(
          'completion.poolShrunk',
          [...completionPath, 'frozen', 'poolSize'],
          `Pool has ${pool.length} locations, fewer than the frozen ${rule.frozen.poolSize}`,
        );
      }
    }
    const { requiredCount } = completionBaseline(rule, pool.length);
    const reachableWithoutSecrets = startOk ? bfs([start], neighbours(false)) : new Set<LocationId>();
    const feasible = pool.filter((id) => reachableWithoutSecrets.has(id)).length;
    if (feasible < requiredCount) {
      report(
        'completion.infeasible',
        completionPath,
        `Only ${feasible} pool locations are reachable without secret exits; ${requiredCount} required`,
      );
    }
  });

  return errors;

  function checkRequirement(req: Requirement, basePath: readonly (string | number)[]): void {
    walkRequirement(req, (node, rel) => {
      const path = [...basePath, ...rel];
      if (isGameRequirement(node)) {
        const { name, args } = gameArgs(node);
        if (!registry.has(name)) {
          report('requirement.unknownPredicate', [...path, 'game'], `Unknown game predicate "${name}"`);
          return;
        }
        const result = registry.validateArgs(name, args);
        if (!result.ok) {
          const detail = result.issues.map((issue) => `${issue.path.map(String).join('.') || '(args)'}: ${issue.message}`);
          report('requirement.invalidArgs', path, `Invalid arguments for "${name}": ${detail.join('; ')}`);
        }
      } else if ('discovered' in node && !locationById.has(node.discovered)) {
        report('ref.unknownLocation', [...path, 'discovered'], `Unknown location "${node.discovered}"`);
      } else if ('areaCompleted' in node && !areaIds.has(node.areaCompleted)) {
        report('ref.unknownArea', [...path, 'areaCompleted'], `Unknown area "${node.areaCompleted}"`);
      }
    });
  }
}

function checkDuplicates(
  entries: readonly (readonly [string, readonly (string | number)[]])[],
  report: (code: ValidationCode, path: readonly (string | number)[], message: string) => void,
): void {
  const seen = new Set<string>();
  for (const [id, path] of entries) {
    if (seen.has(id)) report('id.duplicate', path, `Duplicate ID "${id}"`);
    seen.add(id);
  }
}

function bfs<T>(roots: readonly T[], next: (node: T) => readonly T[]): Set<T> {
  const reached = new Set<T>(roots);
  const queue = [...roots];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const n of next(current)) {
      if (!reached.has(n)) {
        reached.add(n);
        queue.push(n);
      }
    }
  }
  return reached;
}
