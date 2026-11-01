# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript full-stack monorepo with pnpm workspaces | Accepted |
| [0002](0002-server-authoritative.md) | The server is the exclusive authority | Accepted |
| [0003](0003-simulation-server-only.md) | Simulation is server-only; clients share contracts | Accepted |
| [0004](0004-deterministic-step-engine.md) | Combat engine as a deterministic step function | Accepted |
| [0005](0005-idle-precompute-at-start.md) | Idle expeditions precomputed at start, revealed progressively | Accepted |
| [0006](0006-postgresql-single-source-of-truth.md) | PostgreSQL as single source of truth and job queue | Accepted |
| [0007](0007-ledger-and-activity-lock.md) | Idempotent economy ledger and character activity lock | Accepted |
| [0008](0008-declarative-content-pipeline.md) | Canonical JSON content, Zod schemas, content compiler | Accepted |
| [0009](0009-modular-monolith.md) | Modular monolith, single deployable with process roles | Accepted |
| [0017](0017-reusable-engine-and-game-layers.md) | Reusable engine and game layers in one monorepo | Accepted |
| [0018](0018-hierarchical-world-graph.md) | Hierarchical world graph (world map → areas → locations) with hubs | Accepted |
| [0019](0019-game-agnostic-expedition-kernel.md) | Game-agnostic expedition kernel with simulator plugins | Accepted |
| [0010](0010-scene-renderer.md) | Scene viewport renderer (PixiJS vs Phaser) | Proposed — spike 2 |
| [0011](0011-capacitor-mobile.md) | Capacitor for future iOS/Android | Proposed — spike 2 |
| [0012](0012-live-instance-hosting.md) | Live instance hosting (in-house vs Colyseus) | Proposed — spike 3 |
| [0013](0013-tick-and-idle-encounter-model.md) | Combat tick duration and idle encounter model | Proposed — spike 1 |
| [0014](0014-tiled-scene-editor.md) | Tiled as the scene layout editor | Proposed — M5 |
| [0015](0015-data-access-layer.md) | Data access layer (Drizzle vs Kysely) | Proposed — M2 |
| [0016](0016-hosting.md) | Hosting for the POC | Proposed — M2 |

New ADRs: copy [`0000-template.md`](0000-template.md). Accepted ADRs are never edited in substance — supersede them.
