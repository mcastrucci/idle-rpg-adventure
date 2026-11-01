# ADR-0006: PostgreSQL as the single source of truth and job queue

- **Status:** Accepted
- **Date:** 2026-11-01

## Context
Low infrastructure cost and few moving parts. Needs: relational integrity for the economy, transactions, row locks,
scheduled jobs, light cross-node signalling.

## Decision
- PostgreSQL holds all durable state, the ledger, instance leases and the job queue (pg-boss or graphile-worker,
  decided in M2, running in-process).
- `LISTEN/NOTIFY` for light signalling when more than one node exists.
- No Redis or external queue during the POC.

## Consequences
- Requires a Postgres provider with **direct (non-pooled) connections** for `LISTEN` and long-lived sessions.
- Revisit Redis when multiple live nodes need presence/pub-sub or global rate limiting (~1,000 CCU).
