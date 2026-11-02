# ADR-0012: Live instance hosting (in-house InstanceHost vs Colyseus)

- **Status:** Accepted (in-house `InstanceHost`)
- **Date:** 2026-11-01 (proposed) · 2026-11-02 (accepted after spike 3, #13)
- **Validation:** Spike 3 — `engine/live-kernel`, `engine/server-kit/src/live-host`, `games/rpg/apps/server/src/live`,
  throwaway comparison prototype (commit `10652c4`, removed from the workspace after the decision)

## Context
Live instances are stateful (in memory), need reconnection, crash recovery and, later, cross-node routing. They must
fit server authority (ADR-0002), the PostgreSQL-only infrastructure (ADR-0006), the activity lock and idempotency rules
(ADR-0007), the engine/game boundary (ADR-0017) and the generic `participants[]` model (phase 2 coop).

## Decision
- Live hosting is the in-house, game-agnostic **`InstanceHost`** in `@engine/live-kernel`. Games plug in a `LiveGame`
  (state, `applyCommand`, `tick`, `isTicking`, `removeParticipant`, `serialize`/`restore`, `view`); persistence plugs in an
  `InstanceStore`. Transport and PostgreSQL adapters live in `@engine/server-kit` (`createLiveHostModule`,
  `PostgresInstanceStore`). The RPG composes it with a combat plugin built on `@rpg/rpg-sim`.
- Each instance holds a **lease** in `live_instances` (`node_id`, `lease_generation`, `lease_expires_at`) and
  **checkpoints** (`checkpoint` JSONB + `checkpoint_seq`) only at game-requested boundaries — never per tick. Every write
  after creation is **fenced** on `(node_id, lease_generation, checkpoint_seq)` and an unexpired lease; a node whose
  fenced write fails evicts the instance immediately. Restores bump the generation.
- Creating an instance CASes every participant's `actors.activity_state` `none → live` (ascending actor ID, activity ID =
  instance ID) in the insert transaction; closing (and a participant leaving) CASes back in the same fenced transaction
  as the game's close hook, so settlement commits exactly once with the close or not at all.
- An encounter start is a checkpoint boundary ("pre-encounter checkpoint"): a crash mid-combat restarts that combat from
  its first tick on the next node, so a crash is never an escape from a fight.
- Ticks run only while `isTicking` (RPG: combat, 500 ms provisional) on a drift-free schedule (`due = previous due +
  interval`), with bounded catch-up after stalls. Exploration is command/response.
- Clients send commands (`live.command`, with `commandId` deduplicated per participant inside the instance and persisted
  with checkpoints) and receive sequenced pushes (`live.event` with `epoch` + `seq`). `live.attach` with the last seen
  `(epoch, seq)` replays exactly the missed events from a bounded buffer, otherwise sends a snapshot; a restore starts a
  new epoch. The socket is the existing authenticated `/auth/live` (one device per account via the fenced
  `live_sessions` lease); the host does not add a second socket.
- Disconnection does not pause anything; see open decision #5 for the confirmed policy.
- `live_instances` was initially owned by a separate optional migration set (`LIVE_HOST_MIGRATIONS`). It is now in the
  engine migration chain so all server roles verify the same persistence schema. The historical live-host migration
  and journal remain immutable upgrade evidence; migration preflight adopts their table only when journal and catalog
  shape match the expected legacy layout.

## Evidence (spike 3)
Adversarial integration tests (`games/rpg/apps/server/src/live/live.integration.test.ts`) run two live nodes (Fastify
servers) against one real PostgreSQL 16 database and one injected manual clock, with real WebSocket clients:

| Scenario | Result |
|---|---|
| Reconnect within grace with last `(epoch, seq)` | Exactly the missed events, contiguous, no duplicates; both clients converge on the server seq; replayed `commandId` → `duplicate: true`, applied once (1 encounter). |
| Disconnect at the start of a losing fight | Fight continues on automation, ends `defeated` inside the 60 s grace; activity released; one settlement row. |
| Node crash (no writes, lease not released) mid-exploration | Other node refused while the lease is valid (`instance_unavailable`); after expiry restores from the last checkpoint (epoch 2, same hero state); one settlement row; the dead node cannot restore or settle again. |
| Node crash mid-combat | `recoverExpired` sweep restores at combat tick 0 with enemies at full HP; the disconnected hero wins on automation on the new node. |
| Activity lock while live | CAS to `expedition` returns no row; a second instance throws `ActivityConflictError`; character mutation → 409 `busy`; a second device of the same account is refused with close code 4409; foreign accounts get `not_participant`. |
| Fencing | Replayed old `checkpoint_seq` refused; stale owner cannot checkpoint, renew, release a participant or close after a claim; a paused node is evicted on its next command and its client receives `live.evicted`. |
| Invariants (after every test) | Every `live` actor belongs to an active instance listing it; every non-left participant of an active instance is `live` in it; at most one settlement per instance. |

