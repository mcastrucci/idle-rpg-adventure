# Architecture Overview

> Status: **Accepted baseline** (see ADRs). Items marked *hypothesis* are pending a spike.
> Rationale and the adversarial review behind it: [`design-review-2026-11.md`](design-review-2026-11.md).

## 1. Guiding observation

This game is **correctness-bound, not compute-bound**. At 10,000 concurrent users with ~40% in live combat we expect
~2,000 instances at 1–2 ticks/s (≈4,000 ticks/s) — trivial for Node. What can sink the project is duplicated loot, lost
state, a character in two activities at once, or a combat engine that only works for one mode. The architecture
optimizes for **authority, determinism, idempotency and a single source of truth**.

## 2. Engine / game split

The codebase is a reusable **engine** (`engine/*`) plus concrete **games** (`games/<slug>`); this project is
`games/rpg`. See [`docs/engine/overview.md`](../engine/overview.md) and ADR-0017/0018/0019. The diagram in §3 shows the
RPG composition; module names map to engine packages (`server-kit`, `economy`, `world`, `live-kernel`,
`expedition-kernel`) plus RPG plugins.

## 2b. Stack

| Layer | Choice | Status |
|---|---|---|
| Language | TypeScript everywhere | Accepted — [ADR-0001](../adr/0001-typescript-monorepo.md) |
| Monorepo | pnpm workspaces (no Turborepo yet) | Accepted — ADR-0001 |
| App UI | React + Vite, DOM-based UI | Accepted |
| Scene / combat viewport | PixiJS v8 in a bounded canvas behind a `SceneRenderer` interface | *Hypothesis* — [ADR-0010](../adr/0010-scene-renderer.md) |
| Server | Fastify (HTTP + WebSocket), single deployable, modular monolith | Accepted — [ADR-0009](../adr/0009-modular-monolith.md) |
| Live rooms | In-house `InstanceHost` (Colyseus evaluated and rejected) | Accepted — [ADR-0012](../adr/0012-live-instance-hosting.md) |
| Persistence + jobs | PostgreSQL only (pg-boss or graphile-worker in-process) | Accepted — [ADR-0006](../adr/0006-postgresql-single-source-of-truth.md) |
| Data access | Drizzle (locks/idempotency as explicit SQL) | *Hypothesis* — [ADR-0015](../adr/0015-data-access-layer.md) |
| Combat engine | Server-only deterministic step function | Accepted — [ADR-0003](../adr/0003-simulation-server-only.md), [ADR-0004](../adr/0004-deterministic-step-engine.md) |
| Idle | Precompute at start, progressive reveal, idempotent settlement | Accepted — [ADR-0005](../adr/0005-idle-precompute-at-start.md) |
| Economy | Idempotent ledger + character activity lock | Accepted — [ADR-0007](../adr/0007-ledger-and-activity-lock.md) |
| Content | Canonical JSON + Zod + content compiler with hash; Tiled for scene layout | Accepted / *hypothesis* — [ADR-0008](../adr/0008-declarative-content-pipeline.md), [ADR-0014](../adr/0014-tiled-scene-editor.md) |
| Mobile distribution | Capacitor | *Hypothesis* — [ADR-0011](../adr/0011-capacitor-mobile.md) |
| Hosting | Long-lived container + managed Postgres with direct connections | *Hypothesis* — [ADR-0016](../adr/0016-hosting.md) |

## 3. Minimum viable architecture (POC)

