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
