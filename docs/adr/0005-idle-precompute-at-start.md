# ADR-0005: Idle expeditions are precomputed at start and revealed progressively

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Expeditions last 15–180 min, must survive app closure and server restarts, support cancellation and parties, and must
not require long-lived processes.

## Decision
- On start, in one transaction: CAS the activity lock, escrow consumables, snapshot participant stats/config, run the
  full simulation, persist the timeline + `seed`, `engineVersion`, `contentHash`, `startsAt`, `endsAt`.
- Wall-clock duration defines the **encounter budget**; it is decoupled from simulated ticks.
- The API only reveals events with `t ≤ now`.
- A settlement job at `endsAt` settles idempotently (`UPDATE … WHERE status='running' RETURNING`). Opening the app
  after `endsAt` also triggers settlement (lazy path).
- Cancellation cuts the timeline at `now`. Party member departure re-simulates the remainder from `t` with a
  revision-derived seed.
- Participant stats are frozen for the expedition (level-ups apply at settlement).

## Consequences
- No idle processes; worker crashes are harmless retries.
- Deploying a new engine never affects in-flight expeditions.
- The full outcome exists server-side before the player sees it: it must never leak to the client.
- Estimates (Monte Carlo) are a separate concern; see spike 1.