```
┌──────────────────────── apps/web (React + Vite) ────────────────────────┐
│  Sanctuary UI · Inventory · Expeditions · Reports      (DOM)            │
│  <SceneViewport> ── SceneRenderer (PixiJS)             (canvas)          │
│  api client (HTTP) · live client (WS, command_id, resume token)         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS + WSS
┌──────────────────────────────▼─────── apps/server (Fastify) ────────────┐
│ auth · character · ledger/inventory · content · conquest                │
│ live-host (instances, leases, checkpoints) · expeditions · party (ph.2) │
│ jobs (pg-boss in-process) · clock (injectable) · debug/admin            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                        ┌──────▼──────┐
                        │ PostgreSQL  │  state · ledger · jobs · leases
                        └─────────────┘

engine/sim-core              RNG streams, integer/bp math              (server + tools ONLY)
engine/world                 world/area graph, requirements, completion (web types + server)
engine/economy               ledger, containers, escrow                (server)
engine/expedition-kernel     idle lifecycle, simulator interface        (server + tools ONLY)
engine/live-kernel           InstanceHost, exploration FSM              (server)
engine/content-compiler      validate, compile bundle, hash, graphs     (tools)
engine/server-kit, client-kit
games/rpg/packages/rpg-schema   RPG content schema extensions          (web + server + tools)
games/rpg/packages/protocol     HTTP DTOs, WS messages                  (web + server)
games/rpg/packages/rpg-stats    display-only stat derivation            (web + server)
games/rpg/packages/rpg-sim      combat engine + RPG expedition simulator (server + tools ONLY)
games/rpg/tools/balance-sim     Monte Carlo, TTK, XP/hour live vs idle
games/rpg/content/              JSON definitions + Tiled maps + art
games/survival-sandbox/         toy simulator proving the engine boundary
```

### Module boundaries (server)

- **Only `ledger` mutates balances or item ownership.** Every other module asks it to, inside a transaction.
- **Only `activity` (part of `character`) changes `activity_state`**, via compare-and-set.
- **`sim` has no I/O**: no DB, no clock, no `Math.random`. It receives state, inputs and RNG; returns state and events.
- **`live-host` owns in-memory instances**; it persists through checkpoints and holds a lease per instance.
- **`expeditions` calls `sim` synchronously** at start (precompute) and schedules a settlement job at `endsAt`.

## 4. Evolutionary architecture (not built now)

| CCU | Shape | Additions |
|---|---|---|
| ~100 | POC as is, 1 node | Error tracking, backups, push notifications. ~USD 20–50/month |
| ~1,000 | Same code, 3 process roles: `api` (stateless ×N), `live` (stateful, lease-routed), `worker` | Redis (cross-node pub/sub, presence, global rate limiting), PgBouncer for non-`LISTEN` traffic, estimate cache |
| ~10,000 | Placement/directory service for live nodes (or Colyseus presence) | Managed Redis, outbox → queue (NATS/SQS) for notifications/analytics, ledger partitioned by time, separate analytics store. Vertical Postgres; no sharding yet |

## 5. Top technical risks

| # | Risk | Sev. | Prob. | Mitigation |
|---|---|---|---|---|
| 1 | Engine designed for only one mode (batch or real-time) | Critical | High | `step(state, inputs, rng)`; idle = policy-driven input loop |
| 2 | Duplication / double spend across live, idle, party | Critical | High | Idempotent ledger, activity lock, `FOR UPDATE`, consumable escrow |
| 3 | Idle with live processes or wall-clock ticks | High | Medium | Precompute, progressive reveal, idempotent settlement |
| 4 | Live instances without lease/checkpoints: lost state, disconnect-to-survive exploit | High | Medium | Lease + checkpoints + combat never pauses |
| 5 | Mobile memory/GPU limits with illustrated art | High | Medium | Texture budget, KTX2, one scene resident, context-loss recovery |
| 6 | Content production bottleneck (concept risk 15.6) | Med-high | High | Content compiler + Tiled + balance simulator |
| 7 | Engine changes invalidate in-flight expeditions, replays, death logs | Medium | High | `engineVersion`/`contentHash` + precompute |
| 8 | Determinism drift (floats, `Math.*`, ordering) | Medium | Medium | Determinism rules + golden replays in CI |
| 9 | Monte Carlo estimates too slow | Medium | Medium | Cache by build hash, per-encounter model (spike 1) |
| 10 | Late surprises: Capacitor, IAP, serverless hosting without WS/`LISTEN` | Medium | Low-med | Device spike; long-lived process hosting |
