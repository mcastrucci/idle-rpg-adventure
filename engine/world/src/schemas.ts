/**
 * Zod schemas and types for the engine world graph (docs/engine/world-model.md, ADR-0018).
 *
 * Entities (world, area, location, exit, route) are *loose* objects: games extend them with their own namespaced fields
 * through the content compiler's schema registry and the engine ignores what it does not know. Engine-owned structures
 * (requirements, completion rules, travel) are *strict* so typos fail loudly.
 */
import { BP_SCALE } from '@engine/sim-core';
import { z } from 'zod';

/** Generic namespaced ID: `<namespace>:<name>`, e.g. `area:north`, `loc:north.old_well`. */
export const NAMESPACED_ID_PATTERN = /^[a-z]+:[a-z0-9_.]+$/;

/** A namespaced ID with any namespace. */
export const IdSchema = z.string().regex(NAMESPACED_ID_PATTERN, 'must be a namespaced ID like "ns:name"');

/** A namespaced ID whose namespace is fixed (`area`, `loc`, `route`). */
function idInNamespace<N extends string>(namespace: N) {
  return z
    .string()
    .regex(new RegExp(`^${namespace}:[a-z0-9_.]+$`), `must be a namespaced ID like "${namespace}:name"`)
    .transform((value) => value as `${N}:${string}`);
}

export const AreaIdSchema = idInNamespace('area');
export const LocationIdSchema = idInNamespace('loc');
export const RouteIdSchema = idInNamespace('route');

export type AreaId = `area:${string}`;
export type LocationId = `loc:${string}`;
export type RouteId = `route:${string}`;

/** Name of a game-registered predicate (`defeated`, `hasTool`…). */
export const GAME_PREDICATE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

/** Free-form tag (`ordinary`, `secret`…). */
export const TagSchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/, 'must be a lowercase tag');

// ---------------------------------------------------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------------------------------------------------

export interface AllRequirement {
  readonly all: readonly Requirement[];
}
export interface AnyRequirement {
  readonly any: readonly Requirement[];
}
export interface NotRequirement {
  readonly not: Requirement;
}
export interface DiscoveredRequirement {
  readonly discovered: LocationId;
}
export interface AreaCompletedRequirement {
  readonly areaCompleted: AreaId;
}
export interface FlagRequirement {
  readonly flag: string;
}
export interface HasItemRequirement {
  readonly hasItem: { readonly item: string; readonly qty: number };
}
/** A predicate registered by the game; every key except `game` is an argument validated by the registry. */
export interface GameRequirement {
  readonly game: string;
  readonly [arg: string]: unknown;
}

/** Closed, composable requirement predicate (ADR-0018 §Decision, world-model §3). */
export type Requirement =
  | AllRequirement
  | AnyRequirement
  | NotRequirement
  | DiscoveredRequirement
  | AreaCompletedRequirement
  | FlagRequirement
  | HasItemRequirement
  | GameRequirement;

export const RequirementSchema: z.ZodType<Requirement> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(RequirementSchema).min(1) }),
    z.strictObject({ any: z.array(RequirementSchema).min(1) }),
    z.strictObject({ not: RequirementSchema }),
    z.strictObject({ discovered: LocationIdSchema }),
    z.strictObject({ areaCompleted: AreaIdSchema }),
    z.strictObject({ flag: z.string().min(1) }),
    z.strictObject({ hasItem: z.strictObject({ item: IdSchema, qty: z.int().positive() }) }),
    z.looseObject({ game: z.string().regex(GAME_PREDICATE_NAME_PATTERN, 'invalid game predicate name') }),
  ]),
);

/** Type guard for game predicates (needed because their index signature defeats `in` narrowing). */
export function isGameRequirement(req: Requirement): req is GameRequirement {
  return typeof (req as { game?: unknown }).game === 'string';
}

// ---------------------------------------------------------------------------------------------------------------------
// Area graph: locations and exits
// ---------------------------------------------------------------------------------------------------------------------

/** Tag of exits that do not count for completion feasibility and are not shown as "unknown exits". */
export const SECRET_TAG = 'secret';

export const ExitSchema = z.looseObject({
  id: IdSchema,
  to: LocationIdSchema,
  requires: RequirementSchema.optional(),
  tags: z.array(TagSchema).default([]),
});
export type Exit = z.output<typeof ExitSchema>;

export const LocationSchema = z.looseObject({
  id: LocationIdSchema,
  tags: z.array(TagSchema).default([]),
  exits: z.array(ExitSchema).default([]),
});
export type Location = z.output<typeof LocationSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------------------------------------------------

/** Basis-point scale, owned by `@engine/sim-core` and re-exported here (same binding, so `export *` from both is fine). */
export { BP_SCALE } from '@engine/sim-core';

export const CompletionRuleSchema = z.strictObject({
  /** Locations of the area carrying this tag form the completion pool. */
  pool: z.strictObject({ tag: TagSchema }),
  /** Share of the pool that must be discovered, in basis points (7000 = 70%). */
  thresholdBp: z.int().min(0).max(BP_SCALE),
  /** Extra objectives (e.g. a game predicate) that must also hold. */
  required: RequirementSchema.optional(),
  /** Baseline frozen at publish time; when present it overrides the live pool size. */
  frozen: z
    .strictObject({
      poolSize: z.int().min(0),
      requiredCount: z.int().min(0),
      at: z.iso.date(),
    })
    .optional(),
});
export type CompletionRule = z.output<typeof CompletionRuleSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// World map: areas and routes
// ---------------------------------------------------------------------------------------------------------------------

/** Engine area kinds; games may add their own lowercase kinds. */
export type AreaKind = 'hub' | 'explorable' | (string & {});
export const AreaKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'area kind must be a lowercase identifier')
  .transform((value) => value as AreaKind);

export const AreaSchema = z.looseObject({
  id: AreaIdSchema,
  kind: AreaKindSchema,
  /** IDs of the locations forming this area's graph. */
  locations: z.array(LocationIdSchema).default([]),
  /** Entry point of the area graph; required when the area has locations. */
  startLocation: LocationIdSchema.optional(),
  completion: CompletionRuleSchema.optional(),
  /** Game activity IDs unlocked here (by default after completion). */
  activities: z.array(IdSchema).optional(),
  /** Makes the area *known* on the world map when it holds, even if not adjacent to a hub/visited area. */
  revealedBy: RequirementSchema.optional(),
  mapPosition: z.strictObject({ x: z.int(), y: z.int() }).optional(),
  tags: z.array(TagSchema).default([]),
});
export type Area = z.output<typeof AreaSchema>;

export const TravelSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('instant') }),
  z.strictObject({ mode: z.literal('timed'), durationMin: z.int().positive() }),
]);
export type Travel = z.output<typeof TravelSchema>;

export const RouteSchema = z.looseObject({
  id: RouteIdSchema,
  from: AreaIdSchema,
  to: AreaIdSchema,
  requires: RequirementSchema.optional(),
  travel: TravelSchema,
});
export type Route = z.output<typeof RouteSchema>;

export const WorldSchema = z.looseObject({
  areas: z.array(AreaSchema).min(1),
  routes: z.array(RouteSchema).default([]),
  locations: z.array(LocationSchema).default([]),
});
export type World = z.output<typeof WorldSchema>;
export type WorldInput = z.input<typeof WorldSchema>;
