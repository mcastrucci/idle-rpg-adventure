# ADR-0018: Hierarchical world graph (world map → areas → locations) with hubs

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Every game built on the engine shares the same spatial structure: a main **hub**, a **world map** of places to go and
explore, and explorable places made of connected **locations**. Conquest/completion of a place unlocks idle activities
there.

## Decision
- The world is a two-level graph defined in content:
  - **World map:** nodes are **areas** (`kind: hub | explorable | …`), edges are **routes** with requirements.
  - **Area:** a graph of **locations** connected by **exits** with requirements.
- Requirements are a **closed, composable predicate set** (`all`, `any`, `not` + engine predicates such as
  `discovered`, `areaCompleted`, `flag`, `hasItem`) extended by **typed predicates registered by the game** (e.g. RPG
  `defeated(enemy)`, `levelAtLeast`). No free-form expression language.
- **Completion** is a generic rule per area: `{ pool, thresholdBp, required }` (RPG conquest =
  ordinary locations, 7000 bp, mandatory bosses defeated). The requirement is frozen at publish time.
- Hubs are safe areas where loadout/inventory changes are allowed and game-defined **services** live.
- Discovery, completion and world-map visibility are tracked per actor by the engine.

## Consequences
- The RPG "region" is an engine area; "Sanctuary" is a hub area; portals are routes.
- Graph validation (reachability under requirements, completion feasibility) is engine code reused by every game.
- Game-specific predicates must be pure functions of actor state and are validated by the content compiler.
