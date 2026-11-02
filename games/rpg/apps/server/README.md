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

The worker runs a recurring read-only ledger audit through `PostgresJobs`. It compares ledger history with materialized
balances on one repeatable-read snapshot, logs invariant codes/counts without repairing data, and reschedules one window
ahead even when it finds an inconsistency. `RPG_LEDGER_AUDIT_INTERVAL_MS` configures the interval (default 86,400,000 ms;
minimum 1,000 ms, maximum 365 days). Window-keyed durable schedules prevent duplicate audits across worker restarts
and processes, and downtime skips missed windows rather than replaying an unbounded backlog.
The engine never imports a game schema. Never modify already applied migrations.

## Expedition lifecycle

The API exposes authenticated `GET /characters/:actorId/expedition-options`, `GET /characters/:actorId/expeditions`,
`GET /expeditions/:expeditionId`, `POST /expeditions`, `POST /expeditions/:expeditionId/cancel`, and
`POST /expeditions/:expeditionId/recover-unavailable`. Start, cancel and recovery POSTs use the shared command envelope
and `expedition.start`, `expedition.cancel` or `expedition.recoverUnavailable` operations; HTTP and WebSocket
commands share ownership checks, idempotency, and the same transaction dispatcher. Start payloads contain one owned
`actorId`, a kernel request (`areaId`, `activityId`, `durationMin`, `paceBp`), and RPG config (`consumables`, `retreat`).
Supported durations are 15, 30, 60, and 180 minutes; pace is fixed at 10,000 bp until other pace values are accepted.

The response only contains revealed segments. The actual end and simulator outcome appear after that end is reached.
Early cancellation saves the kernel's cutoff and cancellation timestamp; later reads continue to return that same
prefix, with `outcome: "cancelled"`, never a hidden future death or natural end. `cancelPreview` is computed from the
same kernel settlement rules used by cancellation.

