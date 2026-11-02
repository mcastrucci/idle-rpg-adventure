# @engine/expedition-kernel

Game-agnostic idle expedition kernel (ADR-0005, ADR-0019, [spec](../../docs/engine/expedition-kernel.md)). This is the
**pure part**: the simulator plugin contract, timeline types, wall-clock placement/reveal/cutoff helpers, escrow bookkeeping,
area/activity start gating, Monte Carlo estimates and a reusable contract checker. Persistence, jobs and the ledger wiring come later (M6). No game concepts
here; determinism rules (ADR-0004) apply: integer math, no clock (timestamps are integer ms passed in), no
`Math.random`.

## Versioning

`KERNEL_VERSION` (`0.3.0`) versions the kernel's behaviour (placement rule, settle semantics, estimate seeding).
0.3.0 (#77): cancel-after-end guard, kernel-owned activity target, `checkStart` order and error codes, `unique_mint`
assets, game metrics in estimates — see "Changes in v0.3" below.
Persisted expeditions record `KERNEL_VERSION` **and** the simulator's `id` + `version` (plus seed and content hash).
Bump the relevant one on any behaviour change.

## Simulator contract

```ts
interface ExpeditionSimulator<Config, Snapshot, Event, SimState = unknown, Report = unknown, Game = unknown> {
  id: string;                    // SIMULATOR_ID_PATTERN: 'rpg.hunt', 'survival.scavenge'
  version: string;
  parseConfig(input: unknown): Config;               // throws on invalid input (Zod optional, game-side)
  canStart(ctx: StartContext<Config, Snapshot, Game>): StartCheck;   // + areaId, activityId (v0.3), world, area, …
  escrow?(config: Config, actors: Snapshot[]): LedgerDelta[];         // moved into 'escrow' at start (v0.2)
  budget(config: Config, durationMin: number, paceBp: number, target?: ActivityRef): number;  // planned total weight
  simulate(input: { config; actors: Snapshot[]; seed: Seed; budget: number; areaId?; activityId?;   // target: v0.3
                    from?: { segment: number; state: SimState } }): Timeline<Event, SimState>;
  settle(timeline, cutoff: number, reason: SettleReason): LedgerDelta[];  // segments 0..cutoff, -1 = none
  summarize(timeline, cutoff: number): Report;
}
type Timeline<E, S> = { segments: Segment<E, S>[]; outcome: 'completed' | 'retreated' | 'failed' };
type Segment<E, S> = { index; weight /* positive safe int */; events: E[]; deltas: LedgerDelta[]; stateAfter?: S };
type SettleReason = 'completed' | 'cancelled' | 'member_left';
```

Differences from the illustrative spec: `configSchema: ZodType` became `parseConfig(input)` (no Zod dependency);
`SimState` and `Report` are type parameters; `pace` is in basis points (`paceBp`); `budget` is the planned **total
weight** (= segment count with unit weights).

- `SettleReason` is closed. `completed` = natural end at `endsAt` (whatever the outcome; the outcome is on the
  timeline). `cancelled` = owner cancel at the cancel cutoff. `member_left` = a party member's share at a revision.
- `defaultSettle(timeline, cutoff)` = deltas of segments `0..cutoff`; simulators without special rules use
  `settle: defaultSettle`.
- Resumption (party revisions): `simulate` with `from: { segment: k, state: segments[k-1].stateAfter }`, seed
  `revisionSeed(seed, r)` and the **remaining** budget returns segments starting at index `k`;
  `spliceTimeline(original, k, resumed)` keeps the prefix. `stateAfter` is server-only (it may encode RNG state).

## IDs, activities and start gating (v0.2)

- **Simulator IDs** name code: `<game>.<name>` (`SIMULATOR_ID_PATTERN`, e.g. `survival.scavenge`), stored with
  `version`. **Activity IDs** are content (`ns:name`, `@engine/world` `IdSchema`, e.g. `activity:scavenge`,
  `idle:hunt`) listed in `area.activities`. An `ActivityRegistry` maps activity → simulator (many-to-one allowed);
  `unregisteredActivities(world, registry)` finds content activities without a simulator.
- A start command carries `StartRequest { areaId, activityId, durationMin, paceBp }` plus the raw game config.
- `checkStart({ world, request, activities, simulator, rawConfig, actors, evalContexts, predicates })` runs, in order
  (first failure wins, codes in `START_CODES`): `start.unknownArea`, `start.activityNotInArea`,
  `start.unknownActivity` / `start.simulatorMismatch`, `start.invalidDuration`, `start.noActors` /
  `start.contextMismatch`, `start.areaNotCompleted` (every actor, via `evaluateCompletion`; areas without a completion
  rule are open; `reasons` = `completion.discoveries:<area>` and the failing `required` keys), then **parses the raw
  config** (`start.invalidConfig`), calls `simulator.canStart` with the parsed config, `areaId`, `activityId`,
  duration, `world`, `area`, one `EvalContext` per actor and the `PredicateRegistry` (its refusal is returned as-is),
  then `escrow` (`start.invalidEscrow`) and `budget(config, durationMin, paceBp, { areaId, activityId })`
  (`start.invalidBudget`). Every simulator call is guarded: a throw (or a malformed `canStart` result,
  `start.simulatorError`) becomes a `start.*` failure with the error as `message` — `checkStart` never throws because
  of a simulator. On success it returns `{ ok: true, config, budget, escrow }` (the **parsed** config to persist).
  Locks/CAS/ledger stay with the caller.
- **Duration and target are kernel-owned:** `durationMin`/`paceBp` and `areaId`/`activityId` come from the request and
  are passed to `canStart`/`budget`/`simulate`; game configs must not carry them. Persist `areaId`/`activityId` with
  the expedition and pass them again to `simulate` on resumption and to `estimate`.

## Inputs: per expedition vs per actor

`Config` is **per expedition** (one value chosen at start, shared by all participants). Per-actor inputs live in the
actor **snapshots** (what the actor is: members, stats, loadout) or are derived per actor from the config by
`escrow(config, actors)`, which returns one delta per (actor, asset) — e.g. "each group brings these supplies". The
escrow list is the authoritative record of what each actor put in.

## Escrow (v0.2)

`escrow(config, actors)` deltas are `{ actorId, asset, qty > 0, from: <source ≠ 'escrow'>, to: 'escrow' }`, one source
per (actor, asset) (`escrowProblems` / `assertEscrow`). Segments consume with `from: 'escrow'`. At settlement
`settleWithEscrow(sim, timeline, cutoff, reason, config, actors)` returns `{ escrowed, settled, returned, deltas }`:
`returned` = per (actor, asset) `escrowed + net escrow change in settled` (= escrowed − consumed), moved
`escrow → source`; `deltas = settled ++ returned` is what the ledger applies. Works for any cutoff including `-1`
(cancel before the first segment returns everything) and empty timelines. `escrowReturns` throws if settlement takes
more out of escrow than was escrowed, touches never-escrowed assets in escrow, or moves anything into escrow. Estimates
are unaffected (escrow and returns are holding-neutral moves).

## RNG per segment (resumption pattern)

Recommended: derive a fresh stream set per segment, `segmentStreams(seed, index)` =
`RngStreams.fromSeed(segmentSeed(seed, index))` with `segmentSeed = deriveSeed(seed, 'segment', index)`. A segment's
rolls then depend only on `(seed, index)`, `stateAfter` carries game state only (no RNG state), resuming from
`stateAfter[k-1]` with the same seed reproduces the original suffix exactly, and a revision seed re-rolls it. Carrying
one RNG across segments also works but then `stateAfter` must include the RNG state.

## Timeline hash

`timelineHash(timeline)` = `hashSeed(stableStringify(timeline))`: a deterministic uint32 (FNV-1a 32 + murmur3
finalizer over canonical JSON), dependency-free; use it for golden tests and persistence. Not cryptographic.

## Placement rule

```
revealAt[i] = startsAt + ⌊cumWeight[i] × durationMs / budget⌋
endsAt      = startsAt + ⌊Σweight × durationMs / budget⌋      (last revealAt, or startsAt if no segments)
```

The denominator is the **planned budget**, not the produced weight: a timeline that consumes the full budget ends
exactly at `startsAt + durationMs`; one that stops early (failed/retreated, Σweight < budget) ends early at its last
segment's reveal time. With unit weights this is the RPG spec's `startsAt + (i+1)/budget × duration`. Exact integer
math via `mulDivFloor`; reveal times are non-decreasing and may coincide when `durationMs < budget`.

`placeSegments(timeline, startsAtMs, durationMs, budget)` → `PlacedTimeline` with `revealAtMs` per segment,
`plannedEndsAtMs` and the actual `endsAtMs` (server-only until reached).

## Settlement resolution: cancel-after-end guard (v0.3)

**The server never chooses the settle reason or cutoff itself.** It calls
`resolveSettlement(placed, nowMs, requested)` with `requested ∈ 'complete' | 'cancel' | 'member_left'`, or the one-call
`settleAt(simulator, timeline, placed, nowMs, requested, config, actors)` (= resolve + `settleWithEscrow`):

| request | `now < endsAt` | `now ≥ endsAt` |
|---|---|---|
| `complete` (settlement job) | refused: `settle.notEnded` (no timestamps in the refusal) | `completed`, cutoff = last |
| `cancel` (owner command) | `cancelled`, cutoff = `revealCutoff(now)` | **`completed`, cutoff = last** (`converted: true`) |
| `member_left` | `member_left`, cutoff = `revealCutoff(now)` | `completed`, cutoff = last (`converted: true`) |

`endsAt` is the **actual** end (earlier than the planned end on an early failure/retreat). Without the guard, a cancel
whose cutoff covers the fatal segment would settle with `cancelled` and skip penalties that a simulator applies only
to a natural end (e.g. the RPG/sandbox loss on a failed run). Before the end the reveal cutoff never covers the last
segment (it is revealed exactly at `endsAt`). `canCancel(placed, now)` (`now < endsAt`) lets a server reject a late
cancel command, but it must still settle the expedition as `completed`. The contract checker proves the guard per
fixture and seed (`cancel-after-end`).

## Reveal, cancel, seeds

- `revealCutoff(placed, nowMs)` — last segment with `revealAtMs ≤ now` (−1 if none). `cancelCutoff` = same (use it
  only through `resolveSettlement`).
- `visibleView(placed, nowMs)` — client-safe: revealed segments without `stateAfter`, `revealedDeltas` (net), the
  **planned** end, and `outcome`/`endedAtMs` only once `now ≥ endsAt`. It never exposes the actual end or the segment
  count early (an early end would reveal a failure in advance), so progress bars use `plannedEndsAtMs`.
- `revisionSeed(seed, r)` — `r = 0` → `seed`, else `deriveSeed(seed, 'revision', r)`.

## Estimates

`estimate(simulator, { config, actors, budget, areaId?, activityId? }, runs, rootSeed, { metrics? })` runs `simulate`
with `estimateSeed(rootSeed, i) = deriveSeed(rootSeed, 'estimate', i)` (and the target), settles each full timeline
with `completed`, and returns per `(actorId, asset)` net holdings `min/p10/p50/p90/max` (nearest rank `⌈p·n/100⌉`;
runs without a change count as 0), outcome counts and `outcomeRatesBp = ⌊count·10000/runs⌋`. All integers.

Non-ledger outcomes (v0.3): an optional game extractor `metrics(timeline, settled) => Record<string, number>` (safe
integers, e.g. `{ 'xp:<actorId>': 120 }`) is aggregated per key with the same percentiles into `metrics` (sorted by
key; missing keys count as 0; `[]` without an extractor).

## Contract checker

```ts
expect(checkSimulatorContract(simulator, [{ config, actors, budget, seeds: [1, 2, 3] }])).toEqual([]);
```

Returns `ContractViolation[]` (no test-framework dependency). Checks: simulator identity (ID pattern, version),
determinism (stable JSON with sorted keys via
`stableStringify`), no input mutation, JSON-only data, contiguous indices from 0, positive integer weights, safe-integer
delta quantities, Σweight ≤ budget, `parseConfig` round-trip, `settle` validity/determinism for every reason and cutoff, escrow
well-formedness/determinism and conservation (`escrow`), `summarize` determinism, resumption from `stateAfter`
(when present), and the cancel-after-end guard (`cancel-after-end`: a cancel resolved at `endsAt` settles exactly like
`completed` over the whole timeline, escrow returns included; one resolved 1 ms earlier is `cancelled` before the last
segment). Fixtures may carry `areaId`/`activityId` (v0.3), passed to every `simulate` call.

Settlement modes, one for all reasons or per reason (`{ settlement: { completed: 'custom', cancelled: 'default',
member_left: 'default' } }`; missing reasons default to `default` iff `settle === defaultSettle`):

- `default` — `settle` equals `defaultSettle` (`settle-cutoff`).
- `custom` — the **default bound** (`settle-bound`, `settlementBoundViolations`): for every cutoff and (actor, asset),
  `net(settle) ≤ max(net(defaultSettle(cutoff)), 0)` with `net` = `netHoldings` over all containers. Custom rules may
  reduce gains (failure penalties) or waive costs down to zero, never grant more than the default up to the cutoff
  (so leaked future gains are caught). Escrow returns are holding-neutral and bounded by escrow conservation.

## Changes in v0.3 (#77, findings of the RPG idle simulator #76)

- **Cancel-after-end guard** — `resolveSettlement`, `canCancel`, `settleAt`, `SETTLE_NOT_ENDED`, contract rule
  `cancel-after-end` (see above).
- **Kernel-owned target** — `ActivityRef` moved to `types.ts`; `StartContext.areaId/activityId`,
  `SimulateInput.areaId/activityId`, `budget(…, target?)`, `EstimateInput.areaId/activityId`,
  `ContractFixture.areaId/activityId`. All optional, so v0.2 simulators compile unchanged.
- **Start order** — `CheckStartInput.config` → `rawConfig` (raw input; the success result carries the parsed
  `config`); order parse → `canStart` → `escrow` → `budget`; new codes `start.invalidConfig`, `start.simulatorError`;
  throws mapped to codes.
- **Unique minting** — `@engine/economy` `{ kind: 'unique_mint', item }` (grant of `qty` new instances); escrow rejects
  it.
- **Estimates** — `estimate(…, { metrics })` → `EstimateResult.metrics: MetricEstimate[]` (always present).
