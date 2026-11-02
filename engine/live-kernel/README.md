# @engine/live-kernel

Game-agnostic live instance hosting ([ADR-0012](../../docs/adr/0012-live-instance-hosting.md)). No transport, no
database and no game concepts: games plug in a `LiveGame`, persistence plugs in an `InstanceStore`. The PostgreSQL
store and the WebSocket transport live in [`@engine/server-kit`](../server-kit/README.md#live-instance-hosting).

## `LiveGame<S>` (game plugin)

| Member | Contract |
|---|---|
| `id`, `version` | Stored with each instance; a node refuses to restore a checkpoint from another game version or content hash. |
| `tickIntervalMs` | Tick period while ticking (RPG combat: 500 ms, open decision #1). |
| `init({ instanceId, participants, seed, setup })` | Initial state. `seed` is a server-generated uint32; `setup` is prepared by the composition root. |
| `applyCommand(state, actorId, command)` | Untrusted input → `{ rejected }` or a `LiveStep` (`state`, `events`, `checkpoint?`, `close?`). |
| `tick(state)` / `isTicking(state)` | Ticks happen only while `isTicking`. Automation acts for every participant, connected or not. |
| `removeParticipant(state, actorId)` | Called when a participant's grace expired; return `null` to defer (e.g. mid-encounter). |
| `serialize` / `restore` / `view` | Checkpoint JSON, restore from it, client snapshot. |

Plugins must be deterministic and must not mutate inputs. Request `checkpoint: true` only at meaningful boundaries
(location change, encounter start/end, loot pickup, discovery). A checkpoint at an encounter start is the
pre-encounter checkpoint: a crash restarts that encounter from the beginning.

## `InstanceHost<S>`

One per process (node). Per instance, commands, ticks, grace handling and persistence run strictly serialized.

- `create({ participants, setup })` — the store CASes every participant `none → live` and inserts the instance with
  a lease and checkpoint 0, atomically (`ActivityConflictError` if anyone is busy).
- `attach(instanceId, actorId, accountId, connection, resume?)` — binds a connection; sends exactly the events after
  `resume.seq` when `resume.epoch` matches and they are still buffered, else a `live.snapshot`.
- `detach(...)` — the participant becomes `disconnected` with a reconnection grace (default 60 s, open decision #5).
  Nothing pauses. After the grace: `leaving` (until `removeParticipant` accepts), then `left` with its lock released.
  All participants left → close `abandoned`.
- `submit(instanceId, actorId, accountId, commandId, command)` — at most once per `(actorId, commandId)`; replays get
  the stored ack with `duplicate: true`. The dedupe memory (bounded) is persisted with every checkpoint.
- `pump()` — advances every instance to the clock's time: due ticks on a drift-free schedule (`due += interval`, at most
  `maxCatchUpTicks` per pump, then skip ahead), grace expiry, deferred leaves and lease renewal (every third of the
  lease). `start()` runs it on timers; tests call it with a manual clock.
- `recover(instanceId)` / `recoverExpired(limit)` — claim instances whose lease expired and restore their last
  checkpoint on this node (new event epoch = lease generation; every participant restarts disconnected with a fresh grace).
- `stop()` — graceful shutdown: expires leases immediately (last checkpoint kept) so another node can restore at once.
- `abandonForTesting()` — simulates a crash: forgets everything without any write.

Fencing: any store write returning `false`/`null` means another node owns the instance; the host evicts it at once and
pushes `live.evicted` to its connections. A node also re-validates its lease before acting once its locally known
lease has run out (e.g. after a long pause).

Events pushed to connections: `live.snapshot`, `live.event` (`epoch`, `seq`, `source: game|host`, `event`),
`live.closed`, `live.evicted`. Host events are participant status changes.

`MemoryInstanceStore` is a reference store with the same fencing semantics, for unit tests and multi-node simulations.
