# ADR-0003: Simulation is server-only; clients share contracts

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
The original proposal shared the combat engine with the client. With 0.5–1 s ticks the client needs no prediction.
Shipping the engine to the client adds version skew and bundle size, with no security benefit.

## Decision
- `packages/sim` (engine, RNG, idle runner) is imported only by `apps/server` and `tools/*`. A lint rule forbids importing
  it from `apps/web`.
- Shared with the client: `packages/content-schema`, `packages/protocol`, `packages/stats` (display-only stat
  derivation, e.g. equip preview). The server always recomputes.

Since [ADR-0017](0017-reusable-engine-and-game-layers.md): the rule applies to every simulator package
(`engine/sim-core`, `engine/expedition-kernel`, `games/*/packages/*-sim`) — none may be imported by a web app.

## Consequences
- Client shows server events; no client-side combat logic to keep in sync.
- Equip previews may briefly disagree with server if `stats` diverges — the server value wins.
