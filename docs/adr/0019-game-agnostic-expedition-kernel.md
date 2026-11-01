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
