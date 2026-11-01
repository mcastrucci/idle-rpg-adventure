# RPG server

Fastify composition root over `@engine/server-kit`. Generic infrastructure stays in the engine; this app validates
compiled RPG world/entity/XP schemas and installs the API content-version module. Auth, ledger, character, conquest,
expeditions, live hosting, party and job execution are separate future feature modules, with explicit typed lifecycle
boundaries already available. Worker/live-only processes expose health routes; they acquire domain functionality
when their real feature modules are installed.

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
