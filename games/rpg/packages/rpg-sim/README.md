# @rpg/rpg-sim

Server-only, deterministic RPG simulators ([ADR-0003](../../../../docs/adr/0003-simulation-server-only.md),
[ADR-0004](../../../../docs/adr/0004-deterministic-step-engine.md)). It currently holds the step-based **combat engine**
of [combat-engine.md](../../../../docs/spec/combat-engine.md) (issues #20, #21, #22). The idle `ExpeditionSimulator`
(M6) will build on `runToEnd`.

Built on `@engine/sim-core` (PCG32 `RngStreams`, integer/bp math), `@rpg/rpg-schema` (content types) and
`@rpg/rpg-stats` (`deriveStats`, `actionIntervalTicks`). The determinism lint applies to this package: no
`Math.random`, `Date`, `performance`, transcendental `Math.*`, floats in game math, or I/O (test-only content loading
in the Region 1 smoke test excepted).

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
