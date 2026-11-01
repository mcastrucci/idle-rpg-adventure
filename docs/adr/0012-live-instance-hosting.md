# ADR-0012: Live instance hosting (in-house InstanceHost vs Colyseus)

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** Spike 3

## Context
Live instances are stateful (in memory), need reconnection, crash recovery and, later, cross-node routing.

## Decision (hypothesis)
- Live hosting sits behind an `InstanceHost` interface.
- Each instance holds a **lease** in Postgres (`instance_id`, `node_id`, `lease_expires_at`) and **checkpoints** at
  meaningful boundaries (location change, combat end, loot pickup) — not per tick.
- Combat ticks only run during combat; exploration is command/response.
- Disconnection does not pause combat; disconnected characters act through automation during a reconnection window.
- Default implementation: in-house over Fastify WebSocket; Colyseus evaluated in spike 3.

## Consequences
- Node crash loses at most progress since the last checkpoint.
- Live coop (phase 2) reuses the same host with `participants[]`.
