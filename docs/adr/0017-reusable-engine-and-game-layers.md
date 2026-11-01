# ADR-0017: Reusable engine and game layers in one monorepo

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
The live + idle exploration model (hub, world map of places to explore, graph-based areas, conquest unlocking idle
expeditions, shared economy) is reusable beyond this fantasy RPG — e.g. a survival game (shelter hub, city districts,
scavenging runs) or other themes. We want to reuse it without building a generic platform before a single game exists.

## Decision
- The codebase is split into two layers:
  - **Engine** (`engine/*`): game-agnostic packages — determinism utilities, world graph, economy/ledger, expedition
    kernel, live kernel, content compiler, server kit, client kit. No fantasy/RPG concepts (no combat, XP, regions,
    enemies) in names, types or tables.
  - **Games** (`games/<slug>/*`): a concrete game built on the engine — its simulators, stats, content schemas
    extensions, content, art, UI theme and apps. This project is `games/rpg`.
- Both layers live in **this monorepo** for now. A lint rule forbids `engine/*` from importing `games/*`.
- A minimal second game, `games/survival-sandbox` (tests/CLI only, no art or UI), exists to prove the engine boundary:
  if it needs something from `games/rpg`, the boundary is wrong.
- Engine packages use a placeholder scope `@engine/*`; renaming once the engine has a product name is a mechanical change.
- **Extraction trigger:** move `engine/` to its own repository (history preserved) when a second real game starts, then
  version and publish packages.

## Consequences
- ~10–15% extra design effort in M1/M2/M6, mostly interface design.
- Engine boundaries also protect the economy and idle integrity (risks #2 and #3) because game code cannot bypass them.
- Each future game is its own deployment using the engine as a library — not a shared multi-game service.
