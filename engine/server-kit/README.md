# @engine/server-kit

Reusable Fastify/PostgreSQL foundation for game composition roots. It provides validated process configuration,
injected wall time, a pg pool and typed Drizzle database, checked SQL migrations, compiled-content integrity checks,
module lifecycle, structured logs, health and shutdown handling. Generic authentication and actor activity are engine-owned; RPG attributes, skills, progression and economy behavior remain game-owned or future modules.

`createServer({ config, game, clock?, modules?, validateContent? })` verifies and freezes compiled content, runs the
game validator, opens PostgreSQL, verifies the migration version, records the observed content version and starts
selected modules. It resolves only after Fastify is ready. Call `app.listen()` in the executable; tests use
`app.inject()`. Close with `app.close()` to drain requests, close module resources, then release the pool. Failed boot
also closes resources. `installShutdownHandlers` adds SIGTERM/SIGINT handling with a configurable hard deadline.

Modules declare a unique domain name, process roles and `register(app, context)`. Context contains explicit `clock`,
`database` and immutable `content` dependencies. Fastify encapsulates module decorations/hooks; use explicit service
interfaces when one module needs another. Register resource cleanup through `onClose`. All named domain boundaries
(auth, character, ledger, content, conquest, live-host, expeditions, party, jobs, debug) are available; only implemented
modules are registered. This foundation installs no empty domain modules. Ownership/balances are changed through the
ledger transaction API, and only activity may change an actor's activity state (ADR-0007).

`ROLES=api,live,worker` is the default; any non-empty unique subset starts only matching modules. A module declaring
several roles starts once even when several match. Every role has `/health/live` and `/health/ready` for operations;
readiness checks PostgreSQL and returns the verified `contentHash` and enabled roles, while liveness is process-only.
Database errors produce a generic 503 response. Configuration and credentials are never included in startup logs.
Fastify emits JSON request/module lifecycle logs and redacts authorization/cookie headers.

`SystemClock` is the only wall-time source. Services consume `Clock.nowMs()`; `ManualClock.set/advance` allows time
travel in tests. Deterministic simulation receives integer times as input, rather than a clock or database handle.

## Database migrations

Schema definitions live in `src/schema.ts`. `pnpm --filter @engine/server-kit db:generate` generates reviewable SQL,
a journal and snapshots in `migrations/`; commit all three. Generation needs no database. Never edit an applied
migration: add a new one. The first migration creates the game-agnostic `content_releases` table, recording each
immutable content hash once with the injected first-seen timestamp. Game state is added by later feature migrations.

`database.migrate()` uses Drizzle's node-postgres migrator on a dedicated connection while holding a PostgreSQL
session advisory lock, serializing concurrent migration runners. Its transaction owns DDL and journal insertion.
Every boot compares journal hashes/timestamps with this build's migrations, failing on unapplied, edited or newer
migrations. Production defaults to a separate migration command before starting roles; `MIGRATE_ON_BOOT=true` is an
explicit local/single-deployment convenience. Queries, connection acquisition and statements have bounded timeouts.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL URL naming a database; use direct connections for future LISTEN/NOTIFY. |
| `CONTENT_BUNDLE_PATH` | required | Existing compiled format-1 JSON bundle; hash and game ID must match. |
| `ROLES` | `api,live,worker` | Unique subset of the three process roles. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Health/module HTTP listener; port 0 supports tests. |
| `LOG_LEVEL` | `info` | Pino log level, including `silent` for tests. |
| `DB_POOL_MAX` | `10` | Maximum connections per process (1–100). |
| `DB_TIMEOUT_MS` | `5000` | Connection/query/statement timeout (1–120000). |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Hard deadline for draining process shutdown (1–120000). |
| `MIGRATE_ON_BOOT` | `false` | Explicit `true` enables serialized startup migrations. |

CI supplies a real PostgreSQL 16 service on both supported Node versions. Set `TEST_DATABASE_URL` locally to run the
same integration suites (`pnpm vitest run --project @engine/server-kit --project @rpg/server`). The user must have `CREATEDB`: tests create and drop
a uniquely named disposable database and never clear the URL's existing database. With no URL these tests skip;
CI deliberately fails if its URL is missing. The suite covers concurrent/replayed migrations, transaction rollback,
content identity and first-seen clock, api/live/worker lifecycle, shutdown order, degraded readiness and failed-boot
pool cleanup. Job tests cover persistence after worker recreation, app-clock time travel, duplicate keys, retries,
multiple workers and graceful drain. Unit tests separately check config, manual time and hash parity with real compiler output.

## Layer-owned migration sets and domain modules

