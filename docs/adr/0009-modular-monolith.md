# ADR-0009: Modular monolith, single deployable with process roles

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
The counter-proposal separated API and simulation workers. Idle precompute takes tens of ms; settlement jobs are light.
Separate deployables add ops cost without POC benefit.

## Decision
- `apps/server` is one Fastify process containing all modules (auth, character, ledger, content, conquest, live-host,
  expeditions, party, jobs, debug).
- Modules communicate through explicit TypeScript interfaces, not shared mutable state.
- A `ROLES` setting (`api,live,worker`, default all) gates which parts start, so the same build can be split later.

## Consequences
- One container to deploy in the POC.
- Splitting at ~1,000 CCU is configuration, not a rewrite — as long as module boundaries are respected.
