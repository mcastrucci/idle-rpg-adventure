# ADR-0015: Data access layer (Drizzle)

- **Status:** Proposed — implementation selected; acceptance awaits the real-PostgreSQL CI validation below
- **Date:** 2026-11-01
- **Validation:** M2 server foundation (#25), PostgreSQL 16 on Node 22 and 24

## Context

The server needs typed SQL, explicit transactions and row locks, and reviewable migrations without introducing a
second state authority. Drizzle and Kysely both meet the query requirements. The foundation now exercises a concrete
schema and SQL migration instead of choosing on hypothetical future game queries.

## Decision

Use Drizzle ORM's `node-postgres` adapter and drizzle-kit SQL migrations. Schema definitions generate committed SQL,
snapshots and a journal; runtime applies those SQL files using the Drizzle migrator. This keeps the schema and
migration workflow together while preserving ordinary PostgreSQL queries and transactions. Kysely remains viable,
but adds no demonstrated benefit for this small schema and would require a separate schema-generation decision.

Row locks, compare-and-set and idempotent inserts remain explicit SQL (`sql\`\``, `.for('update')`,
`ON CONFLICT DO NOTHING`), never implicit ORM state. The first table is the game-agnostic `content_releases` registry;
boot records each content hash with `ON CONFLICT DO NOTHING` and an injected first-seen timestamp. No account,
character, ledger or ownership schema is introduced by this foundation.

The migration runner holds a PostgreSQL session advisory lock on its dedicated connection before initializing or
applying the journal, so concurrently booting roles cannot race migrations. Production runs the separate migration
command before process rollout. Startup migration is explicitly opt-in. Every server verifies exact migration
checksums/timestamps before accepting requests; an unapplied, edited or newer schema fails boot.

## Validation and acceptance gate

The checked-in integration suite creates a disposable real PostgreSQL database, races two migration runners,
replays the migration, verifies the journal and rolls back a real Drizzle transaction. It also boots the RPG server,
checks content identity, process role gating, injected timestamps, shutdown order and failed-boot pool cleanup. CI
runs this suite against PostgreSQL 16 on Node 22 and 24 and fails if its database URL is absent.

Local unit/type/lint checks can run without a database. They do not validate database semantics. The current agent
runtime cannot initialize a cluster because it runs as root and disallows switching user; move this ADR to Accepted
only after the required real-PostgreSQL CI checks pass.

## Consequences

Migrations are immutable once applied, reviewed as SQL, and versioned with the deployment. Clock, connection pool,
content verification and module lifecycle remain in `engine/server-kit`; RPG schema composition remains game-owned.
Switching query builders is still feasible while the schema is small. Jobs and database locks for game features are
separate feature work; choosing Drizzle does not replace the PostgreSQL source-of-truth or explicit ledger rules.
