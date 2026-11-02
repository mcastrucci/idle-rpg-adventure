# ADR-0006: PostgreSQL as the single source of truth and job queue

- **Status:** Accepted
- **Date:** 2026-11-01
- **Implementation note (M2, 2026-11-02):** pg-boss is selected and runs in-process in the worker role. It stores executable jobs in PostgreSQL, applies retry/backoff, and coordinates workers. This implements the existing decision; it does not change the accepted PostgreSQL-only architecture.

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

Scheduled deadlines are mapped through `engine.scheduled_jobs`: the app stores its injected-clock deadline as epoch
milliseconds, and a small due dispatcher promotes eligible rows into pg-boss. Promotion and pg-boss insertion share
one transaction. The dispatcher compares deadlines with `Clock.nowMs()`; it never changes PostgreSQL `NOW()` or the
clock used by other SQL. A ManualClock change takes effect when `dispatchDue()` is called (automatically on the
worker's polling interval in production); pg-boss retry/backoff and active-lease timing still use PostgreSQL runtime
time. Schedule keys `(name, singletonKey)` are durable idempotency keys reserved for the lifetime of the schedule
record; pg-boss's `short` queue policy additionally deduplicates while a job is
queued. Handler execution is at-least-once: handlers must make database effects idempotent/transactional, and external
effects need their own idempotency mechanism or outbox. Queue-level retry exhaustion leaves the job failed for
operator handling; this first implementation does not add a dead-letter workflow or retention cleanup for schedule
records.
