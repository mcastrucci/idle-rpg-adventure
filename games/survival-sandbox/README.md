# @survival/sandbox

A toy survival game built **only** on `@engine/*` packages (ADR-0017, ADR-0019,
[`docs/engine/expedition-kernel.md`](../../docs/engine/expedition-kernel.md) §4). Its only purpose is to keep the engine
boundary honest: if it ever needs `@rpg/*` code, the engine is wrong (lint forbids the import). Tests/CLI only — no
art, no UI.

## What is here

| File | Purpose |
|---|---|
| `content/world.json` | Shelter hub (`area:shelter`), two districts (`area:old_market`, `area:rail_yard`), 5–6 locations each with `ordinary`/`secret` tags, completion rules (60% of `ordinary` + an objective), a timed route, a route gated by `any[hasTool bolt_cutters, flag]`, an exit gated by `hasTool crowbar`. |
| `content/scavenge.json` | Per-district find/threat tables, medkit and infection rules (integers only). |
| `src/world.ts` | `survivalRegistry()` (`hasTool` predicate over `SurvivalGameContext { tools }`, args parsed by a plain function — no Zod), `loadWorld()` via `validateWorld`. |
| `src/tables.ts` | Zod validation of the scavenging tables. |
| `src/scavenge.ts` | `survival.scavenge` `ExpeditionSimulator`; `survivalActivities()` maps the content activity `activity:scavenge` to it. |
| `src/cli.ts` | Runs one expedition and prints timeline, reveal, settlement and estimate. |

### `survival.scavenge`

- **Config** `{ district: AreaId, supplies: { food, water, medkits } }`, hand-validated by `parseConfig`. The
  duration (60/120/180 min) is kernel-owned: it comes with the start request and `canStart` rejects other values
  (`invalid_duration`); when started through `checkStart`, the request's area must equal `district`
  (`district_mismatch`). Supplies are what **each** participating group brings.
- **Start** — `checkStart` with `{ areaId, activityId: 'activity:scavenge', durationMin, paceBp }`: the engine gates
  the district on completion (per group) before `canStart` runs.
- **Escrow** — `escrow(config, actors)`: per group, each non-zero supply moves `storage → escrow`; hours consume from
  `escrow`; `settleWithEscrow` returns the rest to `storage` (cancel before the first hour returns everything).
- **Snapshot** (actor) — a survivor group `{ actorId, members, condition 0..100, carryCapacity }`.
- **Budget** — one segment (weight 1) per in-game hour: `⌊durationMin × paceBp / (60 × 10000)⌋`, at least 1.
- **Each hour**, per group in `actorId` order: consume one `item:ration` and one `item:water` per member (from
  `escrow`); ongoing infection damage; `members × searchesPerMember` find rolls (`finds` stream) stowed in the
  game-defined `pack` container up to `carryCapacity` (excess is left behind); one threat roll (`threats` stream:
  horde / collapse / infection) that lowers condition (infection keeps hurting each hour); an automatic medkit below
  condition 40 (heals 35, cures infection).
- **Outcomes** — `failed` when a group's condition reaches 0; `retreated` when a group cannot afford another hour of
  food/water before the budget ends; otherwise `completed`.
- **RNG** — each hour uses the kernel's `segmentStreams(seed, index)` (`deriveSeed(seed, 'segment', index)`), so resuming from `stateAfter` with
  the same seed reproduces the original suffix exactly (tested); party revisions re-roll with the revision seed.
- **Settle** — natural end of a `failed` run: consumption kept, finds aggregated per (actor, item) and
  `total − ⌊total/2⌋` kept. Every other case (`completed`/`retreated` outcomes, `cancelled`, `member_left`, partial
  cutoffs) is `defaultSettle`. Contract-checked with `{ completed: 'custom', cancelled: 'default', member_left:
  'default' }` (and in all-custom mode against the default bound).
- **Summarize** — `{ hours, outcome (whole timeline only), finds, leftBehind, threats, medkitsUsed, suppliesUsed,
  causeOfFailure }`.

## Commands

