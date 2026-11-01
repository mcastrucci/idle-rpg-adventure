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

- All transitions are compare-and-set on `characters.activity_state` ([ADR-0007](../adr/0007-ledger-and-activity-lock.md)).
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

Commands in `exploring`:

| Command | Effect |
|---|---|
| `travel(exitId)` | Validates exit exists and is unlocked; moves party; marks location discovered; may start combat |
| `interact(hotspotId)` | Inspect, open, trigger event, recover corpse |
| `gather(nodeId)` | Gather a resource node (once per instance per node) → `run_bag` |
| `engage(groupId)` | Start combat with a visible enemy group |
| `enterBossRoom()` | Requires confirmation (shows warning + risk summary) |
| `useConsumable(itemId)` | Out-of-combat use |
| `returnToSanctuary()` | Commits run bag to inventory, closes instance |

Commands in `combat`: `useSkill(skillId, target?)`, `useConsumable`, `setAutomation(on/off)`, `retreat()` *(retreat rules
provisional: allowed against non-boss groups with a chance/cost)*.

### Spawn rules (provisional)

- Enemy groups are rolled per location **when the instance first enters it** (seeded per instance).
- Defeated groups do not respawn within the same instance. A new instance re-rolls.
- Mini-bosses respawn per instance once conquered (farmable) but discovery/conquest credit is granted only once.

### Discovery

Entering a location for the first time adds it to `region_progress.discovered_location_ids` (per participant present).
Secrets require `interact` on a hidden hotspot. Conquest is re-evaluated on every discovery and boss defeat
([conquest-rules.md](conquest-rules.md)).
