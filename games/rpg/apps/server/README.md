# RPG server

Fastify composition root over `@engine/server-kit`. Generic infrastructure stays in the engine; this app validates
compiled RPG schemas and references, and composes content metadata, authentication, character APIs and worker
command maintenance. API processes serve auth/characters; live processes serve authenticated WebSocket commands;
workers compact expired command responses. Ledger, conquest, expedition hosting, exploration, party and durable job
execution remain separate modules. No gameplay simulation is run by the authentication socket.

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
