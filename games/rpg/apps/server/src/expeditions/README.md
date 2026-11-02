# RPG expeditions

`service.ts` composes the pure `@engine/expedition-kernel` with the RPG idle simulator and server ledger. Start keeps
actor locking, activity CAS, escrow transfer, precomputed replay inputs, compressed deterministic timeline, and the
settlement schedule in one database transaction. Reads use the kernel's visible view; they never return the saved seed,
hash, state-after values, or unrevealed events. A lazy read, settlement worker, and cancel all share the same locked
settlement path. Cancellation uses the kernel resolution; its timestamp and cutoff are persisted so the discarded tail
stays hidden on every later read.

The `progress.ts` functions are internal write seams for trusted exploration/conquest systems. There is intentionally no
HTTP endpoint that accepts world progress. `readRpgEvalContext` feeds those persisted rows, plus the server character
level and ledger inventory, to `checkStart`. New accounts do not get a completion record automatically. A legitimate
server-side progression service can call `recordDiscovery`, `recordObjective` (for keys such as `defeated:enemy:...`),
or `recordAreaCompletion` in the same transaction as the game event that earned that progress.

For a database integration fixture, create a character, then in a server-owned transaction call
`recordAreaCompletion(tx, clock, actorId, 'area:region_1')` before starting a Region 1 expedition. This fixture-only
shortcut models the recorded completion state accepted by the world engine; no request field can create or spoof it.

The simulator snapshot resolves every equipped unique instance's content definition to its authored stat map. Instance
roll data must currently be empty because no RPG stat-roll schema has been accepted; the server rejects unknown
non-empty rolls instead of precomputing with an incomplete build. The XP curve is stored with participants, and settlement
also checks the persisted content, kernel, and simulator versions before applying rewards. A worker running incompatible
content fails for retry rather than changing a past reward calculation.
