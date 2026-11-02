# RPG server

Fastify composition root over `@engine/server-kit`. Generic infrastructure stays in the engine; this app validates
compiled RPG schemas and references, and composes content metadata, authentication, character APIs and worker
command maintenance. API processes serve auth/characters/expedition routes; live processes serve authenticated
WebSocket commands; workers settle persisted expeditions and compact expired command responses. Expedition precompute
runs in the authenticated command transaction and uses only the shared deterministic simulator; it does not start a
live combat session.

From the repository root, with a running PostgreSQL database:

```sh
pnpm content-cli build games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts --out dist/rpg-content.json
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/idle_rpg
export CONTENT_BUNDLE_PATH="$PWD/dist/rpg-content.json"
pnpm --filter @rpg/server db:migrate
pnpm --filter @rpg/server start
```

Node must support built-in TypeScript stripping (Node 22.18+ or 24). The same executable supports `ROLES=api`,
`ROLES=live` or `ROLES=worker`. `GET /content` is API-only and exposes `{ game, format, contentHash }`; it does not
publish a bundle containing server-only tables. `/health/live` and `/health/ready` are available for every role.
Run at least one `ROLES=worker` process for scheduled expedition settlement. Start inserts its settlement wake-up in the
same PostgreSQL transaction as escrow, activity lock, snapshot, and timeline. Authenticated API reads also settle lazily
once the actual end is reached.

Pass `clock` and explicit `modules` to `createRpgServer` for application composition and tests. Game services read
time through the supplied `Clock`; direct `Date.now()` is confined to engine `SystemClock`. Runtime imports contain
no compiler/build-plugin dependency: the compiler is a dev dependency used only to test real build/boot parity.

See [server-kit](../../../../engine/server-kit/README.md) for all configuration, module and migration contracts.

## Identity and game commands

Guest/email credentials, HTTP/WS session rotation and the reject-second live policy are documented in
[auth](../../../../engine/server-kit/src/auth/README.md). Email/password upgrade preserves the account and actor;
it does not verify email ownership or provide recovery. [Character contracts](src/characters/README.md) describe
the provisional starter kit, ownership and transaction-scoped activity guards.

Authenticated mutations require a client-generated UUID and the shared command envelope. For example,
`POST /characters` takes:

```json
{ "command_id": "a80ff78a-0535-448b-a3d2-11214ab78f76", "operation": "character.create", "payload": { "name": "Hero" } }
```

`PATCH /characters/:actorId/configuration` uses operation `character.configure`, with configuration in `payload`.
On `/auth/live`, wait for the authenticated acknowledgement and send
`{ "type": "command", "command": { "command_id": "...", "operation": "character.configure", "payload": { "actorId": "...", "configuration": { "name": "Hero" } } } }`.
HTTP normalizes the route actor ID into the same payload as WS before fingerprinting. A retry across transports
returns the same response without another mutation. Incompatible key reuse is 409; an expired retained key is 410.
Authentication handshakes never put credential responses in the game command log.

Cookie-backed browser requests enforce same-origin checks (use a development proxy for the web app). Native clients
can use Bearer credentials. Configure the auth module's explicit allowed origins when composing a trusted TLS/CDN
deployment; the server does not enable wildcard CORS.

## Migration ownership

The game migration command applies and verifies the engine journal first (`drizzle`) and the game-owned RPG journal
second (`rpg_migrations`). `createRpgDatabase`, server startup, tests and CLI use the same migration sets. Generate
RPG SQL with `pnpm --filter @rpg/server db:generate`; engine generation remains in `@engine/server-kit`.
The engine never imports a game schema. Never modify already applied migrations.

## Expedition lifecycle

The API exposes authenticated `GET /characters/:actorId/expedition-options`, `GET /characters/:actorId/expeditions`,
`GET /expeditions/:expeditionId`, `POST /expeditions`, and `POST /expeditions/:expeditionId/cancel`. Start and cancel
POSTs use the shared command envelope and `expedition.start` / `expedition.cancel` operations; HTTP and WebSocket
commands share ownership checks, idempotency, and the same transaction dispatcher. Start payloads contain one owned
`actorId`, a kernel request (`areaId`, `activityId`, `durationMin`, `paceBp`), and RPG config (`consumables`, `retreat`).
Supported durations are 15, 30, 60, and 180 minutes; pace is fixed at 10,000 bp until other pace values are accepted.

The response only contains revealed segments. The actual end and simulator outcome appear after that end is reached.
Early cancellation saves the kernel's cutoff and cancellation timestamp; later reads continue to return that same
prefix, with `outcome: "cancelled"`, never a hidden future death or natural end. `cancelPreview` is computed from the
same kernel settlement rules used by cancellation.

World completion input comes only from server-recorded `rpg_area_discoveries`, `rpg_completed_areas`, and
`rpg_actor_objectives`. `expeditions/progress.ts` exposes internal transaction seams for trusted exploration/conquest
systems; there is no client endpoint for setting completion. Until the conquest system (#47) writes those records,
areas with completion rules remain locked for new characters; areas without a completion rule follow the kernel's
open-area behavior.

Persisted runs record kernel/simulator versions, content hash, seed, parsed config, participant snapshot, and compressed
timeline. The worker checks those versions before settlement and returns a retryable `expedition_version_unavailable`
error rather than applying rewards with changed rules. This release does not retain old simulator code/content bundles;
deployment must keep compatible code and content available for unsettled runs or drain them before an incompatible
upgrade. The XP curve is included in the snapshot. Equipped items are resolved from server ledger definitions; non-empty
instance roll data is rejected until RPG stat-roll semantics are defined.
