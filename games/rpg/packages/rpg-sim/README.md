# @rpg/rpg-sim

Server-only, deterministic RPG simulators ([ADR-0003](../../../../docs/adr/0003-simulation-server-only.md),
[ADR-0004](../../../../docs/adr/0004-deterministic-step-engine.md)). It currently holds the step-based **combat engine**
of [combat-engine.md](../../../../docs/spec/combat-engine.md) (issues #20, #21, #22) and the idle
**`ExpeditionSimulator`s** `rpg.hunt` / `rpg.gather` (#76, [below](#idle-expedition-simulators-rpghunt-rpggather-76)),
built on `runToEnd` and the expedition kernel v0.2.

Built on `@engine/sim-core` (PCG32 `RngStreams`, integer/bp math), `@engine/expedition-kernel` + `@engine/economy` +
`@engine/world` (idle contract, ledger deltas, areas), `@rpg/rpg-schema` (content types) and `@rpg/rpg-stats`
(`deriveStats`, `actionIntervalTicks`). The determinism lint applies to this package: no `Math.random`, `Date`,
`performance`, transcendental `Math.*`, floats in game math, or I/O (test-only content loading in the Region 1 tests
excepted).

## API

```ts
createCombat(setup: CombatSetup, seed: Seed): CombatState
step(state: CombatState, inputs: readonly CombatInput[], rng?: RngStreams): { state: CombatState; events: CombatEvent[] }
isFinished(state: CombatState): 'victory' | 'defeat' | null
runToEnd(setup, seed, policy = NO_INPUTS, maxTicks = 10_000): { outcome: 'victory' | 'defeat' | 'timeout'; events; ticks; state }
hashEvents(events): string          // 16-hex fingerprint for golden replays / caching
ENGINE_VERSION                      // 'rpg-sim@1.1.0'
```

- **`CombatSetup`**: `heroes[]` (`id`, `build: DeriveStatsInput`, `skills` loadout, `rules`, optional `consumables`,
  `auto` (default on) and starting `hp`), `enemies[]` (`id`, `enemy` content ID, optional `hp`), `content`
  (`skills`/`items`/`enemies` lookup records — no I/O), optional `formulas` (`StatFormulaTable`) and `tuning`
  (`armorKBp`, `critMultBp`). Party-ready: any N heroes vs M enemies. Invalid setups throw (server data).
- **`CombatState`** is plain JSON: `JSON.parse(JSON.stringify(state))` continues identically. It holds the RNG
  (`RngStreamsState`), the stat table and tuning, every actor (sorted by ID), active effects (application order), and
  a snapshot of the skills/consumables it references, so a checkpoint replays without the content lookup.
- **`step`** is pure at the boundary (steps a `structuredClone`). `rng` is optional: pass a live `RngStreams` matching
  `state.rng` to skip re-hydration. A finished state returns itself with no events.
- **`CombatInput`** (untrusted): `{ actorId, kind: 'useSkill', skill, target? }` (target = actor ID or selector),
  `{ actorId, kind: 'useConsumable', item }`, `{ actorId, kind: 'setAuto', auto }`. Invalid inputs emit
  `InputRejected` (`malformed`, `unknownActor`, `notControllable`, `actorDead`, `unknownKind`, `skillNotEquipped`,
  `noConsumable`, `invalidTarget`, `onCooldown`); the engine never throws on player input. One queued manual action per
  actor; the last input wins.
- **`CombatPolicy`** `(state) => inputs` feeds `runToEnd` each tick (idle automation hooks, scripted players, balance
  tools). It must not mutate the state.

## Tick order (§2)

For tick `t = state.tick + 1`:

1. Apply inputs in order (queue manual actions, toggle automation).
2. Periodic effects (DoT/HoT) due at `t`, in effect-application order.
3. Ready actors: alive and either a windup resolving at `t` or `nextActionTick ≤ t`. Sorted by **initiative**
   (effective `haste`) descending, then actor ID ascending. Actors that die before their turn are skipped; processing
   stops once a side is wiped out.
4. For each: resolve a due windup; else a **stunned** actor skips (`ActionSkipped`, timer restarts); else choose
   *queued manual input → automation rules (if `auto`) → enemy AI* and resolve it. Skills with `windupTicks > 0` emit
   `ActionStarted` + `TelegraphStarted` and resolve at `t + windupTicks`. Nothing to do ⇒ the actor stays ready and is
   re-evaluated next tick (manual mode without input, or no rule matches).
5. Decrement `ticks` durations (effects applied before `t`), expire.
6. End: no living hero ⇒ `defeat` (also on mutual wipe); else no living enemy ⇒ `victory`; emit `CombatEnded`.

Timing rules:

- All actors are ready at tick 1. The action timer restarts when an action **resolves**:
  `nextActionTick = t + actionIntervalTicks`, read from current effective stats (haste buffs apply from the next action;
  interval from `@rpg/rpg-stats` `actionIntervalTicks`, floor 2). A telegraphed action occupies `windupTicks + interval`.
- Cooldowns start when the action **starts** (`readyAt = t + cooldownTicks`).
- **Stun vs windup**: a stun applied to a winding-up actor interrupts it (`ActionInterrupted`, reason `stunned`); the
  cooldown stays spent and the timer restarts from the interrupt. Death also interrupts (reason `died`). A windup whose
  single target died retargets with its selector at resolution.
- Manual inputs resolve at the actor's next ready action (same tick if it is already waiting).

## Formulas (§4, provisional — open decision #2)

- Direct damage: `raw = ⌊power[school] × coeffBp / 10000⌋`; `mitigated = ⌊raw × 10000 / (10000 + mit × armorKBp)⌋`
  with `mit` = armor (physical) or resist (magic), `armorKBp = 100`; crit via `rng.combat.chanceBp(critBp)` (exactly one
  draw per direct hit) → `× critMultBp (15000)`; `final = max(1, …)`. DoT ticks: snapshotted raw, mitigated at tick
  time, no crit, min 1.
- Heal/HoT/shield amounts: `⌊healPower × coeffBp / 10000⌋` for skills; for consumables they scale with the user's
  **max HP** (a potion `heal 3000` restores 30%). Heals never crit; overheal is dropped.
- Shields absorb before HP, oldest first. Enemies: `power` serves both schools; `stat_mod`s on enemies apply to derived
  stats directly (attribute mods have no effect). Heroes are re-derived through `deriveStats` with the active `stat_mod`s
  as modifiers. A lower max HP clamps HP; a higher one does not heal.
- Skill `cost` (placeholder `energy`, open decision #13) is not enforced yet.

## Effects and duration units (§5)

The effect **owner** is its holder (the actor carrying it).

| Unit | Consumed by |
|---|---|
| `ticks` | end of each tick after the one it was applied in (N ticks ⇒ active for `t+1…t+N`) |
| `actions` | each action the holder resolves (skills, consumables); stuns: each action they make it skip |
| `attacks` | harmful effects (taunt, dot, negative `stat_mod`): attacks the holder **performs**; beneficial (shield, hot, positive `stat_mod`): attacks the holder **receives**; stun: skipped actions |

An **attack** is a resolved skill with `enemy`/`allEnemies` targeting and a `damage` or `dot` effect on the target (AoE:
one attack performed, one received per target). An effect is never consumed by the action that applied it.

Stacking/refresh (a replacement expires the old instance with reason `replaced`, then applies a fresh one):

| Effect | Rule |
|---|---|
| `taunt`, `stun` | one per holder; the newest replaces the old regardless of source |
| `shield`, `dot`, `hot` | one per (holder, source, origin); different sources/origins stack |
| `stat_mod` | one per (holder, source, origin, stat); others stack additively |
| `cleanse` | removes dots, stuns and negative `stat_mod`s from the recipient (`Cleansed` + `EffectExpired` `cleansed`) |

**Guard vs secondary control** (combat-engine §5, #71, since 1.1.0): a `shield`/positive `stat_mod` with `guard: true`
makes its holder *guarding*. When an attack resolves, targets guarding at the start of the resolution do not receive
the attack's `negatedByGuard` effects (a `stun`); `EffectNegated` (`reason: guarded`) is emitted instead. Everything else
resolves normally, and the guard effects are consumed by their own duration units (a 1-attack guard by this hit). A guard
shield depleted by the hit still counts.

Taunt forces the holder's single-target `enemy` skills onto the taunter; taunts expire (`sourceDied`) when the taunter
dies. Effects on a dead actor are dropped without events.

## Automation rules and enemy AI (§6–§7)

One evaluator for live auto mode, disconnected participants (`setAuto`) and idle. Rules are tried top-down; the first
whose conditions (ANDed: `selfHpBelowBp`, `allyHpBelowBp`, `enemyTelegraphing`, `skillReady`, `enemiesAtLeast`,
`hasConsumable`, `selfHasHarmfulEffect` — carries a dot, stun or negative `stat_mod`, i.e. something `cleanse` removes)
hold **and** whose action is executable now (skill equipped, off cooldown, a target exists; consumable
in stock) fires. Consumables decrement the in-combat counter and emit `ConsumableUsed`.

Targets: `self` / `allAllies` / `allEnemies` by targeting; `enemy` skills default to `lowestHpEnemy`, `ally` skills to
`lowestHpAlly`; "lowest/highest HP" compares HP share (bp), ties by actor ID; `telegraphingEnemy` picks the earliest
resolving windup. No match or a selector that does not fit the skill's targeting ⇒ the rule is skipped.

Enemies use the same evaluator on their AI list. Bosses first try the current phase's rotation skill (advancing the
rotation when it fires) and fall back to the AI list when it is not ready. Phases only advance: after any damage the
boss moves to the deepest phase with `hpBp ≤ fromHpBp` (`PhaseChanged`, rotation reset). Any skill with
`windupTicks > 0` telegraphs (the compiler checks phase `telegraphs` have a windup).

## Events (§9)

Typed, append-only, each with `seq` (0-based, contiguous for the whole combat) and `tick`: `CombatStarted`,
`ActionStarted`, `TelegraphStarted`, `ActionInterrupted`, `ActionSkipped`, `DamageDealt` (`amount` HP lost,
`absorbed`, `crit`, `periodic`, `hpAfter`), `Healed`, `EffectApplied`, `EffectExpired` (`duration` / `depleted` /
`cleansed` / `replaced` / `sourceDied`), `Cleansed`, `EffectNegated`, `ConsumableUsed`, `ActorDied`, `PhaseChanged`,
`AutoToggled`, `InputRejected`, `CombatEnded`. Beyond §9: `ActionInterrupted`, `ActionSkipped`, `Cleansed`,
`EffectNegated`, `AutoToggled`, `InputRejected`.

## Tests and golden replays

- `engine.test.ts` (#20): tick order/initiative, intervals and cooldowns, manual inputs and rejections, telegraphs,
  stun interrupt, determinism, `step` ≡ `runToEnd`, mid-combat JSON round-trip, properties (HP ≥ 0, append-only
  events, finished stays finished), N vs M.
- `effects.test.ts` (#21, #71): 3-attack taunt at two attack rates, every effect type and duration unit, stacking,
  shields, cleanse; guard vs secondary control (guarded telegraph does not stun, unguarded does, unmarked buffs do not
  negate, a depleted guard shield still counts, per-target judgement).
- `rules.test.ts` (#22, #71): rule order, conditions (including `selfHasHarmfulEffect` firing a cleanse on a DoT, not
  on a taunt), selectors, consumables, shared evaluator, AI list, boss phases, and a
  Monte Carlo over 100 seeds where a manual `guard` answer to the telegraphed heavy strike beats naive rules. The test
  `guard` blocks only the next received attack, so a control that uses guard whenever it is ready shows that the
  *timing* is what matters (at 1.0.0, wins out of 100: naive 0, guard on cooldown 78, guard on telegraph 99 as a
  manual input or as an automation rule). The heavy strike's windup (6) is not shorter than the hero's interval (6),
  so a ready action always falls inside the window. With a shorter windup, an automation rule can only react if the
  hero happens to be ready during it. That is a content tuning lever, not an engine rule.
- `golden.test.ts` + `golden.json`: frozen `hashEvents` per case, as an **append-only history keyed by
  `ENGINE_VERSION`**. **Update procedure** (deliberate behaviour changes only): bump `ENGINE_VERSION` in
  `src/version.ts`; run `pnpm vitest run --project @rpg/rpg-sim golden`; append the printed hashes to `golden.json` as a
  new entry under the new version (never edit an existing entry) in the same commit, explaining the change. What fails
  CI: a hash change without new fixtures (test); a bump without a fixture entry, or a current version that is not the
  last entry (test); hashes edited under an existing version, i.e. new hashes without a bump (CI step
  `tools/golden/check-append-only.ts` against the PR base, the previous push on the default branch, or the merge base
  with the default branch elsewhere). New cases may be added to the current entry. Editing test content in `testing/fixtures.ts` that changes an existing case also needs a new entry (bump, and say that
  only the inputs changed). CI runs it on Node 22 and 24. 1.1.0 (#71) changed no existing replay except the version
  stamp in `CombatStarted` (verified by re-running 1.0.0's fixtures with the old version string) and added the
  `brute-*` guard cases.
- `region-1.smoke.test.ts`: builds combats from the compiled Region 1 content (provisional, not a balance check), and
  checks that `guard` negates the Hollow Matriarch's `crushing_blow` stun while unguarded blows stun.

Content in tests is small and in-test (`src/combat/testing/fixtures.ts`), parsed through the `@rpg/rpg-schema` schemas.

Performance (dev container, Node 22): a 10,000-tick `runToEnd` takes ≈ 20 ms (median of 10 runs: 18–22 ms across
invocations; 7,184 events). The public `step` deep-copies the state each tick (≈ 50–85 µs/tick here), which is
negligible at the 500 ms live tick; batch callers should use `runToEnd`.

## Idle expedition simulators (`rpg.hunt`, `rpg.gather`, #76, kernel 0.3 #77)

The pure part of idle expeditions ([idle-simulation.md](../../../../docs/spec/idle-simulation.md),
[expedition kernel](../../../../docs/engine/expedition-kernel.md), ADR-0005/0019). Persistence, jobs and the ledger
wiring are the server's (#49–#54). Code in `src/expedition/`, exported from the package index.

```ts
createRpgIdleSimulator(kind: 'hunt' | 'gather', content: RpgIdleContent, { tuning? }): RpgExpeditionSimulator
createRpgIdleSimulators(content, options) → { hunt, gather }
createRpgActivityRegistry(bundle | content, options): ActivityRegistry          // kernel registry
rpgIdleContentFromBundle(bundle)                                               // compiled bundle → RpgIdleContent
rpgProgress(timeline, cutoff, reason): RpgProgress                             // XP channel for the server hook
rpgIdleMetrics(timeline): Record<string, number>                               // estimate extractor: xp:/died:<actorId>
itemAsset(content, item): AssetRef                                             // equipment → unique_mint, else stack
RPG_IDLE_VERSION = 'rpg-idle@2.0.0'; RPG_IDLE_SIMULATOR_VERSION = `${RPG_IDLE_VERSION}+${ENGINE_VERSION}`
DEFAULT_RPG_IDLE_TUNING = { regenBetweenFightsBp: 1500, maxCombatTicks: 3000, deathBagLossBp: 5000,
                            gatherSegmentsPerHour: 12, durationsMin: [15, 30, 60, 180] }
```

**Mapping rule.** Simulator IDs are `rpg.<kind>`. The kind of a content idle activity is the last segment of its ID
(after the final `.`, or the `:` without a dot): `idle:region_1.hunt` → `rpg.hunt`, `idle:region_1.gather` →
`rpg.gather`. Other kinds get no simulator (`unregisteredActivities` reports them). `IdleActivity` has no `kind` field;
if one is added, the rule becomes a lookup of it. Both simulators share the model below — *gather* differs only through
its content (fewer encounters per hour, more resource yields).

**Inputs.**
- `RpgIdleConfig` (per expedition, `parseConfig` validates untrusted input against content):
  `{ consumables: [{ item, qty }], retreat: { belowHpBp, onlyWhenNoHealing } }`. No duration and no activity: both are
  kernel-owned (start request). Since `rpg-idle@2.0.0` an `activity` key is rejected (`start.invalidConfig`); the
  simulators read the activity from the kernel's `activityId` (`canStart` context, `budget` target, `simulate` input —
  `idleActivityFor(content, kind, activityId)`; missing → `rpg.noActivity`, unknown → `rpg.unknownActivity`, other
  kind → `rpg.activityKindMismatch`; `budget`/`simulate` throw instead). The server persists `areaId`/`activityId` and
  passes them again on resumption and to `estimate`.
- `RpgActorSnapshot` (per actor, party-ready; phase 1 runs solo): `{ actorId, build: DeriveStatsInput, skills, rules,
  hp? }`. The "automation-rules snapshot" of the spec is the snapshot's `rules`, frozen at start.
- `canStart`: duration in `durationsMin`, the request's activity exists / has this kind, consumables
  are content consumables, actors unique and valid (build derives, `1 ≤ hp ≤ maxHp`, skills exist, rules schema-valid
  and only use equipped skills and real consumables). Codes `rpg.*`. Area completion is the kernel's `checkStart` gate.
- `escrow`: each actor's configured consumables `inventory → escrow`; the kernel returns the unused part.

**Budget.** `max(1, ⌊segmentsPerHour × durationMin × paceBp / (60 × 10000)⌋)` with `mulDivFloor` (exact integers,
floored: a partial encounter is not played). `segmentsPerHour = encountersPerHour`, or `gatherSegmentsPerHour` (12) for
activities without encounters. Region 1: hunt 15/30/60/180 min → 7/15/30/90; gather → 2/5/10/30.

**Segment = one encounter slot (weight 1).** For segment `i` (global index; resumption continues it):
1. RNG `segmentStreams(seed, i)`: `encounters` stream picks the group; `loot` stream rolls kill loot and resources; the
   combat seed is `deriveSeed(segmentSeed(seed, i), 'combat')`. `stateAfter` = HP and consumables left per hero only.
2. Combat with `runToEnd` (automation rules, no inputs, `maxCombatTicks`): heroes start with carried HP and remaining
   consumables. Each enemy killed (also in a lost fight) emits `kill` (XP credited to every hero — provisional party
   rule) and rolls its loot table (`LootTable` semantics: weighted rolls + nothing weight, guaranteed, gold) into the
   bag; recipients rotate round-robin over heroes sorted by ID (solo: the hero). Consumables used → `from: 'escrow'`.
3. No hero died: regen `min(maxHp − hp, ⌊maxHp × 1500 / 10000⌋)` (15 %, provisional, open decision #16 / Q-B9), then
   resource yields: yield `y` rolls `⌊(i+1)·R/S⌋ − ⌊i·R/S⌋` times (`R` rolls/hour, `S` segments/hour), i.e. exactly `R`
   per in-game hour, evenly spread and resumable.
4. Outcome: any hero dead → `failed` (timeline ends with this encounter; a party rule for "one member down" is phase 2).
   Else, if budget remains: a combat timeout → `retreated` (`combat_timeout`), or the retreat policy (some hero below
   `belowHpBp` after regen and, with `onlyWhenNoHealing`, no healing consumable — `heal`/`hot` — left) → `retreated`
   (`low_hp`). Else `completed` once the budget is used. Loot found mid-expedition (e.g. a potion) is not usable during
   it.

Events (JSON): `encounter` (group, result, ticks, `combatHash` = `hashEvents` of the full combat log), `kill`,
`consumable`, `hp` (before / after fight / regen / after), `loot`, `gold`, `death` (plain-language causes), `retreat`.
Full combat logs are not stored; `combatHash` plus the seed replays a fight.

**Ledger deltas** (data only, ADR-0007): items `{ itemAsset(content, item), to: 'inventory' }` — equipment (content
kind `equipment`) as `{ kind: 'unique_mint', item }` with `qty` = number of new instances (the ledger creates one
instance row per unit), every other kind as `stack(item)`; gold `{ currency 'gold' }` (default container), consumables
`{ from: 'escrow' }`; merged per (actor, asset, from, to) within a segment.

**Settlement** (`settle`, provisional rewards §4 / open decisions #6, #8):
- `cancelled` / `member_left`: exactly `defaultSettle` (revealed encounters granted in full; consumables used consumed;
  the kernel returns the rest). The server settles through the kernel's `resolveSettlement`/`settleAt`, so a cancel at
  or after the (actual) end is settled as `completed` (bag loss and XP penalty included; contract rule
  `cancel-after-end`, e2e test).
- `completed` (natural end): merged default deltas; if the cutoff covers the fatal encounter of a `failed` timeline, each
  bag grant per (actor, asset) keeps `total − ⌊total × 5000 / 10000⌋` (50 % lost, the odd unit stays with the player;
  minted equipment counts per item like stacks).
  Consumable use is always settled in full. The contract checker's default bound holds (`completed: 'custom'`).

**Estimates.** `estimate(sim, { config, actors, budget, areaId, activityId }, runs, seed, { metrics: rpgIdleMetrics })`
adds `xp:<actorId>` (gross XP earned) and `died:<actorId>` (0/1) percentiles to the ledger estimates.

**XP channel** (not ledger deltas): `rpgProgress(timeline, cutoff, reason)` → per hero `xpEarned`, `kills`, `died`, plus
`applyDeathPenalty` (fatal encounter covered **and** `reason === 'completed'`, same rule as the bag loss) and
`deathXpLossBp` (`DEFAULT_DEATH_XP_LOSS_BP`). The server hook adds the XP, then applies
`applyXpLoss(totalXp + xpEarned, deathXpLossBp, curve)` from `@rpg/rpg-stats` to heroes that died ("XP earned kept
before penalty").

**Report** (`summarize`): segments, encounters, victories, outcome (whole timeline only), kills, XP per hero, gross gold
and loot, consumables used, HP summary per hero (start, lowest after a fight, end), retreat reason, and the death log:
fatal encounter, group and causes — `idle.death.damage_taken` (top 3 sources by damage), `biggest_hit`, `stunned`,
`out_of_consumables` / `no_consumables`, `outnumbered`, `started_wounded` (text keys with parameters).

**Golden timelines** (`src/expedition/golden.test.ts` + `golden.json`): `timelineHash` of four fixed Region 1 expeditions
(completed, failed, retreated, gather), an append-only history keyed by `RPG_IDLE_SIMULATOR_VERSION` (CI checks it with
`tools/golden/check-append-only.ts`). Update procedure: bump `RPG_IDLE_VERSION` (a combat `ENGINE_VERSION` bump changes
the key by itself), run `pnpm vitest run --project @rpg/rpg-sim expedition/golden`, append the printed hashes as a new
entry, explain the change. A content change in `games/rpg/content` that alters these timelines also needs a new entry.

**Tests.** `contract.test.ts` (kernel contract, 4 fixtures × 20 seeds with completed/failed/retreated outcomes,
per-reason modes; escrow conservation at every cutoff; settlement rules; `rpgProgress`; determinism; resumption from
every `stateAfter`), `simulator.test.ts` (config, `canStart`, budget, escrow, mapping, kernel `checkStart` with the
Region 1 world), `region-1.e2e.test.ts` (compiled bundle, 15/30/60/180 min, reveal never leaks a failure/retreat),
`golden.test.ts`, and the opt-in `bench.test.ts` (`RPG_IDLE_BENCH=1`).

**Measurements** (#76, evidence for spike 1 / ADR-0013; dev container, 4 vCPU Intel Xeon @ 2.10 GHz, Node 22.23.4,
`RPG_IDLE_BENCH=1`): a 180-minute Region 1 hunt (90 encounters, level-4 reference builds, all completed) precomputes in
p50 ≈ 17–23 ms, p95 ≈ 25–37 ms (60 runs per build); `estimate` with 200 runs takes ≈ 3.7–4.8 s.

Spike 1 close-out (#11; same container, 4 vCPU Intel Xeon @ 2.3 GHz, Node 22.23.4 and 24.22.1, two runs each, shared
hardware so expect ±1.5x): the 90-segment precompute is p95 ≈ 12–19 ms on both Node versions (Node 24 within about 10 %
of Node 22) and a raw 200-run estimate takes ≈ 2.2–3.0 s (the server mitigation is #53 / PR #92).
`expedition/determinism.test.ts` (normal suite) runs an idle hunt and a combat case 1,000 times each from rebuilt inputs
and requires every hash to equal the golden one (≈ 2.2 s per Node version). `expedition/memory.bench.test.ts` (opt-in,
`NODE_OPTIONS=--expose-gc RPG_MEMORY_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/memory.bench
--silent=false`) compares `step` (copies state per tick) with `runToEnd` over a 10,000-tick fight: ≈ 4x the allocation
and ≈ 16x the time (≈ 330 ms vs ≈ 20 ms), only minor GCs apart from at most one major, peak heap ≈ 40 MB on Node 22; a
200-run estimate peaks at ≈ 60 MB (Node 22) to ≈ 125 MB (Node 24) with ≈ 65-100 ms of total GC pause. Details: the
[spike 1 report](../../../../docs/spikes/spike-1-sim.md).

**Findings for the kernel / server** (from #76) — all **resolved in kernel 0.3 (#77)**, adopted by `rpg-idle@2.0.0`:
- *`canStart` did not receive the request's `activityId`, so the config carried `activity`.* → `areaId`/`activityId`
  are kernel-owned and passed to `canStart`, `budget`, `simulate` and `estimate`; `activity` was dropped from the
  config.
- *`checkStart` called `budget` before `canStart`, so a bad config could throw.* → `checkStart` parses the raw config
  first, runs `canStart` before `escrow`/`budget`, and maps every simulator throw to a `start.*` code.
- *A cancel whose cutoff covers the fatal encounter skipped the death loss.* → the kernel's `resolveSettlement` /
  `settleAt` settle any cancel at or after `endsAt` as `completed` over the whole timeline (contract rule
  `cancel-after-end`). The server must settle only through them.
- *`estimate` aggregated ledger deltas only.* → `estimate(…, { metrics })`; the RPG passes `rpgIdleMetrics` (XP).
- *Equipment drops were `stack` deltas.* → `@engine/economy` `unique_mint`; equipment drops mint instances. The golden
  case `hunt-bulwark-l4-60min-3potions-seed-42` (an equipment drop) changed accordingly; the others are unchanged.
