# @engine/world

Game-agnostic world graph (ADR-0018, [`docs/engine/world-model.md`](../../docs/engine/world-model.md)): a **world map**
of areas (`hub`, `explorable` or game-defined kinds) linked by **routes**, each area being a graph of **locations**
linked by **exits**. Everything here is pure and synchronous; no DB, no I/O, no RNG.

## API

| Module | Exports |
|---|---|
| `schemas.ts` | Zod schemas + types: `WorldSchema`, `AreaSchema`, `LocationSchema`, `ExitSchema`, `RouteSchema`, `TravelSchema`, `CompletionRuleSchema`, `RequirementSchema`; ID schemas (`area:`, `loc:`, `route:`, generic `ns:name`). Entities are loose (games add fields); engine structures are strict. |
| `actor.ts` | `ActorWorldState` (discovered per area, completed/visited areas, flags, objectives, `itemQty`), `EvalContext<G>` (`{ actor, game }`), `createActorWorldState(init)`. |
| `registry.ts` | `PredicateRegistry<G>`: `register(name, { args: zodSchema, evaluate(args, ctx), reason?(args) })`. |
| `requirements.ts` | `evaluateRequirement(req, ctx, registry) → { ok, reasons }`, `describeRequirement`, `walkRequirement`. |
| `completion.ts` | `evaluateCompletion(area, locations, ctx, registry)`, `requiredCountFor(poolSize, bp)` (integer ceil). |
| `view.ts` | `computeWorldView(world, ctx, registry)`, `computeAreaView(area, locations, ctx, registry)`. |
| `validate.ts` | `validateWorld(input, registry)` (schema + graph), `validateWorldGraph(world, registry)` → `ValidationError[]` (`{ code, path, message }`). |
| `mermaid.ts` | `worldToMermaid(world)`, `areaToMermaid(area, locations)`. |

## Requirements

Closed union: `all`, `any`, `not`, `discovered`, `areaCompleted`, `flag`, `hasItem`, and `{ game: '<name>', ...args }`
for predicates registered by the game. Unknown game predicates are a validation error and fail closed at runtime.
Failure reasons are stable keys: `requires.discovered:<loc>`, `requires.areaCompleted:<area>`, `requires.flag:<flag>`,
`requires.hasItem:<item>:<qty>`, `requires.not:<description>`, `requires.game.<name>` (or the predicate's own
`reason`), `requires.unknownPredicate:<name>`, `requires.invalidArgs:<name>`. `any` returns the reasons of every branch.

## Completion

`completed = recorded || (|discovered ∩ pool| ≥ requiredCount && required holds)`. The pool is the area's locations
tagged `pool.tag`. With a `frozen` baseline, `poolSize`/`requiredCount` come from it; otherwise
`requiredCount = ceil(poolSize × thresholdBp / 10000)`.

## Visibility (world map)

- **reachable**: hubs, plus areas reached from a reachable area through routes whose requirement holds;
- **base**: hubs and areas the actor visited (marked visited, has discoveries, or completed);
- an area is **seen** if it is a base area, the target of a route leaving a base area (one hop, not transitive), or its
  optional `revealedBy` requirement holds (e.g. a story flag);
- seen + reachable → `known`; seen only → `locked` with the reasons of the failing routes from reachable areas (or
  `world.noRouteFromReachableArea`); otherwise `hidden`.

Routes are `visible` when neither end is hidden. In an area view, exits from discovered locations to undiscovered ones
are listed as **unknown exits** (target withheld); `secret`-tagged exits are omitted until their target is discovered.

## Validation codes

`schema.invalid`, `id.duplicate`, `ref.unknownArea`, `ref.unknownLocation`, `world.noHub`, `area.missingStartLocation`,
`area.startLocationOutsideArea`, `area.locationUnreachable` (from `startLocation`, ignoring requirements),
`area.unreachableFromHub` (via routes, ignoring requirements), `location.unassigned`, `location.multipleAreas`,
`exit.crossArea`, `completion.infeasible` (pool reachable without `secret` exits < requiredCount),
`completion.frozenInconsistent`, `completion.poolShrunk`, `requirement.unknownPredicate`, `requirement.invalidArgs`.

**Future work:** requirement satisfiability (e.g. a route gated by completing an area only reachable through it),
item/flag reference checks, and comparing frozen baselines against the previously published build.
