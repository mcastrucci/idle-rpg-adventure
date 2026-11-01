# ADR-0008: Canonical JSON content, Zod schemas and a content compiler

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Regions, scenes, enemies, skills, effects and loot must be data-driven (concept §14.4), and production speed is a key
risk (concept §15.6).

## Decision
- **JSON is the only canonical format** under `content/`. No YAML.
- Schemas in `packages/content-schema` (Zod); JSON Schema is generated from Zod for editor autocompletion.
- `tools/content-cli` compiles `content/` into one bundle with a `contentHash`, validating:
  - schema validity;
  - referential integrity (every referenced ID exists);
  - region graph rules (connected, ≥70% of conquest-pool locations reachable without secrets, mandatory bosses present);
  - frozen conquest baselines of published regions (see `docs/spec/conquest-rules.md`).
- IDs are stable, namespaced strings (`enemy:thornback_boar`) and are **never renamed or reused**; removal = deprecation.
- Effects are a **closed set of parameterized types** implemented in code. No expression language in JSON.

Since [ADR-0017](0017-reusable-engine-and-game-layers.md): the compiler lives in `engine/content-compiler`; engine schemas
(world, areas, locations, routes, items, containers) are extended by game schemas registered per game.

## Consequences
- The server loads only compiled bundles; invalid content fails CI, not production.
- Adding a new effect type requires code — intentional, keeps balance auditable.