World completion input comes only from server-recorded `rpg_area_discoveries`, `rpg_completed_areas`, and
`rpg_actor_objectives`. `expeditions/progress.ts` exposes internal transaction seams for trusted exploration/conquest
systems; there is no client endpoint for setting completion outside the non-production
[debug tools](#debugadmin-tools-non-production-only). Until the conquest system (#47) writes those records,
areas with completion rules remain locked for new characters; areas without a completion rule follow the kernel's
open-area behavior.

Persisted runs record kernel/simulator versions, content hash, seed, parsed config, participant snapshot, escrow and
compressed timeline. Settlement policy is selected from the server-owned, append-only registry by the persisted kernel
version, simulator ID and simulator version. The retained `0.3.0` / `rpg-idle@2.0.0+rpg-sim@1.1.0` adapter uses frozen
settlement, summary and progression rules plus the persisted escrow; reads and settlement do not depend on the current
content hash or whether the activity still exists in the current bundle. Add a new policy entry when behavior changes;
never replace an old tuple. The XP curve is included in the snapshot.

If a running expedition has no registered policy, reads and history remain available as a minimal metadata view
(`segments: []`, no outcome, and `recoveryAvailable: true`); lazy settlement waits for an operator/player recovery
instead of decoding an unknown timeline or applying current/default rules. The owner can call
`POST /expeditions/:expeditionId/recover-unavailable` with
`{ "command_id": "<uuid>", "operation": "expedition.recoverUnavailable", "payload": { "expeditionId": "<uuid>" } }`.
That idempotent operation only accepts an unregistered tuple, returns the exact persisted escrow to its recorded source,
releases the activity lock, awards no loot or XP, and persists a terminal `escrow_returned` report in the same transaction.
Use a fresh command UUID for a new recovery attempt; replays return the original response. New expedition starts require a
registered policy before escrow or activity changes. Terminal reports preserve the revealed prefix, summary, settled
ledger deltas and XP accounting; terminal legacy rows without a report are returned with `terminalReport: null` and a
timeline projection without a reconstructed settlement claim when the old timeline remains readable; otherwise history
returns an empty safe prefix with `terminalReport: null`. History is limited to the 20 newest rows, ordered by creation
time and ID. Equipped items are resolved from server ledger definitions; non-empty instance roll data is rejected until
RPG stat-roll semantics are defined.

## Expedition estimates (#53)

`POST /characters/:actorId/expedition-estimate` with body `{ request: { areaId, activityId, durationMin, paceBp },
config: { consumables, retreat } }` (parsed by `@rpg/protocol` `parseExpeditionEstimateRequest`; no actor, stats or
seed fields are accepted) returns `ExpeditionEstimateDto`: `{ estimate: true, actorId, areaId, activityId, durationMin,
paceBp, n, xp, gold, consumablesUsed[], outcomeRatesBp: { completed, retreated, died }, cached }`, where `xp`, `gold` and
each consumable row are nearest-rank `{ p10, p50, p90 }` over `n` runs. XP is gross (before a death penalty); gold is
what the natural end grants (after the death bag loss); rates are floored basis points. It is not a command and is
read-only: a short transaction checks ownership and reads the snapshot through the same `readStartSnapshot` and
`gateStart` as `start` (so the same `start.*`/`rpg.*`/`invalid_pace` errors apply), plus `insufficient_consumables`
(409) when the inventory cannot cover the requested consumables. It writes no ledger, activity, expedition or job rows.
`503 estimate_busy` is returned when 8 distinct estimates are already computing.

- **Sampling** (`estimate-samples.ts`): the kernel `estimate` with the RPG metrics extractor, split into 4 fixed chunks
  (chunk `k` uses root seed `deriveSeed(rootSeed, 'estimate-chunk', k)`), so the result never depends on the worker count.
  `rootSeed` is derived from the cache key (SHA-256), never from a start seed; real starts draw theirs from
  `crypto.randomBytes`, so estimates cannot predict a start.
- **Run count** (`estimate-key.ts`): `n = clamp(⌊5000 / budget⌋, 60, 200)` (provisional). Region 1 hunt: 15 min → 200,
  30 min → 200, 60 min → 166, 180 min (90 segments) → 60. Cost is about 0.3 ms per segment, so a cold estimate stays
  under the spike-1 budget of 2 s even on one core.
- **Worker pool** (`estimate-runner.ts`, `estimate-worker.ts`): `node:worker_threads`, `clamp(cores − 1, 1, 4)` workers
  started lazily, each loading the content bundle once. The event loop never runs the simulation.
- **Cache** (`estimate-cache.ts`): in-process LRU of 512 results plus single-flight de-duplication of identical in-flight
  requests; no time-based expiry, since the key covers every input of a deterministic result. Key = SHA-256 of the
  canonical JSON `{ model, kernelVersion, simulatorId, simulatorVersion, contentHash, areaId, activityId, durationMin,
  paceBp, runs, buildHash, rulesHash, configHash }` (build = snapshot without rules; consumables sorted by item). Bump
  `ESTIMATE_MODEL_VERSION` when sampling or aggregation changes. A Postgres table was not added: results are cheap to
  recompute, need no cross-process consistency, and a per-process cache needs no migration; revisit if several API
  processes make cold misses common.

Measured (dev container, 4 vCPU Xeon @ 2.10 GHz, Node 22.23.4; `RPG_ESTIMATE_BENCH=1 pnpm exec vitest run --project
@rpg/server expeditions/estimate.bench --silent=false`, Bulwark L4 Region 1 hunt with potions, no deaths so every run
costs the full budget):

| Duration | Budget | n | Inline (1 thread) | Pool, threads not started | First miss after boot warm-up | Pool warm | Cache hit |
|---|---|---|---|---|---|---|---|
| 15 min | 7 | 200 | 544 ms | 724 ms | 362 ms | 310 ms | 0.03 ms |
| 30 min | 15 | 200 | 975 ms | 1 020 ms | 649 ms | 460 ms | 0.02 ms |
| 60 min | 30 | 166 | 1 486 ms | 1 259 ms | 1 040 ms | 734 ms | 0.02 ms |
| 180 min | 90 | 60 | 1 737 ms | 1 295 ms | 1 061 ms | 796 ms | 0.03 ms |

The server starts the worker threads at boot (`warmUp`), so the "first miss after boot" column is what a player sees on
the first cache miss. Under contention from other processes (load average about 4 on 4 cores) the same bench
measured up to 1.75 s for a first miss and 2.3 s when threads had not been started yet; numbers vary by about 1.5x on
this shared hardware. Through HTTP on the same machine, a cached estimate answered in about 15 ms (snapshot read
included). The validation test
(`estimate.test.ts`) compares 200 independent runs with fresh seeds against the estimate: 84.5 % of actual XP and
81.5 % of actual gold fall within [p10, p90], and the death rate matches within 3 points.

## Debug/admin tools (non-production only)

QA and development builds can enable authenticated debug endpoints (issue #31) to grant assets, set level/XP, record
or reset world progress, and fast-forward time. They are **off by default** and refuse production configuration.

### Enabling

```sh
export RPG_DEBUG_TOOLS=1   # or true; 0/false/unset disables
export APP_ENV=qa          # must be one of development, test, qa, staging
pnpm --filter @rpg/server start
```

Compositions pass `createRpgServer(config, { debug: parseRpgDebugToolsConfig(process.env) })` (as `main.ts` does) or a
literal `{ enabled, environment, nodeEnv? }`. Safety guard:

- Disabled (the default): the `debug` module and time-travel clock are not composed; every `/debug/*` route is 404.
- Enabled with `APP_ENV=production`/`prod`, `NODE_ENV=production`, or an `APP_ENV` outside the allowlist (including
  unset): `parseRpgDebugToolsConfig`/`createRpgServer` throw `DebugToolsRefusedError` and the server does not boot.
  Module registration re-checks the guard. A malformed `RPG_DEBUG_TOOLS` value also fails the boot.
- Every route requires the normal session (`requireAccount`) and same-origin rules. Character routes act only on an
  actor owned by the caller (others are 404) and, like other Sanctuary edits, refuse a busy actor (`409 busy`).
- Mutations use the shared command envelope and `runCommand`, so each `command_id` applies once and retries replay the
  stored response. They are HTTP-only (no WebSocket operation).

### Endpoints

| Method and path | `operation` | Payload |
|---|---|---|
| `GET /debug/clock` | none | returns `{ nowMs, offsetMs, maxAdvanceMs, maxOffsetMs }` |
| `POST /debug/clock/advance` | `debug.clock.advance` | `{ durationMs }` (1 ms to 24 h) |
| `POST /debug/characters/:actorId/grants` | `debug.grant` | `{ actorId, gold?, items?: [{ item, qty }] }` |
| `POST /debug/characters/:actorId/progression` | `debug.setProgression` | `{ actorId, level, xp? }` (`xp` is XP within the level) |
| `POST /debug/characters/:actorId/world-progress` | `debug.recordWorldProgress` | `{ actorId, completedAreas?, discoveries?: [{ areaId, locationId }], objectives? }` |
| `POST /debug/characters/:actorId/world-progress/reset` | `debug.resetWorldProgress` | `{ actorId, areaId? }` |

- **Grants** go only through `applyLedgerDeltas` with `source_type = debug_grant` and source ID
  `<accountId>:<command_id>` (a second idempotency layer). Item IDs are validated against content: equipment
  definitions mint unique instances (`unique_mint`, at most 10 per grant), everything else is a stack in `inventory`;
  `gold` is the `gold` currency. The response includes the actor's holdings.
- **Set level/XP** validates against the content XP curve (level at most the cap, `xp` below the level's requirement
  except at the cap) and requires activity `none`. It changes only `level`/`xp`: attributes and unspent points are
  untouched (open decision #13).
- **World progress** validates area/location/enemy IDs and writes through the trusted `expeditions/progress.ts` seams
  (`recordAreaCompletion`, `recordDiscovery`, `recordObjective`). Recording `area:region_1` completion unlocks Region 1
  idle activities for that character. It records facts only; conquest rules are not evaluated (#47). Reset with
  `areaId` removes that area's discoveries and completion; without it, all discoveries, completions and objectives.

### Time travel

The app clock becomes `TimeTravelClock` = base clock + an **environment-wide**, forward-only offset persisted in
`rpg_debug_clock` (RPG migration `0004_debug_clock`, one row). Every process with the tools enabled (API, live and
worker roles) re-reads the offset every second; the API process that advances applies it immediately. Each advance is
1 ms to 24 h; the accumulated offset is capped at 30 days. The offset cannot go back: use a fresh database to rewind.

QA flow for a 180-minute expedition: record `area:region_1` completion, optionally grant consumables, start the run,
then `POST /debug/clock/advance` with `{ "durationMs": 10800000 }`. Within about two seconds (offset refresh plus the
worker poll interval) the settlement job is promoted by app time and settles the run; any authenticated expedition
read also settles it lazily. Rewards are applied once (the settlement ledger source is idempotent).

The offset is per environment rather than per account on purpose: jobs, leases, sessions and command retention all
compare against one app clock, and per-account time would break those shared invariants (a job or lease cannot be
due for one account and not another). Consequences:

- Everyone on the environment travels together; other testers' expeditions also reach their end.
- Auth sessions (12 h TTL) and retained command responses (24 h) expire by app time; after large jumps, sign in again.
- Live instance leases and grace periods use the same clock, so an advance can expire running live instances' leases
  and hand them to recovery.
- pg-boss retry delays and PostgreSQL `NOW()` are not shifted; only app-clock deadlines are.
- Processes started without the tools enabled ignore the offset; enable the flag on every role of the environment.
