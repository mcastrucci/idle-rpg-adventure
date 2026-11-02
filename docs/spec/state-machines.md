# Spec: State Machines (activity, live instance, exploration)

> Status: **Draft v0.1**.

## 1. Character activity

```
           startLive (CAS none→live)              returnToSanctuary / death / instance closed
  ┌──────┐ ─────────────────────────► ┌──────┐ ───────────────────────────────────────────┐
  │ none │                            │ live │                                            │
  └──────┘ ◄───────────────────────── └──────┘                                            │
     │  ▲                                                                                 │
     │  │ settlement / cancel                                                             │
     │  └───────────────────────── ┌────────────┐                                         │
     └───────────────────────────► │ expedition │ ◄── (blocked while live) ◄──────────────┘
       startExpedition (CAS none→expedition)
```

- All transitions are compare-and-set on the character's generic `actors.activity_state` and exact `activity_id`
  ([ADR-0007](../adr/0007-ledger-and-activity-lock.md), physical engine/game split in ADR-0017).
- Inventory/equipment/skill/automation edits are only allowed in `none` (in Sanctuary).

## 2. Live instance lifecycle

```
created ──► active ──┬──► closing ──► closed
                     │
                     └──► crashed (lease expired) ──► restored(active) | closed
```

| State | Meaning |
|---|---|
| `created` | Row inserted, lease acquired, participants' activity set to `live`, consumables moved to `run_bag`-adjacent loadout |
| `active` | Instance loaded in a node's memory; accepts commands |
| `closing` | All participants returned/died; final checkpoint + settlement of run bags |
| `crashed` | Lease expired without close; next join or recovery job restores from last checkpoint |
| `closed` | Activity locks released |

Checkpoint triggers: location change, combat end, loot pickup, discovery, participant join/leave. Not per tick.

### Participant connection (relevant for phase 2 coop, implemented generically)

```
connected ──disconnect──► disconnected (grace 60 s, provisional) ──timeout──► left
    ▲                          │
    └──────── resume token ────┘
```

While `disconnected`, the character keeps acting in combat via automation; out of combat it stays put.

## 3. Exploration (per instance)

```
      ┌──────────── travel(exit) ────────────┐
      ▼                                      │
 ┌──────────┐  enemies present/aggro   ┌──────────┐
 │ exploring│ ───────────────────────► │  combat  │
 └──────────┘ ◄─────── victory ─────── └──────────┘
      │  ▲                                  │ party wiped
      │  │ interact(hotspot) /              ▼
      │  │ gather / event               ┌────────┐
      │  └──────────────────────────────│  dead  │──► corpse created, instance closing
      │                                 └────────┘
      ▼ returnToSanctuary (only from `safe` locations or start location, out of combat — provisional)
  closing
```

Implemented by the RPG live plugin (#38, `games/rpg/apps/server/src/live/`). `dead` and `closing` are terminal: the step
that enters them also closes the instance (`defeated` / `returned`). The wire format of each command and its rejection
reasons are in the [plugin README](../../games/rpg/apps/server/src/live/README.md).

Commands in `exploring`:

| Command | Effect |
|---|---|
| `travel(exitId)` | Validates exit exists in the current location and is unlocked for every present participant (not a boss room); moves party; marks location discovered per participant present; rolls its groups on first entry |
| `interact(hotspotId)` | Inspect; the first interaction per instance applies the hotspot's declarative `effects` (`setFlag`), which can unlock/reveal exits. Corpse recovery: #43 |
| `gather(nodeId)` | Gather a resource node (once per instance per node) → `run_bag` (#42) |
| `engage(groupId)` | Start combat with an undefeated enemy group of the current location (pre-encounter checkpoint) |
| `enterBossRoom(exitId, confirm)` | `confirm: false` returns the warning + risk summary; `confirm: true` (only after that summary, same location) enters; the boss aggroes |
| `useConsumable(itemId)` | Out-of-combat use (healing consumables only, open decision #21) |
| `returnToSanctuary()` | Only from `safe`/start locations or a cleared boss room (#17); commits run bag to inventory (#42), closes instance |

Commands in `combat`: `useSkill(skillId, target?)`, `useConsumable`, `setAuto(on/off)`, `retreat()` *(provisional,
open decision #18: allowed against non-boss groups at a 10% max HP cost, falling back to the previous location)*.

### Spawn rules (provisional, open decision #14)

- Enemy groups are rolled per location **when the instance first enters it** (seeded per instance and location: 2 rolls,
  1 in a boss room).
- Defeated groups do not respawn within the same instance. A new instance re-rolls.
- Mini-bosses respawn per instance once conquered (farmable) but discovery/conquest credit is granted only once.

### Discovery

Entering a location for the first time adds it to the actor's recorded discoveries (per participant present), committed
in the same transaction as the instance checkpoint (`LiveStep.effects`). Secrets require `interact` on a hotspot whose
effect sets the flag the secret exit requires. Conquest is re-evaluated on every discovery and boss defeat
([conquest-rules.md](conquest-rules.md), #47).
