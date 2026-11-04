# Spec: Rewards, Economy Integrity and Persistence

> Status: **Draft v0.1**. Decision: [ADR-0007](../adr/0007-ledger-and-activity-lock.md).

## 1. Transaction pattern (every economy mutation)

```
BEGIN
  SELECT … FROM actors WHERE actor_id = ANY($ids) ORDER BY actor_id FOR UPDATE;
  -- validate activity_state / ownership / quantities
  INSERT INTO ledger_entries (…) ON CONFLICT (source_type, source_id, seq) DO NOTHING RETURNING id;
  -- only if inserted: update materialized balances / item rows
  UPDATE actors SET version = version + 1 …;
COMMIT
```

- All in `apps/server` module `ledger`; no other module writes balances.
- Authenticated command endpoints use the shared transaction runner: authenticate/authorize, reserve the account/key,
  compare operation and canonical payload fingerprint, and atomically persist the response with the mutation.
  Expired keys retain tombstones and never authorize re-execution. See [command contract](../../engine/server-kit/src/commands/README.md).

## 2. Live rewards

- Loot and gathered resources go to `run_bag` (persisted at checkpoints).
- XP is granted immediately per combat victory and persisted in the same fenced transaction as the combat-end
  checkpoint, including level-ups during the live adventure (owner decision, 2026-11-04: "we want to allocate XP right
  away, even level up in live mode; we lose things when we die"). It is not deferred to `returnToSanctuary`, which only
  moves the run bag. Each victory/hero grant is claimed once (`<instance>:xp:<victory action>:<actor>`), so command
  retries, node handover and crash recovery cannot grant or lose it. A level-up changes the hero's derived stats from
  the next encounter onward, never mid-fight. XP amounts, the XP curve and the death penalty below remain provisional
  (open decisions #2, #8, #13); only the *timing* is decided.
- `returnToSanctuary` moves `run_bag → inventory` (ledger, source = instance ID).

## 3. Idle rewards

Granted only at settlement ([idle-simulation.md §6](idle-simulation.md#6-settlement-idempotent)).

## 4. Death penalties (idle solo POC behavior; balance provisional — open decision #8)

XP curve (open decision #2, [#129](https://github.com/mcastrucci/idle-rpg-adventure/issues/129)): the authored table
`xpToNext = [100, 250, 450, 700, 1000]` is unchanged and the curve has **no maximum level**. Beyond the table
`xpToNext(L) = ⌊xpToNext(L − 1) × tailGrowthBp / 10000⌋` with `tailGrowthBp = 12500` in `progression/xp-curve.json`
(1000 → 1250 → 1562 → 1952 → 2440 …). All values are safe integers; when the next threshold would exceed
`Number.MAX_SAFE_INTEGER` (around level 130, far beyond play) the last representable level behaves like a cap. Existing
`(level, xp)` pairs keep their meaning; a character that had piled XP up at the old cap (level 6 with ≥ 1250 XP into
the level) is normalized by migration `0009_open_xp_curve.sql`. Provisional numbers chosen by the owner on 2026-11-04.

| Penalty | Live | Idle |
|---|---|---|
| XP | Level-scaled share of total XP, once per death (owner values, 2026-11-04, [#129](https://github.com/mcastrucci/idle-rpg-adventure/issues/129)): XP from earlier victories is already persisted (§2), so only the penalty applies. With `L` the level before the loss, `xpLost = ⌊totalXp × lossBp(L) / 10000⌋` with `lossBp(L) = max(200, 1000 − 20 × (L − 1))` (10% at level 1, 8% at level 11, 2% from level 41), then total XP never ends below the XP at which level `L − 1` starts (a death costs at most one level) and never below level 1 / zero. Provisional | Same function, applied to total XP after adding the XP earned during the expedition, on a natural failed completion. Expeditions started under simulator `rpg-idle@2.0.0` keep their original rule (10% of the XP required for the hero's next level, the last table entry as the reference at and above the old cap) — ADR-0005. Floored; XP never falls below zero. |
| Run bag / expedition loot | Provisional POC implementation: actual instance-scoped ledger holdings move to corpse | On a natural failed completion, lose `floor(qty × 5000 / 10000)` of each positive gold/item grant in the bag; the odd unit is kept. |
| Inventory | Provisional: carried consumables used are gone; rest kept | Used escrowed consumables are consumed; unused escrow is returned. A cancellation before actual end settles only revealed segments and applies no death penalty. A cancel at or after actual end is settled as a natural completion, so a revealed fatal segment still incurs the death penalties. |
| Equipped gear | Provisional: kept in POC (durability/loss deferred) | Kept |
| Storage | Provisional: never affected | Never affected |

The idle values and rules above describe the current solo POC implementation; they are not validated balance targets.
Live death penalties and corpse recovery are implemented provisionally for the POC and remain unvalidated balance
targets. The pre-boss warning must show the current estimated XP loss and unsecured run-bag contents before confirmation.

## 5. Corpses (live)

- On actual hero death in live, an owner-only corpse is created at the death location with that hero's actual instance-
  scoped ledger holdings, preserving unique item UUIDs. The server also records XP before/after, penalty, and up to three
  actual damage causes (with an explicit unknown-cause fallback).
- Corpse persists **24 h** injected wall-clock time *(provisional)*; only the owner can recover it by reaching the same
  region and location in a new instance and interacting. Recovery moves ledger contents once into the new unsecured
  run bag; only explicit Sanctuary return secures them.
- Only one active corpse per character: a new death invalidates the previous one, including an empty corpse, and sinks
  its remaining holdings through the ledger.
- Corpses are spawned into the owner's future instances of that region (they are not part of instance state).
- Idle-death recovery activity: not in POC (concept §9.2).

## 6. Checkpoints (live)

- Stored in `live_instances.checkpoint` with `checkpoint_seq`; written at location change, combat end, loot pickup,
  discovery, participant change.
- On node crash: lease expires (e.g. 30 s); next reconnect or recovery job restores from checkpoint. Combat in progress
  at crash time restarts from the pre-combat checkpoint.

## 7. Economy sinks (POC)

Consumable purchases, repairs placeholder, storage expansion with gold, death penalties.

## 8. Anti-exploit checklist

- [ ] Cannot start an expedition while in live (CAS).
- [ ] Cannot use or sell an escrowed consumable.
- [ ] Retried commands (same `command_id`) apply once.
- [ ] Settlement job running twice grants once.
- [ ] Cancelling after the expedition's actual end cannot skip the death penalty (settled as `completed` through the
  kernel's `resolveSettlement`/`settleAt`, ADR-0019 v0.3).
- [ ] Disconnecting during combat does not pause or prevent death.
- [ ] Two devices: second session cannot mutate while the first holds the activity lock.
- [ ] No endpoint accepts client-computed rewards, damage or timestamps.
- [ ] Ledger invariant checker passes after fuzzing (spike 3).
