# RPG live instances (spike 3)

Composition of the engine live host ([`@engine/live-kernel`](../../../../../engine/live-kernel/README.md),
[`createLiveHostModule`](../../../../../engine/server-kit/README.md#live-instance-hosting)) for the RPG. Status: **spike
prototype** (#13); enough to make the tick/automation path real, not the M4 exploration feature.

- `createRpgLiveGame(content)` — `LiveGame` plugin `rpg.live`. One stub location with authored enemy groups. Commands:
  `engage { groupId }` (exploring; creates an `@rpg/rpg-sim` combat and checkpoints at combat tick 0),
  `returnToSanctuary` (exploring only; closes the instance as `returned`), and in combat `setAuto { auto }` /
  `useSkill { skill, target? }` queued as combat inputs for the next tick. Combat ticks every 500 ms through
  `step()`; heroes act on their automation rules whether or not their player is connected. Victory marks the group
  defeated and checkpoints; a wipe closes the instance as `defeated`. A participant whose grace expired is removed only
  out of combat. Travel, hotspots, gathering, loot, run bags, corpses and penalties are not implemented.
- `createRpgLiveHost(options)` — the module handle. `createRpgServer` registers it in the `live` role and routes
  `live.*` socket commands to it before character commands. Pass your own handle (e.g. `autoStart: false`) in tests.
- `startRpgLiveInstance(host, database, { actorIds, location, groups })` — snapshots character builds and creates the
  instance (participants CAS `none → live`). Party formation and real area entry are future work.

Wire protocol on `/auth/live` (inside `{ "type": "command", "command": … }`):

```json
{ "op": "live.attach", "instanceId": "<uuid>", "actorId": "<uuid>", "resume": { "epoch": 1, "seq": 42 } }
{ "op": "live.command", "instanceId": "<uuid>", "actorId": "<uuid>", "commandId": "<uuid>", "command": { "type": "engage", "groupId": "group:slimes" } }
```

Replies: `live.attached { mode }`, `live.ack { commandId, status, duplicate, reason? }`, `live.error { error }`.
Pushes: `live.snapshot`, `live.event`, `live.closed`, `live.evicted`.

Tests: `game.test.ts` (plugin, no database) and `live.integration.test.ts` (two nodes, real PostgreSQL, adversarial
scenarios listed in ADR-0012).
