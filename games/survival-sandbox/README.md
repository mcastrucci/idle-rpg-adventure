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
| `src/world.ts` | `survivalRegistry()` (`hasTool` predicate over `SurvivalGameContext { tools }`), `loadWorld()` via `validateWorld`. |
| `src/tables.ts` | Zod validation of the scavenging tables. |
| `src/scavenge.ts` | `survival.scavenge` `ExpeditionSimulator`. |
| `src/cli.ts` | Runs one expedition and prints timeline, reveal, settlement and estimate. |

### `survival.scavenge`

- **Config** `{ district: AreaId, durationMin: 60|120|180, supplies: { food, water, medkits } }`, hand-validated by
  `parseConfig`. Supplies are what **each** participating group brings (escrowed at start).
- **Snapshot** (actor) — a survivor group `{ actorId, members, condition 0..100, carryCapacity }`.
- **Budget** — one segment (weight 1) per in-game hour: `⌊durationMin × paceBp / (60 × 10000)⌋`, at least 1.
- **Each hour**, per group in `actorId` order: consume one `item:ration` and one `item:water` per member (from
  `escrow`); ongoing infection damage; `members × searchesPerMember` find rolls (`finds` stream) stowed in the
  game-defined `pack` container up to `carryCapacity` (excess is left behind); one threat roll (`threats` stream:
  horde / collapse / infection) that lowers condition (infection keeps hurting each hour); an automatic medkit below
  condition 40 (heals 35, cures infection).
- **Outcomes** — `failed` when a group's condition reaches 0; `retreated` when a group cannot afford another hour of
  food/water before the budget ends; otherwise `completed`.
- **RNG** — each hour uses `RngStreams.fromSeed(deriveSeed(seed, 'hour', index))`, so resuming from `stateAfter` with
  the same seed reproduces the original suffix exactly (tested); party revisions re-roll with the revision seed.
- **Settle** — natural end of a `failed` run: consumption kept, finds aggregated per (actor, item) and
  `total − ⌊total/2⌋` kept. Every other case (`completed`/`retreated` outcomes, `cancelled`, `member_left`, partial
  cutoffs) is `defaultSettle`.
- **Summarize** — `{ hours, outcome (whole timeline only), finds, leftBehind, threats, medkitsUsed, suppliesUsed,
  causeOfFailure }`.

## Commands

```sh
pnpm vitest run --project @survival/sandbox
pnpm --filter @survival/sandbox exec node src/cli.ts --district old_market --hours 3 --seed 42
# options: --district old_market|rail_yard --hours 1|2|3 --seed N --members N --condition 1..100 --carry N
#          --food N --water N --medkits N --pace BP --runs N
```

The CLI runs on Node ≥ 22.18 with built-in type stripping (no build step, no extra dependency); workspace packages
resolve to their real paths outside `node_modules`, so their `.ts` sources are stripped too. The wall clock is
simulated (start at t = 0); no `Date` anywhere, so the package-wide determinism lint needs no exception.

## Boundary findings

Things the sandbox needed that the engine does not provide (or provides awkwardly). Nothing was patched in the engine
and nothing was worked around beyond what is noted; each item proposes an engine change.

1. **Escrow has no owner in the simulator contract (unused supplies are never returned).** The kernel spec says start
   "escrows inputs" and settlement leaves "escrow fully consumed or returned", but `ExpeditionSimulator` has no way to
   declare what is escrowed, and `settle(timeline, cutoff, reason)` receives neither the config nor an escrow record —
   so it cannot compute the leftover (e.g. on cancel at cutoff −1 there is no segment at all). The sandbox only emits
   consumption (`from: 'escrow'`) and does **not** return leftovers.
   *Proposal:* add `escrow(config, actors): LedgerDelta[]` to the simulator contract; the kernel escrows those at
   start and, at settlement, returns per (actor, asset) `escrowed − Σ settled deltas with from: 'escrow'` to the
   source container — generic, no game logic. (Alternatively pass `config` to `settle`.)
