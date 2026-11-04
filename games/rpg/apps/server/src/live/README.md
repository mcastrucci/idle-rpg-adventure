# RPG live instances

Composition of the engine live host ([`@engine/live-kernel`](../../../../../engine/live-kernel/README.md),
[`createLiveHostModule`](../../../../../engine/server-kit/README.md#live-instance-hosting)) for the RPG: the exploration
state machine of [state-machines §3](../../../../../docs/spec/state-machines.md#3-exploration-per-instance) (#38) on top
of the spike 3 host (#13). Rules marked *provisional* are open decisions #14, #17, #18, #20 and #21, implemented
provisionally and recorded in [open-decisions](../../../../../docs/open-decisions.md#14-17-18-20-21-live-exploration-rules-38).

## Files

- `game.ts` — `createRpgLiveGame(content)`, the `LiveGame` plugin `rpg.live` (version `rpg.live@0.5.0+<rpg-sim>`).
  Deterministic: randomness only from the host seed through `@engine/sim-core` streams, integer/bp math, no clock/I/O.
- `world.ts` — content index: explorable areas, RPG locations (exits, hotspots, resource nodes, encounter tables).
- `effects.ts` — durable effects for discoveries, boss credit, loot, XP and potion use, plus the fenced store hooks for
  checkpoint application and explicit return banking.
- `index.ts` — `createRpgLiveHost(options)` (module handle, registered in the `live` role; `options.hooks` are composed
  after the RPG effects hook) and `startRpgLiveInstance(host, database, { actorIds, area?, location?, groups?, consumables? })`,
  which snapshots equipment, consumable stock and server-recorded progress (`readRpgEvalContext`) and validates that
  snapshot under the actor locks before creating the instance (participants CAS `none → live`). Party formation and the
  Sanctuary portal flow are future work.
- `entry-http.ts` — authenticated owner-scoped solo entry routes. `GET /live/options/:actorId` offers Region 1 and the
  owner's server-recorded consumable stock; `POST /live/start` accepts only `{ commandId, actorId, areaId, supplies }`.
  The start command uses shared `runCommand` idempotency, prepares the real character snapshot under its actor lock, and
  commits command response, instance checkpoint and `none → live` CAS in one transaction before adopting the host.
  `GET /live/current/:actorId` returns a fresh owner-specific in-memory view, or `current: null` once the actor has no
  active live instance. If a committed instance's lease is still held by a restarted node, current returns
  `instance_unavailable` until the normal lease recovery can claim it.

Version `0.4.0` added the instance identity, run bag, hero XP and validated start snapshot to checkpoint state. Version
`0.5.0` adds owner corpse snapshots and unique-item bag projection. Older checkpoints are intentionally incompatible and
are refused during restore; deployments must drain or close active `0.4.0` instances before switching binaries.

## States and commands

`exploring` ⇄ `combat`; a wipe goes to `dead` and a return to `closing`, both closing the instance in the same step
(`defeated` / `returned`). Commands are untrusted (exact keys, else `malformed`); the participant must be present
(`not_present`); nothing is accepted once `dead`/`closing` (`instance_closing`).

| Command (`live.command` payload) | Phase | Rules (rejection reasons) |
|---|---|---|
| `{ type: 'travel', exitId }` | exploring | Exit of the current location (`unknown_exit`; a locked `secret` exit is also `unknown_exit`), requirement holds for every present participant (`exit_locked`), target not a boss room (`boss_room_requires_confirmation`). Rolls the target's groups on first entry; discovers it per present participant. Checkpoint. |
| `{ type: 'enterBossRoom', exitId, confirm }` | exploring | Exit must lead to a `boss_room` (`not_a_boss_room`) and be open (`exit_locked`). `confirm: false` → `bossRoomWarning { risk }` event (enemies, heroes' HP, healing consumables, `retreatAllowed: false`, estimated XP and run-bag loss). `confirm: true` only after that warning at the same location (`confirmation_required`); entering starts combat with the boss (pre-encounter checkpoint). |
| `{ type: 'engage', groupId }` | exploring | Undefeated group of the current location (`unknown_group`), a living hero (`no_living_heroes`). Pre-encounter checkpoint. |
| `{ type: 'interact', hotspotId }` | exploring | Hotspot of the current location (`unknown_hotspot`). An owner corpse uses `corpse:<deathId>` only at its exact region/location in a future instance; its fenced effect rechecks owner, current checkpoint location, status and expiry before one-time ledger transfer into this run bag. |
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
`combatEnded` (`victory` | `defeat` | `retreated`), `combatRewards`, `heroDied`, `corpseRecovered`, `retreated`, `bossRoomWarning`, `hotspotInteracted`, `gathered`,
`consumableUsed`, `returned`, `heroLeft`. `GET /characters/:actorId/live-death` returns the latest owner-only durable death summary, with XP totals, actual causes, corpse state and historical bag contents. The snapshot view lists the current location's groups, exits (open/reasons,
locked secrets hidden), hotspots, resource nodes, flags, `canReturn` and the combat summary. On attach/resume, corpse
hotspot metadata is included only for the viewing owner and only when already at its location. `GET /live/current/:actorId`
projects the latest hosted state for that owner after navigation, combat ticks and durable actions; clients use this
view for scene/combat presentation rather than deriving game state from event payloads.

## Persistence

Checkpoints at location change, encounter start/end, retreat, first hotspot interaction, gathering, consumable use and
participant change (never per tick). Loot, per-victory XP, actual potion use, deaths and corpse recovery leave the plugin as `LiveStep.effects`
and commit in the same fenced transaction as their checkpoint. XP uses the shared `rpg-stats` curve helpers and a
durable reward claim; loot uses deterministic keys tied to instance/action identity. Loot stays in
`run_bag:<instanceId>` until `returnToSanctuary`; only that explicit close hook moves the actual stack, currency and
unique-item ledger holdings to inventory. Defeat and grace close leave the instance-scoped bag unsecured. Discoveries
and boss defeats still record progress and evaluate conquest in the same checkpoint transaction. The start-location
discovery waits in the state's outbox until the first durable write. Replaying an effect cannot duplicate rewards,
progress or the conquest event.

### XP and level-ups (owner decision 2026-11-04)

XP is granted at each combat victory, not at return. The victory step emits one `xpGranted` effect per surviving
present hero (`actionId = victory:<groupId>`); the instance store commits it with the combat-end checkpoint in one
fenced transaction, updating `rpg_characters.level/xp` through the shared `rpg-stats` helpers, so a level-up is durable
while the adventure is still running. Exactly-once comes from the durable claim `rpg_live_xp` /
`<instanceId>:xp:<sha256(actionId)>:<actorId>` (a fingerprint mismatch is an error, a replay is a no-op): duplicate
command retries, an effect re-emitted from an earlier checkpoint after a node handover or SIGKILL recovery, and
duplicate delivery cannot grant twice, and the grant commits atomically with the checkpoint that contains it so it
cannot be lost either. Effects require the caller to hold the instance's activity lock (`live`, this instance).
`returnToSanctuary` banks only the run bag and never touches XP.

The in-instance hero follows the persisted level immediately in checkpointed state (`hero.build.level`, `hero.xp` =
total XP), but derived stats are only read when an encounter starts (`startCombat`), so a level-up never changes a fight
in progress; the next encounter, the hero view's `maxHp` and level-gated exit requirements use the new level. Attribute
points are not granted on level-up (open decision #13). Clients see the gain in the additive fields of `combatRewards`
(`rewards[].levelBefore/levelAfter/xpIntoLevel/xpToNext`), in the hero view (`xpIntoLevel`, `xpToNext`) and in
`heroDied` (`xpLost`, `levelBefore`, `levelAfter`). The checkpoint shape is unchanged (total XP has been part of the
state since `0.4.0`), so `RPG_LIVE_VERSION` is not bumped and in-flight instances keep restoring; an instance created
by another plugin version is still refused with `IncompatibleInstanceError`.

Actual hero death applies provisional XP loss (`applyXpLoss`, once per instance and hero) to authoritative persisted XP — which already includes every earlier victory of the instance — and moves that actor's run bag to an owner
corpse, even if other party members survive. Death/corpse metadata is durable in `rpg_live_deaths`; item holdings remain
in ledger container `corpse:<deathId>`. A second death invalidates the prior corpse even when it is empty, and sinks its
holdings through the ledger. Expiry is 24 hours of injected server time; expired holdings are sunk by the next
actor-locked live start cleanup and cannot be recovered after the deadline. Explicit Sanctuary return secures recovered
holdings from the new run bag.

## Wire protocol

On `/auth/live` (inside `{ "type": "command", "command": … }`):

```json
{ "op": "live.attach", "instanceId": "<uuid>", "actorId": "<uuid>", "resume": { "epoch": 1, "seq": 42 } }
{ "op": "live.command", "instanceId": "<uuid>", "actorId": "<uuid>", "commandId": "<uuid>", "command": { "type": "travel", "exitId": "exit:region_1.portal_clearing.overgrown_causeway" } }
```

Replies: `live.attached { mode }`, `live.ack { commandId, status, duplicate, reason? }`, `live.error { error }`.
Pushes: `live.snapshot`, `live.event`, `live.closed`, `live.evicted`. A `live.snapshot` is also pushed after every
host step to each connected participant with that actor's fresh client-safe view; combat ticks do not require the client
to simulate or predict cooldown/effect state.

Tests: `game.test.ts` (plugin on the real compiled content, no database) and `live.integration.test.ts` (two nodes,
real PostgreSQL and WebSockets: spike 3 adversarial scenarios plus exploration on Region 1 — rejected commands,
discoveries once per participant in the checkpoint transaction, victory, retreat, return rules, hotspot flag across a
node crash, boss-room confirmation and death).
