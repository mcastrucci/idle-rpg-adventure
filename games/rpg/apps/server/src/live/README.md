# RPG live instances

Composition of the engine live host ([`@engine/live-kernel`](../../../../../engine/live-kernel/README.md),
[`createLiveHostModule`](../../../../../engine/server-kit/README.md#live-instance-hosting)) for the RPG: the exploration
state machine of [state-machines §3](../../../../../docs/spec/state-machines.md#3-exploration-per-instance) (#38) on top
of the spike 3 host (#13). Rules marked *provisional* are open decisions #14, #17, #18, #20 and #21, implemented
provisionally and recorded in [open-decisions](../../../../../docs/open-decisions.md#14-17-18-20-21-live-exploration-rules-38).

## Files

- `game.ts` — `createRpgLiveGame(content)`, the `LiveGame` plugin `rpg.live` (version `rpg.live@0.4.0+<rpg-sim>`).
  Deterministic: randomness only from the host seed through `@engine/sim-core` streams, integer/bp math, no clock/I/O.
- `world.ts` — content index: explorable areas, RPG locations (exits, hotspots, resource nodes, encounter tables).
- `effects.ts` — durable effects for discoveries, boss credit, loot, XP and potion use, plus the fenced store hooks for
  checkpoint application and explicit return banking.
- `index.ts` — `createRpgLiveHost(options)` (module handle, registered in the `live` role; `options.hooks` are composed
  after the RPG effects hook) and `startRpgLiveInstance(host, database, { actorIds, area?, location?, groups?, consumables? })`,
  which snapshots equipment, consumable stock and server-recorded progress (`readRpgEvalContext`) and validates that
  snapshot under the actor locks before creating the instance (participants CAS `none → live`). Party formation and the
  Sanctuary portal flow are future work.

Version `0.4.0` adds the instance identity, run bag, hero XP and validated start snapshot to checkpoint state. Older
`0.3.0` checkpoints are intentionally incompatible and are refused during restore; no implicit migration is attempted.

## States and commands

`exploring` ⇄ `combat`; a wipe goes to `dead` and a return to `closing`, both closing the instance in the same step
(`defeated` / `returned`). Commands are untrusted (exact keys, else `malformed`); the participant must be present
(`not_present`); nothing is accepted once `dead`/`closing` (`instance_closing`).

| Command (`live.command` payload) | Phase | Rules (rejection reasons) |
|---|---|---|
| `{ type: 'travel', exitId }` | exploring | Exit of the current location (`unknown_exit`; a locked `secret` exit is also `unknown_exit`), requirement holds for every present participant (`exit_locked`), target not a boss room (`boss_room_requires_confirmation`). Rolls the target's groups on first entry; discovers it per present participant. Checkpoint. |
| `{ type: 'enterBossRoom', exitId, confirm }` | exploring | Exit must lead to a `boss_room` (`not_a_boss_room`) and be open (`exit_locked`). `confirm: false` → `bossRoomWarning { risk }` event (enemies, heroes' HP, healing consumables, `retreatAllowed: false`, death consequence keys). `confirm: true` only after that warning at the same location (`confirmation_required`); entering starts combat with the boss (pre-encounter checkpoint). |
| `{ type: 'engage', groupId }` | exploring | Undefeated group of the current location (`unknown_group`), a living hero (`no_living_heroes`). Pre-encounter checkpoint. |
| `{ type: 'interact', hotspotId }` | exploring | Hotspot of the current location (`unknown_hotspot`). First interaction per instance applies its `effects` (`setFlag`, instance-scoped, #20) and reports `flagsSet` and `revealedExits` (checkpoint); repeats are `repeat: true` and change nothing. |
| `{ type: 'gather', nodeId }` | exploring | Node `<resource>#<ordinal>` of the current location (`unknown_node`), once per instance (`already_gathered`). Rolls its loot table on a stable named `loot` stream, adds drops and gold to the caller's run bag, and checkpoints the bag with its ledger effect. |
| `{ type: 'useConsumable', itemId }` | both | Item in the hero's snapshot loadout (`no_such_consumable`). Out of combat (#21): healing items only (`no_effect_out_of_combat`), alive (`hero_dead`), below max HP (`full_hp`); checkpoint. In combat: queued for the combat engine. |
| `{ type: 'returnToSanctuary' }` | exploring | `safe` location, area start location or cleared boss room (`not_safe_location`, #17); `in_combat` in combat. Closes `returned`. |
| `{ type: 'retreat' }` | combat | Non-boss group outside a boss room (`retreat_not_allowed`, #18): each living fighter loses 10% max HP (min 1 HP), party falls back to the previous location, group stays. Checkpoint. |
| `{ type: 'setAuto', auto }`, `{ type: 'useSkill', skill, target? }` | combat | Queued as combat inputs for the next tick. Out of combat: `not_in_combat`. |

Every other exploration command in combat is `in_combat`. Spawns (#14): two weighted rolls of the location's encounter
table on first entry (one in a boss room), on the sim-core stream `spawn:<locationId>`; no respawn within the instance.
Combat ticks every 500 ms through `@rpg/rpg-sim` `step()`; heroes act on their automation whether or not their player is
connected. A participant whose grace expired is removed only out of combat.

Events (`live.event` → `event.type`): `traveled`, `discovered`, `combatStarted`, `combat` (engine events),
`combatEnded` (`victory` | `defeat` | `retreated`), `retreated`, `bossRoomWarning`, `hotspotInteracted`, `gathered`,
`consumableUsed`, `returned`, `heroLeft`. The snapshot view lists the current location's groups, exits (open/reasons,
locked secrets hidden), hotspots, resource nodes, flags, `canReturn` and the combat summary.

## Persistence

Checkpoints at location change, encounter start/end, retreat, first hotspot interaction, gathering, consumable use and
participant change (never per tick). Loot, per-victory XP and actual potion use leave the plugin as `LiveStep.effects`
and commit in the same fenced transaction as their checkpoint. XP uses the shared `rpg-stats` curve helpers and a
durable reward claim; loot uses deterministic keys tied to instance/action identity. Loot stays in
`run_bag:<instanceId>` until `returnToSanctuary`; only that explicit close hook moves the actual stack, currency and
unique-item ledger holdings to inventory. Defeat and grace close leave the instance-scoped bag unsecured. Discoveries
and boss defeats still record progress and evaluate conquest in the same checkpoint transaction. The start-location
discovery waits in the state's outbox until the first durable write. Replaying an effect cannot duplicate rewards,
progress or the conquest event.

Hooks left for later issues (search the code for the issue numbers):

- **#43** death: `dead` closes as `defeated` with the death location in the final checkpoint; corpses become
  interactable hotspots in `interact`.

## Wire protocol

On `/auth/live` (inside `{ "type": "command", "command": … }`):

```json
{ "op": "live.attach", "instanceId": "<uuid>", "actorId": "<uuid>", "resume": { "epoch": 1, "seq": 42 } }
{ "op": "live.command", "instanceId": "<uuid>", "actorId": "<uuid>", "commandId": "<uuid>", "command": { "type": "travel", "exitId": "exit:region_1.portal_clearing.overgrown_causeway" } }
```

Replies: `live.attached { mode }`, `live.ack { commandId, status, duplicate, reason? }`, `live.error { error }`.
Pushes: `live.snapshot`, `live.event`, `live.closed`, `live.evicted`.

Tests: `game.test.ts` (plugin on the real compiled content, no database) and `live.integration.test.ts` (two nodes,
real PostgreSQL and WebSockets: spike 3 adversarial scenarios plus exploration on Region 1 — rejected commands,
discoveries once per participant in the checkpoint transaction, victory, retreat, return rules, hotspot flag across a
node crash, boss-room confirmation and death).
