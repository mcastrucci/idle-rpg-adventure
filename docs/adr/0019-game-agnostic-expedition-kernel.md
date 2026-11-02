# ADR-0019: Game-agnostic expedition kernel with simulator plugins

- **Status:** Accepted
- **Date:** 2026-11-01
- **Refines:** ADR-0005

## Context
The idle machinery (activity lock, precompute, progressive reveal, idempotent settlement, cancellation, party
re-simulation, estimates) contains no RPG logic. Only "what happens during an expedition" is game-specific.

## Decision
- `engine/expedition-kernel` owns the expedition lifecycle; games plug in a pure, deterministic
  `ExpeditionSimulator` (see `docs/engine/expedition-kernel.md`) that returns a **timeline of segments** with events and
  **ledger deltas as data**, plus an outcome.
- The kernel places segments on the wall clock by weight, reveals only past segments, applies deltas through the
  engine ledger idempotently, runs Monte Carlo estimates by calling the simulator with N seeds, and handles party
  revisions.
- Participants are generic **actors** (a hero, a group of survivors, a drone…).
- Game-specific post-settlement logic (e.g. level recomputation) runs in a hook inside the same transaction.

## Consequences
- The RPG combat engine becomes `games/rpg/packages/rpg-sim`, implementing the simulator interface.
- `games/survival-sandbox` implements a toy simulator to keep the kernel honest.

## Amendment 2026-11 (v0.2)

The survival sandbox (#67) exposed boundary gaps, fixed in the engine by #70 (`KERNEL_VERSION` 0.2.0):

- **Escrow is part of the simulator contract.** `escrow?(config, actors)` declares the per-actor deltas moved into the
  engine `escrow` container at start (explicit source container, one per actor and asset). At settlement the kernel
  returns `escrowed − consumed` to the source automatically (`settleWithEscrow`), including cancellation before the
  first segment; simulators never compute leftovers.
- **Activities link areas to simulators.** Start commands carry `{ areaId, activityId, durationMin, paceBp }`.
  Activity IDs are content IDs (`ns:name`) listed in `area.activities`; an `ActivityRegistry` maps them to simulators,
  whose IDs are code IDs `<game>.<name>` (`SIMULATOR_ID_PATTERN`), distinct from content IDs. `checkStart` enforces
  the engine gates (area exists, activity listed and registered, area completed by every actor — areas without a
  completion rule are open) and then calls `canStart` with the world, area, per-actor `EvalContext`s and the
  `PredicateRegistry`.
- **Duration is kernel-owned**: game configs do not carry it.
- **Settlement is bounded.** The contract checker supports per-reason modes; custom settlement must satisfy
  `net(settle) ≤ max(net(defaultSettle), 0)` per actor and asset at every cutoff (penalties allowed, extra gains not)
  and conserve escrow.
- `timelineHash` and per-segment RNG helpers (`segmentStreams`, `deriveSeed(seed, 'segment', i)`) are provided by the
  kernel. `@engine/world` predicate arguments accept any Standard Schema or a parse function (no Zod version lock).

`escrow` and the new `StartContext` fields are optional, so simulators written against v0.1 still compile; they must
drop any duration from their configs and register their activities to be started through `checkStart`.

## Amendment 2026-11 (v0.3)

The RPG idle simulators (#76) surfaced five more gaps, fixed in the engine by #77 (`KERNEL_VERSION` 0.3.0):

- **Cancel-after-end guard.** The settle reason and cutoff are kernel decisions, not server choices:
  `resolveSettlement(placed, now, 'complete' | 'cancel' | 'member_left')` (or `settleAt`, which also settles with
  escrow) turns any request at or after the **actual** end (`now ≥ endsAt`) into a `completed` settlement of the whole
  timeline, refuses `complete` before the end (`settle.notEnded`, without timestamps), and otherwise uses the reveal
  cutoff (which never covers the last segment before the end). A cancel can therefore never skip a natural-end penalty
  such as the loss on a failed run. The contract checker verifies it per fixture and seed (`cancel-after-end`).
- **The target is kernel-owned**, like the duration: the start request's `areaId`/`activityId` are passed to
  `canStart`, `budget`, `simulate`, estimates and contract fixtures; game configs must not duplicate them (the RPG idle
  config dropped `activity`, the sandbox config dropped `district`). Servers persist them with the expedition.
- **Start order and errors.** `checkStart` receives the raw config, parses it first (`start.invalidConfig`), runs
  `canStart` before `escrow` and `budget`, and maps every simulator throw to a stable `start.*` code
  (`start.simulatorError`, `start.invalidEscrow`, `start.invalidBudget`); it returns the parsed config.
- **Unique minting.** `@engine/economy` gains `{ kind: 'unique_mint', item }`: a grant of `qty` new unique instances
  (ADR-0007: equipment = unique rows; simulators cannot know instance IDs). It is grant-only (no `from`, `qty ≥ 1`)
  and cannot be escrowed; the ledger derives instance IDs from the delta's idempotency key. `unique` deltas move
  exactly one instance.
- **Non-ledger estimates.** `estimate` accepts a game extractor `(timeline, settled) → Record<string, integer>` (e.g.
  XP) aggregated with the same nearest-rank percentiles.

All new simulator-facing fields are optional, so v0.2 simulators still compile; `CheckStartInput.config` was renamed
`rawConfig` (callers pass the raw command payload) and `EstimateResult` gained `metrics`.