```sh
pnpm vitest run --project @survival/sandbox
pnpm --filter @survival/sandbox exec node src/cli.ts --district old_market --hours 3 --seed 42
# options: --district old_market|rail_yard --hours 1|2|3 --seed N --members N --condition 1..100 --carry N
#          --food N --water N --medkits N --pace BP --runs N --fresh 1 (district not completed: start refused)
```

The CLI runs on Node ≥ 22.18 with built-in type stripping (no build step, no extra dependency); workspace packages
resolve to their real paths outside `node_modules`, so their `.ts` sources are stripped too. The wall clock is
simulated (start at t = 0); no `Date` anywhere, so the package-wide determinism lint needs no exception.

## Boundary findings

Things the sandbox needed that the engine did not provide (or provided awkwardly). All were **resolved in the engine**
by issue #70 (`@engine/expedition-kernel` 0.2.0, `@engine/world` predicate args); the sandbox now uses the new APIs and
its workarounds are gone.

1. **Escrow had no owner in the simulator contract (unused supplies were never returned).** *Resolved:*
   `ExpeditionSimulator.escrow?(config, actors)` declares what moves into `escrow` at start; `settleWithEscrow`
   returns `escrowed − consumed` per (actor, asset) to the source container, for every cutoff including −1. The
   sandbox escrows supplies from `storage` and tests the returns at every cutoff.
2. **The kernel could not tell which area a config targets; activity IDs had no link to simulator IDs.**
   *Resolved:* start requests carry `{ areaId, activityId }`; `ActivityRegistry` maps content activity IDs (`ns:name`,
   here `activity:scavenge`) to simulators, whose IDs follow their own `SIMULATOR_ID_PATTERN` (`<game>.<name>`, here
   `survival.scavenge`); `checkStart` gates on completion per actor and passes `world`, `area`, eval contexts and the
   predicate registry to `canStart`. The sandbox cross-checks `district` against the requested area.
3. **`PredicateRegistry` forced a Zod dependency (and version lock).** *Resolved:* predicate `args` accept any
   Standard Schema (Zod included, so existing code is unchanged) or a plain parse function. `hasTool` now uses a parse
   function; the sandbox keeps `zod` only for its own scavenging tables.
4. **Contract checker: custom settlement lost the "no future deltas" guarantee.** *Resolved:* per-reason modes
   and, in custom mode, the default bound `net(settle) ≤ max(net(defaultSettle), 0)` per (actor, asset), plus escrow
   conservation. The sandbox's double run (custom + default on non-failing seeds) is replaced by one per-reason run.
5. **No timeline hash helper.** *Resolved:* `timelineHash(timeline)`; the golden test uses it.
6. **Per-segment RNG was undocumented.** *Resolved:* documented in the kernel README; `segmentSeed`/
   `segmentStreams` helpers, used by the sandbox (this changed every roll, so the golden hash was updated
   deliberately with simulator version 2.0.0).
7. **Duration lived in two places.** *Resolved:* duration is kernel-owned (start request → `budget`/`canStart`);
   `durationMin` was removed from the sandbox config (`duration_mismatch` is gone).
8. **Multi-actor inputs.** *Resolved:* documented (config per expedition; per-actor inputs via snapshots or
   `escrow(config, actors)`, one delta per actor and asset).
9. **Minor: `BP_SCALE` exported twice.** *Resolved:* `@engine/world` re-exports sim-core's binding.

What worked without friction: `validateWorld`, requirement/visibility/completion with a game predicate and typed
game context, game-defined area kinds (`district`) and containers (`pack`), `placeSegments`/`visibleView` (no early
failure leak across all fixtures), `estimate`, `checkSimulatorContract`, and the determinism lint (the CLI only
needs `process.argv`/`console`).

## Deviations

- Content is JSON inside the package, loaded with `validateWorld` / Zod directly: the content compiler is not
  integrated yet (ADR-0008's "run the compiler" step does not apply yet).
- Tool IDs are namespaced (`tool:bolt_cutters`), matching the engine/world survival fixture.