2. **The kernel cannot tell which area a config targets.** Completion gating ("complete the district to unlock idle
   runs") is an engine check, but `district` is an opaque game field of `Config`; and `area.activities` ids
   (`ns:name`, e.g. `activity:scavenge`) have no defined link to simulator ids (`survival.scavenge` does not even match
   `IdSchema`). *Proposal:* the start command carries `{ areaId, activityId }` explicitly (or the contract gains
   `area(config): AreaId`), and activities map to simulator ids (e.g. `activities: [{ id, simulator }]` or allow
   simulator ids as activity ids). Related: `canStart` gets no world/eval context, so a game cannot require e.g. a
   tool to start a run without re-implementing requirement evaluation; consider passing an `EvalContext` or letting
   the kernel evaluate an optional per-activity `requires`.
3. **`PredicateRegistry` forces a Zod dependency (and version lock) on games.** `GamePredicateDefinition.args` is a
   `z.ZodType`, so the sandbox must depend on `zod` at exactly engine/world's version (type identity), while the
   expedition kernel deliberately avoided Zod (`parseConfig(input: unknown)`). *Proposal:* accept
   `parseArgs(input: unknown): A` (or the Standard Schema interface, which Zod implements) in predicate definitions.
4. **Contract checker: custom settlement loses the "no future deltas" guarantee.** With `settlement: 'custom'` only
   validity/determinism are checked, so a custom `settle` that leaked deltas of segments after the cutoff (e.g. on
   `cancelled`) would pass. The sandbox's settle differs from default in exactly one case (natural end of a failed
   run), so it runs the checker twice (custom on all seeds, `default` on non-failing seeds) plus a manual test.
   *Proposal:* per-reason modes (`settlement: { cancelled: 'default', member_left: 'default', completed: 'custom' }`),
   and in custom mode a generic bound check: `netHoldings(settle(cutoff))` never exceeds the positive holdings of
   `defaultSettle(cutoff)` per (actor, asset).
5. **No timeline hash helper.** The spec guarantees "same inputs ⇒ same timeline hash" and expeditions are persisted
   with versions, but the kernel exports no hash; the golden test uses `hashSeed(stableStringify(timeline))`.
   *Proposal:* export `timelineHash(timeline)` from the kernel so every game (and persistence) uses the same one.
6. **Per-segment RNG is the natural fit for resumption, but undocumented.** `stateAfter` is documented as possibly
   encoding RNG state, yet the kernel always resumes with a *new* revision seed, so stored RNG state is never reused.
   Deriving streams per segment (`deriveSeed(seed, 'hour', index)`) keeps `stateAfter` small and makes same-seed resume
   reproduce the original suffix. *Proposal:* document this pattern and offer `segmentStreams(seed, index)`.
7. **Duration lives in two places.** The kernel passes `durationMin` to `budget`/`canStart` separately from the
   game config, while the sandbox config also carries `durationMin` (per the issue), so `canStart` must cross-check
   (`duration_mismatch`). *Proposal:* decide whether duration is kernel-owned (drop it from game configs) and document.
8. **Multi-actor inputs.** Config is expedition-level but supplies/escrow are per actor; the sandbox reads `supplies`
   as "per group". Finding 1's `escrow(config, actors)` would make this explicit.
9. **Minor:** `BP_SCALE` is exported by both `@engine/world` and `@engine/sim-core` (same value; a game doing
   `export *` from both would get an ambiguity error). `@engine/world` could re-use sim-core's.

What worked without friction: `validateWorld`, requirement/visibility/completion with a game predicate and typed
game context, game-defined area kinds (`district`) and containers (`pack`), `placeSegments`/`visibleView` (no early
failure leak across all fixtures), `estimate`, `checkSimulatorContract`, and the determinism lint (the CLI only
needs `process.argv`/`console`).

## Deviations

- Content is JSON inside the package, loaded with `validateWorld` / Zod directly: the content compiler is not
  integrated yet (ADR-0008's "run the compiler" step does not apply yet).
- Tool IDs are namespaced (`tool:bolt_cutters`), matching the engine/world survival fixture.