`createDatabase(config, { migrationSets })` and `createServer({ ..., migrationSets })` accept additional named SQL
sets, always following the engine set. Each has its own validated journal schema and directory. One advisory lock
serializes all sets; startup verifies every journal's hashes and timestamps. The game CLI must use the same set list
as its server. Engine migrations never import game definitions; the RPG owns its character table and journal.

Identity/session APIs live in [auth](src/auth/README.md), generic activity locks in `src/actors`, and replay-safe
transaction/maintenance APIs in [commands](src/commands/README.md). The game composes these modules and supplies its
command dispatcher; none of them imports RPG content or grants assets. The HTTP/WS command layer is not the ledger.

## Economy ledger transaction core

`src/ledger` owns append-only source batches and entries, non-negative stack/currency balances, and unique item
instances. Call `applyLedgerDeltas(tx, source, deltas, { activity })` only inside the caller's authenticated command or
coordinator transaction. It locks every actor in canonical UUID order, rejects unrelated activity mutations, scopes the
logical expedition `escrow` container by the explicit activity ID, and deduplicates `(source.type, source.id)` with a
canonical payload fingerprint. `getHoldings(tx, actorId)` reads persisted balances and unique item instances;
`moveUniqueItem` records moves and equipment slot changes in the same batch. `checkLedgerInvariants` compares fungible
balances and unique instance ownership history and checks scoped escrow against caller-supplied active expedition IDs.

This is the persistence and transaction core; it does not add authenticated Sanctuary inventory/purchase HTTP commands
or a periodic invariant-check job. Games must use the shared authenticated command runner for player-facing mutations;
no open production grant endpoint is provided.

## Durable jobs

`PostgresJobs` uses pg-boss for persistent job execution, worker coordination, and retries with exponential
backoff. `createJobsModule(handlers)` starts handlers only in the `worker` role and registers a Fastify close hook
that stops dispatch and gracefully drains active work before the shared server pool closes. Job handlers receive
the injected `Clock` and database. Their effects must be idempotent and transactional where possible: execution is
at-least-once, and external effects need a separate idempotency key or outbox. Exactly-once external effects are
not guaranteed.

The app-clock adapter persists a `(name, singletonKey)` schedule and its deadline as epoch milliseconds. A worker
promotes due schedules into pg-boss in one PostgreSQL transaction, so a crash cannot commit only one side of that
promotion. The `(name, singletonKey)` is unique for the lifetime of the schedule record; duplicate scheduling returns
the original ID, even after the job completes. pg-boss's `short` policy also collapses duplicate queued work but
allows concurrently active jobs. The permanent schedule key is the logical one-off guard; jobs needing another run
must use a new key (for example a new revision). `dispatchDue()` is public for deterministic tests. It reads the
injected app clock and does not alter PostgreSQL `NOW()`; in production the worker calls it at the configured poll
interval. pg-boss retry delays and active-lease timeouts use PostgreSQL's runtime clock, not the app clock. The
schedule mapping table is durable, while pg-boss owns retries, claiming, and completed job retention.
Exhausted retries remain failed in pg-boss for operator handling.

## Live instance hosting

`createLiveHostModule({ game, nodeId?, leaseMs?, graceMs?, hooks?, autoStart?, recoverEveryMs? })` composes the
[`@engine/live-kernel`](../live-kernel/README.md) `InstanceHost` for the `live` role ([ADR-0012](../../docs/adr/0012-live-instance-hosting.md)).
It returns `{ module, host(), handleSocketCommand }`; the composition passes `handleSocketCommand` to
`createAuthModule({ onCommand })`, which now hands every command a per-socket `LiveSocketConnection` (`id`, `push`,
`onClose`) for server pushes. Non-`live.*` payloads return `undefined` so other dispatchers can handle them. The
authenticated `/auth/live` socket and its fenced `live_sessions` lease still guarantee one device per account.

`PostgresInstanceStore` persists `live_instances` (`participants`, `status`, `node_id`, `lease_generation`,
`lease_expires_at`, `checkpoint`, `checkpoint_seq`, game version, content hash, outcome/result). Creation CASes every
participant's actor activity `none → live` in ascending actor order in the insert transaction; close and participant
release CAS back and run the optional `onClose`/`onParticipantReleased` hooks in the same transaction. The optional
`onEffects(tx, instance, effects, nowMs)` hook applies a step's durable game effects (`LiveStep.effects`) inside the
fenced transaction of the checkpoint, release or close they belong to; it must be idempotent. All later writes are
fenced on `(node_id, lease_generation, checkpoint_seq)` plus an unexpired lease. The table belongs to the separate
`LIVE_HOST_MIGRATIONS` set (`migrations-live/`, journal schema `live_host_migrations`), listed after the engine set by
compositions that host live instances; generate it with `pnpm --filter @engine/server-kit db:generate:live`.
