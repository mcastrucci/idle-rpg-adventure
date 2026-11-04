# Spike 3 report: live instance hosting and economy integrity under adversarial tests

- **Issue:** [#13](https://github.com/mcastrucci/idle-rpg-adventure/issues/13) (epic M0, [#1](https://github.com/mcastrucci/idle-rpg-adventure/issues/1))
- **Validates:** [ADR-0012](../adr/0012-live-instance-hosting.md) (live hosting), [ADR-0007](../adr/0007-ledger-and-activity-lock.md)
  (ledger and activity lock), the anti-exploit checklist in [rewards-and-persistence §8](../spec/rewards-and-persistence.md).
- **Outcome:** every adversarial scenario of the issue now has evidence on real PostgreSQL that runs in CI, and the
  seeded fuzz test closes the last open criterion (zero invariant violations under fuzzing). No bug was found.

## Decision summary

- ADR-0012 is **Accepted**: live hosting is the in-house, game-agnostic `InstanceHost` (`@engine/live-kernel`) with a
  PostgreSQL lease, fenced checkpoints, activity-lock CAS in the same transactions, persisted command idempotency and
  sequenced, gap-free resume. Colyseus was prototyped and rejected (no persistence/fencing/idempotency, Redis for scaling,
  +83 packages, real-time-only tests). See the ADR for the comparison.
- Open decision #5 (disconnect policy) was confirmed/amended before this report; it is not changed here.
- This report adds the remaining evidence for the economy side of the same spike: the ledger and activity lock hold under
  concurrent, replayed and raced player commands.

## Coverage map

All tests below use `describe.skipIf(!TEST_DATABASE_URL)` and, under `CI`, throw if `TEST_DATABASE_URL` is missing, so on
GitHub Actions (`postgres:16` service, `pnpm check`, Node 22 and 24) every one of them runs on real PostgreSQL. Locally
they skip without the variable. "New" marks evidence added by this report.

| Adversarial item | Evidence (file, test) | Real PostgreSQL in CI | Gap before this report |
|---|---|---|---|
| Reconnect within grace window | `live/live.integration.test.ts` "reconnect within grace: missed events delivered once, consistent state, replayed command_id applies once"; "disconnecting during a losing fight still ends in death (no pause exploit)". `live/death.integration.test.ts` "still applies the durable death penalty when the player disconnects during a losing fight". `engine/live-kernel` unit tests (resume vs snapshot, deferred leave; in-memory store, not PostgreSQL). The integration tests use real WebSocket clients and two nodes | Yes | None |
| `kill -9` the server mid-combat, restore from checkpoint | `live/process-crash.integration.test.ts` "SIGKILL midcombat; replacement restores tick zero and settles one victory reward" and "SIGKILL after exploration discovery and victory checkpoint; refuses early takeover, then recovers rewards and returns once" (forked server processes, real `SIGKILL`). Simulated crash (no writes, lease unreleased): `live/live.integration.test.ts` "crash mid-exploration ..." and "crash mid-combat ..." | Yes (child processes are forked from the test; needs only Node and PostgreSQL) | None (ADR-0012 listed the real `kill -9` as future work; #113 closed it) |
| Double-spend a potion concurrently | `expeditions/expeditions.integration.test.ts` "serializes competing starts for the last healing potion and never escrows it twice"; `inventory/inventory.integration.test.ts` "moves the last stack unit at most once under concurrent move commands", "serializes concurrent purchases against one balance and never drives gold or a stack below zero", "keeps purchase and expedition escrow concurrent loads ledger-consistent"; `engine/server-kit/src/ledger/ledger.integration.test.ts` "serializes last-unit consumption across pools and never commits a negative balance"; `live/rewards.integration.test.ts` "snapshots real equipped gear and carried potions, consumes only a carried potion, and preserves the unused one" | Yes | Only two-way races between one pair of consumers. **New:** the fuzz races the last potion between two expedition starts, a live start with supplies and a storage move, in shuffled order, every round |
| Start an expedition while in live | `live/live.integration.test.ts` "live holds the activity lock: no expedition, ..." (CAS `none -> expedition` returns no row; second instance throws `ActivityConflictError`); `inventory/inventory.integration.test.ts` "blocks every inventory mutation while live or on expedition, while own reads still work"; `live/entry.integration.test.ts` "serializes same-key and start-vs-idle races to one durable instance per actor" | Yes | The expedition side was tested at the CAS level, not through `POST /expeditions`. **New:** the fuzz sends the real HTTP expedition start (and buys, moves, equips, a second live start) while the actor is live and requires 409 `busy` or `activity_conflict`, and races live start against expedition start on one actor |
| Two devices on one account | `live/live.integration.test.ts` "live holds the activity lock: ..., one device per account" (second session closed with 4409 while the first holds the `live_sessions` lease); `engine/server-kit/src/auth/auth.integration.test.ts` (live session lease acquire/renew/release) | Yes | None for the live socket. The concurrent REST case (same account, several in-flight commands on one actor) is exercised by the fuzz, where all requests of one player race through different command ids |
| Replay the same `command_id` | `engine/server-kit/src/commands/commands.test.ts` (racing duplicates, payload/operation reuse, rollback, 410 tombstones); `inventory/inventory.integration.test.ts` "replays one HTTP purchase through a real authenticated WebSocket and rejects a changed command payload", "replays a confirmed purchase after the server content price changes"; `expeditions/expeditions.integration.test.ts` "requires persisted conquest, keeps start replay exact ..."; `live/entry.integration.test.ts` "replays the exact durable start after close, rejects changed payload, and preserves a tombstone conflict"; `live/live.integration.test.ts` reconnect test (live `commandId`); `engine/server-kit/src/ledger/ledger.integration.test.ts` "replays a batch once ..." | Yes | Replays were tested per operation. **New:** the fuzz replays random earlier commands of every kind (identical payload: same status and body; changed payload: 409 `command_id_conflict`) and races two identical cancel commands |
| Run settlement twice | `expeditions/expeditions.integration.test.ts` "settles at the exact early end through lazy read and the real PostgreSQL worker only once, including death penalty and bag loss", "survives concurrent settlement retries across many persisted seeds with ledger invariants intact"; `expeditions/deployment.integration.test.ts` "recovers an unknown simulator tuple by returning exact escrow once ... across job and cancel races"; `live/rewards.integration.test.ts` "rolls back bank and close together ...", live close settles once (`live.integration.test.ts`) | Yes | Fixed seeds and fixed timings. **New:** the fuzz moves the clock to, or just past, a random expedition's end and races lazy `GET`, list, two `settleJob` calls, a cancel with a replayed command id and the real `pgboss` worker, then checks one settlement batch per expedition |
| Ledger invariant checker (sum of ledger equals balances, no negatives) | `engine/server-kit/src/ledger/ledger.integration.test.ts` "checks invariants with empty and multi-actor UUID arrays"; `inventory/ledger-audit.integration.test.ts` "detects corruption, scans atomically during concurrent ledger writes, and continues scheduling future windows" (periodic job); `checkLedgerInvariants` is asserted at the end of most economy tests | Yes | **Missing: zero violations under fuzzing** (success criterion; checklist item "Ledger invariant checker passes after fuzzing"). **New:** `adversarial/economy-fuzz.integration.test.ts` |

Additional checklist items from rewards-and-persistence §8 (not part of the issue list, listed for completeness): "cannot use
or sell an escrowed consumable" (inventory tests with escrow; `inventory.integration.test.ts` "rejects non-owned, active,
storage-only, and non-material sale requests ..."; the fuzz also tries to sell potions, which must always be refused),
"cancelling after the actual end cannot skip the death penalty" (expeditions test above, plus the fuzz cancel-at-end race),
"no endpoint accepts client-computed rewards" (inventory test "prices offers from server content, ignores/rejects forged
client prices ..."; strict payload schemas). Material sales (#114, merged while this report was written) are covered by
`inventory.integration.test.ts` "serializes concurrent sales of the same stack so fresh command IDs cannot oversell" and are
part of the fuzz mix.

## Seeded economy fuzz

File: `games/rpg/apps/server/src/adversarial/economy-fuzz.integration.test.ts` (two tests).

**Setup.** One Fastify node (`api` + `live` roles) with an in-process `InstanceHost`, plus a second Fastify instance with the
`worker` role, which runs the real PostgreSQL job queue. Both share one manual clock and one fresh PostgreSQL 16 database
with the real migrations and the real Region 1 content. Six players start with 160 gold, 3 potions, 2 swords, 8 glowcap and 8 amber resin and a
persisted Region 1 completion; one more fresh player is created per round for the last-potion race.

**Seed.** A 32-bit mulberry32 seed is drawn at random per run, printed as
`economy fuzz: seed=<n> ... (reproduce with ECONOMY_FUZZ_SEED=<n>)` and included in every failure message. Override it
with `ECONOMY_FUZZ_SEED`, and scale the run with `ECONOMY_FUZZ_ROUNDS` (default 30) and `ECONOMY_FUZZ_OPS` (default 20).
The seed fixes the generated operations and the simulation seeds; PostgreSQL and the event loop decide the interleaving, so a
failing seed is a strong lead but not a byte-exact replay.

**One round (30 rounds by default, 600 random operations plus scenarios).**

1. *Last-potion race* on a fresh actor with exactly one potion: two expedition starts, a live start with the potion as a
   supply and a storage move run concurrently in shuffled order. Exactly one may win and exactly one potion unit may exist.
2. *Concurrent batch* of 20 operations on random players, all through the public routes with real `command_id`s. Weights:
   buy 16, move stack 12, start expedition 14, move unique 8, equip 8, cancel 8, read/lazy settle 8, replay identical 8,
   sell material 8 (15% of these try to sell a potion, which must be refused), start live 7, unequip 6, replay with
   changed payload 5.
3. *Audit* (below).
4. *Live closeout*: every actor that is live gets six concurrent mutations (buy, move, sell, equip, expedition start, second
   live start), all of which must be 409 `busy`/`activity_conflict`; then the instance is closed with `returnToSanctuary`
   submitted twice concurrently (one applies, the other is a duplicate ack or finds the closed instance gone).
5. *Settlement race* (50% of rounds): the clock moves to a random running expedition's exact end (or +1 ms, or +90 s) and
   for every due expedition a lazy `GET`, a list, two `settleJob` calls (the job handler path) and two cancels with one
   command id race each other and the real worker.
6. The clock advances by up to 15 minutes, then the audit runs again.

A final drain moves the clock past every end, settles all remaining expeditions through lazy read and job handler
concurrently, and checks that nothing is running, no actor is busy and the whole ledger has no issues.

**Expected vs unexpected.** Business rejections are expected and counted: 409 `busy`, `insufficient_funds`,
`item_not_owned`, `activity_conflict`, `command_id_conflict`, and the 400 gates (`start.*` / `invalid_live_start` for
carrying more than owned, `invalid_sell_item` for selling a consumable). Anything else, in particular any 5xx, a 401 or an exception, fails the test.

**Audit** (one REPEATABLE READ transaction, so the concurrent worker cannot skew it):

- `checkLedgerInvariants` over all actors with the IDs of the running expeditions (balances equal the ledger, unique-item
  mint/ownership history, batch entry counts, no orphan escrow);
- no negative balance;
- activity lock consistency in both directions: `expedition` actors have exactly one running expedition with that id;
  every running expedition's actor is `expedition` with its id and has only one; the same for `live` and active instances;
- settlement at most once: no expedition has more than one settlement batch; terminal expeditions have exactly one and
  running ones none; each expedition has exactly one start escrow batch;
- model accounting per player: gold spent, gold earned from sales, and units bought and sold in the ledger equal the sum of first-time successful
  purchases and sales (replays and rejected commands never change balances), and persisted expeditions equal successful distinct starts.

**Self-check.** A second test corrupts the database on purpose (inflated balance, orphan activity lock, a second settlement
batch) and requires the audit to report each one, then restores it. This guards against a vacuous audit.

### Results

All runs: Node 22.23.4, PostgreSQL 16.15 on the same machine, default size unless stated (30 rounds x 20 operations, 36
players created, 600 random operations plus the per-round scenarios). Zero violations. Under the full parallel suite
(`vitest run`, 118 files, 51 s in total) the fuzz phase took 11.3 s (seed 2491675698). The test timeout is explicit:
`60 s + 2 s x rounds` (2 min by default).

| Run | Seed | Fuzz phase | File duration (2 tests, incl. setup) | Notable counts |
|---|---|---|---|---|
| 1 | 2027522032 | 5.5 s | 7.2 s | 52 expeditions started: 43 settled (11 completed, 32 failed/death), 9 cancelled; 33 live instances closed; 42 identical replays, 30 conflicting replays; 28 material sales |
| 2 | 1273517370 | 5.5 s | 7.3 s | 59 started: 52 settled (17 completed, 35 failed), 7 cancelled; 27 live closed; 48 identical replays, 20 conflicting replays; 18 sales |
| 3 | 2018728676 | 4.9 s | 6.7 s | 52 started: 44 settled (18 completed, 26 failed), 8 cancelled; 28 live closed; 38 identical replays, 36 conflicting replays; 18 sales |
| Soak (150 rounds x 30 ops) | 77 | 93 s | 97 s | 345 expeditions started (257 settled, 88 cancelled), 4,500 random operations, 171 live instances closed; 355 identical replays, 200 conflicting replays; 108 sales; 1,026 mutations refused while live |

Every kind of consumer won the last-potion race in the soak (expedition 80, live start 39, storage move 31 of 150 rounds), the
real worker completed 340 settlement jobs in it, and no run recorded a violation.

## Investigation: "economy invariant violation after round 7" under load (#135)

**Report.** With several `pnpm check` runs sharing one machine (load about 18) the fuzz failed once after round 7 with
`ECONOMY_FUZZ_SEED=4238871146`; two replays of the seed passed. The violation text was not captured.

**Method.** Four cores. Fuzz loops (seed 4238871146 alternating with random seeds) in parallel next to 6 busy-loop node
processes, `pgbench -c 8..16` on a separate database and the default `max_connections = 100`. A new failure message prints
the full violation list immediately and, for a failed audit, a row-level snapshot (balance mismatches, escrow holdings,
expeditions with settlement counts, activity locks, active live instances) read inside the failing audit's own transaction.

**Result.**

| Phase | Load | Runs | Outcome |
|---|---|---|---|
| Before the harness change | 3 fuzz processes + 16 pgbench clients + 6 burners | 3 of seed 4238871146 (first iteration of each runner) | 2 failed after round 7 with `settleJob threw error: sorry, too many clients already` (SQLSTATE 53300); the third was still running when the loop was stopped |
| After, extreme | same | 3 | all failed: PostgreSQL out of slots (`job queue failure code 53300` in the logs), a "Query read timeout", the 120 s test timeout. No audit snapshot reported a ledger, lock or settlement inconsistency. |
| After, heavy | 2 fuzz processes + 8 pgbench clients + 6 burners | 22 (11 x seed 4238871146, 11 random seeds), about 1.6 min each | 22 passed |

**Conclusion.** The reproduced "after round 7" failure is a harness artefact, not an economy bug. One fuzz process holds up to
28 PostgreSQL connections (admin, test, API and worker pools of 10 each plus pg-boss) and a default server allows 100, so a
few concurrent test suites exhaust the slots. Round 7 of this seed is a settlement race with several due expeditions and many
concurrent jobs, so it is where the peak lands. The harness counted any thrown error as a violation, so the connection error
from a direct `settleJob` call failed the run, and replays passed once the neighbours had finished. In none of the failing
runs did an audit find a broken invariant. What was not shown: that the original flake was this and not something else (its
output was not kept), so this is the best-supported explanation, not a proof. The audit already reads everything in one
`REPEATABLE READ` transaction, including the running-expedition set, so a non-snapshot read is ruled out as a cause.

**Changes (test only; no server or engine behaviour changed).**

- A failed audit prints the row-level snapshot above, and `endRound` prints every violation eagerly and puts the full list in
  the assertion message.
- Environmental failures (SQLSTATE 53300/57014/57P01/08xxx, connection or query timeouts, found anywhere on the `cause`
  chain) are classified separately. Direct `settleJob` calls (idempotent, retried by the real job queue) are retried up to 6
  times with backoff; anything that outlasts the retries is reported as `INFRASTRUCTURE (not an economy invariant breach)`.
- An opaque HTTP 500 `internal_error` is retried (same `command_id`, which also covers a connection lost after COMMIT) only when
  database errors were recorded while the request ran and all of them are infrastructure. The server's error log cannot be used
  for this (it uses the root logger without a request id and logs only a sanitised code), so the test records every rejected
  query of every `pg` client in the process by wrapping `Client.prototype.query` (drizzle pools, pg-boss and the audit
  transaction share one `pg` module; a test proves it with `SELECT 1/0` through several paths, and `afterAll` restores the
  original). A 500 with any non-infrastructure database error (40P01, 40001, 23505, ...) or with no database error at all is a
  violation at once, with the SQLSTATE and message in the report. It is deliberately strict on overlap: a non-infrastructure error
  of a concurrent request also condemns the 500. **Residual gap:** a 500 caused by a non-database bug that overlaps an
  infrastructure error of another request is retried, and is hidden only if the retry succeeds; a deterministic bug fails again.
- The server log level is `error` so server-side error lines appear in the test output.
- Deterministic tests cover the classifier, the retry rules for jobs and for 500s (retried on 53300; not retried on 40P01, a plain
  error, a mixed window or no recorded error) and the recorder.

**Advice for shared machines.** Run integration suites with fewer concurrent files or raise `max_connections`; the retries
only absorb transient exhaustion.

## Environment

- Linux x86_64, Node v22.23.4, pnpm 10.28.0, PostgreSQL 16.15 (`127.0.0.1:5432`, database `foundation_test`; each test file
  creates and drops its own database). CI: `postgres:16` service, Node 22 and 24, `pnpm check`.
- Manual clock (no wall time in the economy); the worker's polling uses real timers but only dispatches jobs whose due time is
  at or before the manual clock.

## Limitations

- The fuzz drives HTTP through Fastify `inject` and the live host API directly; it does not open WebSockets (the live socket,
  4409 second-device refusal and reconnect resume are in `live.integration.test.ts`) and does not `SIGKILL` anything
  (`process-crash.integration.test.ts`). Multi-node lease takeover is covered by deterministic tests, not by the fuzz.
- Live instances are opened and closed at their start location inside a round. Exploration, combat ticks, run-bag banking,
  death and corpses under fuzz are not covered; they have scripted tests in `live/*.integration.test.ts`. Live rewards will
  need to be added to the audit when the run bag settles through more paths.
- The manual clock moves forward only, in bounded steps; sessions are issued with a 30-day TTL and replays are limited to
  the 24 h command-retention window. Clock skew across nodes is not simulated.
- Replay of a changed payload is only generated for operations that have a valid alternative payload (not unequip or cancel).
- Not fuzzed: character configuration edits, starter kit claim, estimates, the version-recovery settlement path, party
  (multi-participant) live instances and the periodic ledger audit job.
- Concurrency is at most a few dozen in-flight requests on a 10-connection pool; this is a correctness fuzz, not a load test.
- A pre-existing `pg` deprecation warning ("client.query() when the client is already executing a query") appears in the
  server integration tests, caused by `Promise.all` inside one transaction in `readRpgEvalContext`; it is unrelated to this spike.
