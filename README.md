# idle-rpg-adventure (working title)

A mobile-first fantasy RPG that combines **Live Adventure** (exploring illustrated scenes, tactical tick-based combat,
bosses) with **Idle Expeditions** (server-side automatic expeditions in regions you have conquered). One character, one
shared progression and economy.

> **Status:** pre-production. Concept consolidated, architecture decided, POC milestones planned. No game code yet.

## Documentation

| Doc | What it covers |
|---|---|
| [Concept](docs/concept.md) | Product vision, setting, game rules, POC scope |
| [Engine overview](docs/engine/overview.md) | Reusable engine: hub, world map, area graphs, live/idle kernels, plugin points |
| [Architecture overview](docs/architecture/overview.md) | Stack, POC architecture, scaling path, top risks |
| [Design review 2026-11](docs/architecture/design-review-2026-11.md) | Adversarial review behind the architecture |
| [ADRs](docs/adr/README.md) | Architecture decisions (accepted and pending spikes) |
| [Specification](docs/spec/README.md) | Data model, state machines, combat, idle, conquest, party, economy, content, UI |
| [Open decisions](docs/open-decisions.md) | Pending decisions with provisional proposals |
| [Roadmap](docs/roadmap.md) | Milestones M0–M8 (tracked as GitHub epics) |
| [Glossary](docs/glossary.md) | Terms (EN/ES) |

## Planned stack (summary)

TypeScript monorepo (pnpm) · React + Vite UI · PixiJS scene viewport *(pending spike)* · Fastify HTTP/WS modular
monolith · PostgreSQL (state, ledger, jobs) · server-only deterministic combat engine · JSON content compiled with Zod ·
Capacitor for mobile later *(pending spike)*.

## Repository layout

```
engine/         reusable, game-agnostic packages (world graph, economy, expedition & live kernels, kits)
games/rpg/      this game: apps/web, apps/server, RPG simulators, content, tools
games/survival-sandbox/   toy game proving the engine boundary (tests/CLI only)
tools/          repository-level tooling (lint boundary proofs)
docs/
```

Packages are placeholders for now; see [engine overview §6](docs/engine/overview.md) for what each one will hold.

## Development

Requires Node 22+ (see `.nvmrc`) and pnpm 10 (pinned via `packageManager`; `corepack enable` picks it up).

```sh
pnpm install          # install all workspace packages
pnpm typecheck        # tsc --noEmit for the root and every package
pnpm lint             # ESLint, including architectural boundary rules
pnpm test             # Vitest across all packages + boundary rule proofs
pnpm check            # typecheck + lint + test (what CI runs on Node 22 and 24)
pnpm lint:boundaries:test   # only the boundary rule proofs
```

Boundary rules (engine ↛ games, engine layering, sandbox ↛ `@rpg/*`, web ↛ simulators, determinism in simulators) live
in `eslint.config.js` and are proven by `tools/boundaries/boundaries.test.ts`.

The exploration + idle model (hub → world map → areas → idle unlock) is built as a **reusable engine** so other games
(e.g. survival) can reuse it — see [ADR-0017](docs/adr/0017-reusable-engine-and-game-layers.md).