Unit tests (`engine/live-kernel`) cover the drift-free schedule under irregular wake-ups and bounded catch-up, dedupe
surviving a restore, resume vs snapshot, deferred leave until the ticking phase ends, and fencing, with an in-memory
store that has the PostgreSQL semantics. The RPG plugin tests check determinism and that a restored pre-combat
checkpoint replays the same fight.

Comparison with the Colyseus prototype (`spikes/live-colyseus` at commit `10652c4`; removed afterwards to drop its 83 packages and overrides — restore with `git checkout 10652c4 -- spikes/live-colyseus`; same room semantics with a counter stub):

| Criterion | In-house `InstanceHost` | Colyseus 0.18 |
|---|---|---|
| Effort for the spike semantics | ~1.1 k lines engine (host + types + store + transport) + ~170 lines RPG plugin | ~90 lines room, but without persistence, fencing or resume |
| Reconnection | Same `/auth/live` socket + `live.attach` with `(epoch, seq)`: missed events replayed or snapshot | Reconnection token + automatic client retry; full schema state resync, **missed broadcasts lost** (seq gap observed) |
| Command idempotency | Built in, persisted with checkpoints (survives restore) | None; hand-written in the room, in memory only |
| Lease / checkpoint / PostgreSQL | Native: fenced lease, checkpoints, activity CAS in the same transactions | Not provided: rooms live in process memory; leases and checkpoints would be hand-written around `onCreate`/`onDispose` anyway |
| Multi-node | PostgreSQL lease + generation fencing; any node can claim an expired instance. Routing a client to the owning node is still future work | Built-in multi-process presence/driver requires Redis (`@colyseus/redis-presence`/`redis-driver`), contradicting ADR-0006 |
| Testability | Injected `Clock`; 60 s grace / 30 s lease scenarios run in ~5 s deterministically | Room clock, simulation interval and reconnection timeout are real time only; tests must scale durations down |
| Dependencies | **0 new** third-party packages (reuses Fastify, `@fastify/websocket`, pg, Drizzle) | **+83 packages** (incl. Express 5 as an auto-installed peer); `@colyseus/core` releases every few days; 8 transitive releases younger than two weeks needed overrides; optional native `msgpackr-extract` build |
| Client footprint | Plain JSON over the browser `WebSocket`, no client library | `@colyseus/sdk` bundle 217 KB unminified (~67 KB gzip) |
| What Colyseus adds that we lack | Delta-encoded state sync, matchmaking, client prediction/input buffering — none needed for a turn-light, server-authoritative idle RPG with small states | |

**Decision rationale:** the parts that make live hosting safe here — fenced PostgreSQL ownership, checkpoint/restore,
activity locks in the same transactions, command idempotency and gap-free resume — are not provided by Colyseus and had
to be written either way; Colyseus would add a fast-moving 80+ package tree, a Redis-based scaling story and real-time-only
testing for features we do not need. The in-house host met every adversarial scenario with no new dependency.

## Consequences
- Node crash loses at most progress since the last checkpoint; an encounter in progress restarts from its start.
- After a crash, reconnection waits for the instance lease (30 s provisional) **and** the account's `live_sessions`
  lease (30 s) to expire; both fit inside the 60 s grace, and the grace restarts at restore.
- Live coop (phase 2) reuses the same host with `participants[]` (the spike already runs 2 participants).
- Known gaps (future work, not decided here): routing a client to the node that owns an instance (single live node or
  client retry until then); a recovery sweep job per live node (the module runs an in-process sweep); per-node instance
  limits/backpressure; run bag escrow and settlement through the ledger in the close/leave hooks (ledger PR pending);
  real exploration (travel, hotspots, loot, corpses) in the RPG plugin; a real `kill -9` process test (the spike's crash
  drops the host without writes, which leaves the same database state).
- The Colyseus prototype is throwaway and can be deleted, together with its `pnpm-workspace.yaml` overrides, once this
  evidence is no longer needed.
