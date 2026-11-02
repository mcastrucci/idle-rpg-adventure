# Authenticated game command idempotency

`runCommand(database, clock, accountId, envelope, handler, options?)` is the shared HTTP and WebSocket transaction
boundary. Authenticate the request and authorize the account, route, actor, and operation before calling it, including
for replays. Validate the operation-specific payload first. The RPG protocol accepts the strict wire envelope
`{ command_id: UUID, operation, payload: object }` and `parseCommandEnvelope` returns the internal `commandId` spelling.
Only explicitly listed protocol operations are accepted; the reserved `inventory.usePotion` identifier has no production
handler. Credential bootstrap, login, and session renewal are separate authentication handshakes: the account is not
known before login and credential-bearing responses must never enter this command log.

The handler receives a Drizzle transaction and returns `{ status, body }`. All durable changes must use that transaction.
Store only public JSON game results, never passwords, tokens, cookies, or credential DTOs. An exception (including an
invalid response) rolls back both the command reservation and its mutations; a later retry can execute again. Explicitly
returned domain error results are committed and replayed just like other results. External effects cannot be made atomic
by this transaction; use a transactional outbox when such effects are introduced. This module is not the ledger or job
queue and does not implement inventory or potion routes.

The composite `(account_id, command_id)` key serializes concurrent requests across processes. PostgreSQL's default READ
COMMITTED isolation and `INSERT ... ON CONFLICT DO NOTHING` let one transaction own a new command; competitors wait for
its commit or rollback before observing its result. Keep the default isolation level when using this helper. The
operation and a server-computed SHA-256 of canonical payload JSON detect incompatible key reuse with HTTP/WS status 409
and `{ error: 'command_id_conflict' }`. Normalize all route targets into that payload before hashing: for example,
`{ actorId, configuration }` for an actor update. Operation and account are separate stored key/fingerprint dimensions.
Clients supply no fingerprint. Object key order is immaterial; array order and JSON values are significant. Both request
and response JSON reject unsupported JS values, cycles, accessors, hidden properties, sparse arrays, non-finite numbers,
and custom prototypes, and are bounded to 64 KiB UTF-8, 10,000 nodes, and depth 32. The protocol parser makes a detached,
frozen copy; the runner independently validates its input at the server boundary.

The mutation and exact canonical JSON response text/status commit atomically. Losing an HTTP response or disconnecting
a socket after commit therefore preserves the side effect: a retry returns the stored result without running the handler.
Response metadata such as transport headers is outside this contract. Handlers must not put volatile response data in
headers that is needed for replay.

Responses are retained for 24 hours by default (`COMMAND_RETENTION_MS`), matching the data-model proposal; a caller may choose a positive retention up to
90 days. Expiry uses the injected clock and starts at initial admission. An expired matching command returns status 410
and `{ error: 'command_expired' }`, even before cleanup. An expired mismatching command still returns 409. Expiry never
means permission to execute the command again. Do not delete command keys as a TTL cleanup strategy.

`cleanupExpiredCommands(database, clock, batchSize = 100)` compacts at most 1,000 rows per invocation using the partial
expiry index and `FOR UPDATE SKIP LOCKED`. It clears response text/status and retains the account/key, operation,
fingerprint, timestamps, and a permanent tombstone. Replay row locks serialize with cleanup; new uncommitted commands
are invisible to maintenance. Tombstones remain until the owning account is deleted, at which point account authorization
prevents further commands under that identity. Storage therefore grows with unique admitted commands per account; this is
the deliberate cost of preventing an arbitrarily late retry from repeating an economic mutation. Permanent key retention
must be preserved if future archival or partitioning is introduced.

`createCommandMaintenanceModule({ intervalMs?, batchSize? })` provides the `commands` worker module. It runs one bounded
batch at boot and each interval (default 60 seconds), never overlaps its own batches, reports errors through the server
logger, and drains any in-flight batch before database shutdown. Separate workers can safely run together. This small
maintenance loop is not a durable job queue.

`commands.test.ts` exercises real PostgreSQL transactions against an isolated test database, using a fixture stock table
and an actual SQL decrement. It covers duplicate races across pools, rollback, replay after response loss, account
isolation, payload/operation conflict, expiry/tombstones, bounded cleanup, and a shared HTTP/decoded-WebSocket dispatch.
Set `TEST_DATABASE_URL` to a PostgreSQL connection with CREATEDB permission. Tests create/drop a unique disposable database;
they do not clear the supplied database. CI must set this variable; persistence tests deliberately skip locally when absent.
