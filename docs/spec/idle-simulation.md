# Spec: Idle Expedition Simulation

> Status: **Draft v0.1**. Decision: [ADR-0005](../adr/0005-idle-precompute-at-start.md),
> [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md).

> **Engine mapping (ADR-0019):** lifecycle, reveal, settlement, cancellation, party and estimates are implemented by
> `engine/expedition-kernel` ([spec](../engine/expedition-kernel.md)); this document describes the RPG simulator
> plugin (`games/rpg/packages/rpg-sim`): segments = encounters.

## 1. Lifecycle

```
draft ──(solo)──────────────────────────► running ──► settled (completed | retreated | died)
  │                                         │
  └─(party, phase 2)─► pending_invites ─────┤
                         │ expiry/decline   └──cancel──► cancelled (partial settlement)
                         ▼
                       draft
```

## 2. Configuration

| Field | Values (POC) |
|---|---|
| `regionId` | conquered regions only (server-checked) |
| `activityId` | `hunt` (combat-focused), `gather` (fewer fights, more resources) |
| `durationMin` | 15, 30, 60, 180 |
| `consumables` | item IDs + quantities from inventory (escrowed) |
| `automationRules` | snapshot of current rules (editable before start) |
| `retreatPolicy` | e.g. retreat when HP < X% and no healing consumables left *(provisional)* |

## 3. Start (single transaction)

1. `SELECT … FOR UPDATE` character(s) in ID order.
2. Verify region conquered and `activity_state = 'none'`; CAS to `expedition`.
3. Move consumables `inventory → escrow` (ledger, source = expedition ID).
4. Snapshot stats/loadout/rules into `snapshot`.
5. Generate `seed`; run the simulation (§4); store `timeline`, `outcome`, `ends_at`.
6. Insert settlement job at `ends_at` (idempotent job key = expedition ID + revision).
7. Commit. Respond with public data only (no future events).

## 4. Simulation model

- `encounterBudget = round(durationMin / 60 * activity.encountersPerHour * paceMultiplier)`.
- For each encounter `i`: roll enemy group from the activity's encounter table (`encounters` stream); run combat to end
  with automation policy; apply between-encounter regen *(provisional: % HP regen between fights)*; roll loot
  (`loot` stream) into a virtual expedition bag; consume escrowed consumables as used.
- Wall-clock placement: encounter `i` is revealed at `startsAt + (i+1)/encounterBudget * duration`.
- Early end: on death or retreat policy trigger, the timeline ends at that encounter; `ends_at` is set to that
  encounter's reveal time.
- Stored per encounter: enemies, result, XP, gold, loot, consumables used, HP after. Full event logs stored only for the
  last N encounters (death log) to bound row size.

## 5. Reveal

`GET /expeditions/:id` returns encounters with `revealAt ≤ now()` plus aggregated totals so far. Progress bar uses
`startsAt/plannedEndsAt` — the *actual* `ends_at` is withheld until reached, since an earlier end would leak a death or
retreat. The final outcome is never returned before `ends_at` (implemented by `visibleView` in the expedition kernel).

## 6. Settlement (idempotent)

Triggered by the job at `ends_at` or lazily on read after `ends_at`:

```sql
UPDATE expeditions SET status='settled', settled_at=now()
WHERE id=$1 AND revision=$2 AND status='running'
RETURNING *;
```

If a row returns, in the same transaction: grant XP/gold/loot via ledger (keys `(expedition_settlement, id:rev, seq)`),
consume used escrow, return unused escrow to inventory, apply death penalty if `died`, CAS activity back to `none`.

## 7. Cancellation (provisional policy)

- Player may cancel any time while `running`.
- Rewards: encounters with `revealAt ≤ now` are granted in full; later ones discarded.
- Consumables: those used in revealed encounters are consumed; the rest returned.
- No extra penalty in POC. Revisit if cancel-scumming appears (e.g. cancel right before a revealed death is impossible,
  since a death encounter is the last one and is revealed at the moment it happens).

## 8. Estimates

- Monte Carlo: run the same simulation for N seeds (N = 100–200 *(provisional)*), report p10/p50/p90 for XP, gold,
  potions used, and death probability.
- Cache key: `(buildHash, regionId, activityId, durationMin, consumables, rules hash, contentHash, engineVersion)`.
- If too slow (spike 1), fall back to a per-encounter Monte Carlo composed analytically.
- UI must label estimates as estimates.

## 9. Death in idle

- Timeline ends at the fatal encounter; player is notified when it is revealed.
- Report includes a **death log**: last encounter's key events (big hits, missed heals, consumables exhausted) in plain
  language.
- Penalties per [rewards-and-persistence.md](rewards-and-persistence.md#death-penalties).
