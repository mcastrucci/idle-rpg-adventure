# Open Decisions

Pending decisions from the concept (§17) plus those surfaced by the design review. Each has a **provisional proposal** so
work can proceed, and a place where it must be resolved. Provisional values must not be treated as final: when resolved,
record the outcome here (and in an ADR if architectural).

| # | Decision | Provisional proposal | Resolve in | Status |
|---|---|---|---|---|
| 1 | Combat tick duration | 500 ms | Spike 1 / ADR-0013 | Open (spike 1: idle cost is independent of tick; 500 ms kept as engine constant, feel to be judged in M4 playtests) |
| 2 | XP, damage, defense and progression formulas | Integer formulas in [combat-engine.md](spec/combat-engine.md#4-formulas-provisional-integer-only); XP curve table | M1 balance pass | Open (XP curve: owner-chosen open-ended curve, provisional, 2026-11-04 — [below](#2-xp-curve-open-ended-129); method checkpoint: production idle settlement and a bounded no-regen idle counterfactual are documented; production live-plugin effects are measured on one finite authored route. Human command timing, DB settlement and sustainable repeat rate remain pending; progression points remain #13) |
| 3 | Party loot distribution | Equal gold/XP split; round-robin loot (idle); personal loot (live) | M8 | Open |
| 4 | Max party size | 4 (POC validates 2) | M8 | Open |
| 5 | Live disconnection policy | 60 s grace; combat continues on automation; then `left` — **amended by spike 3**, see [below](#5-live-disconnection-policy-spike-3) | Spike 3 / M4 | Confirmed with amendments (values provisional) |
| 6 | Idle cancellation and partial rewards | Before the actual end, settle only revealed segments: their grants and used consumables apply, unused escrow returns, and no cancellation penalty applies. A cancel at/after the actual end settles as a natural completion. | M6 / kernel v0.3 | Resolved for solo POC; abuse/balance remains unvalidated |
| 7 | Corpse persistence and recovery in instances | Owner-only corpse at death location, 24 h, one active, spawned into future instances | M4 | Provisional POC implemented; validate recovery/expiry behavior |
| 8 | Exact death penalties | Idle solo POC: on natural failed completion, lose 50% of each positive gold/item bag grant (floored; odd unit kept) and apply the level-scaled XP loss after adding expedition XP (live and idle alike; owner values 2026-11-04, [#129](#8-death-xp-penalty-level-scaled-129)); used escrow is consumed and unused escrow returned. Live penalties remain provisional in [rewards spec §4](spec/rewards-and-persistence.md). | M4/M6 + playtest | Provisional POC implemented; balance validation remains open |
| 9 | Crafting | Out of POC beyond placeholders | Post-POC | Deferred |
| 10 | Premium accelerator balance | Pacing multiplier on encounter budget, capped | Post-POC | Deferred |
| 11 | Direct purchase of resources or power | Not in POC | Post-POC | Deferred |
| 12 | Economy and player trading | No trading in POC | Post-POC | Deferred |
| 13 | Final skill and build system | ~8 skills, 4 active slots, 2 reference builds (bruiser/tank, striker/sustain) | M1 / M3 | Open |
| 14 | Enemy spawn and respawn rules | Rolled per instance on first entry (2 rolls, 1 in a boss room); no respawn within instance — [exact rules](#14-17-18-20-21-live-exploration-rules-38) | M4 | Implemented provisionally (#38), pending playtest |
| 15 | Start conditions for coop encounters | All members connected and in `none`; leader confirms | M8 | Open |
| 16 | Idle encounter pacing (`encountersPerHour`) and between-fight regen | Per region/activity in content; regen % HP | Spike 1 / M6 | Open (spike 1: Region 1 uses 30/h hunt, 10/h gather, 15 % regen, all provisional) |
| 17 | Return-to-Sanctuary rules in live | Only from `safe`/start locations, out of combat; amended: also from a cleared boss room — [exact rules](#14-17-18-20-21-live-exploration-rules-38) | M4 | Implemented provisionally (#38), pending playtest |
| 18 | Live retreat from combat | Allowed vs non-boss groups at a cost (10% max HP, fall back one location) — [exact rules](#14-17-18-20-21-live-exploration-rules-38) | M4 | Implemented provisionally (#38), pending playtest |
| 19 | Game name | — | Product | Open |
| 20 | Scope of world flags set by hotspots | Instance-scoped: shared by the instance's participants, not persisted to the actor — [exact rules](#14-17-18-20-21-live-exploration-rules-38) | M4 playtest / story design | Implemented provisionally (#38), pending playtest |
| 21 | Out-of-combat consumable use in live | Healing consumables only; `heal` and a whole `hot` apply at once — [exact rules](#14-17-18-20-21-live-exploration-rules-38) | M4 playtest | Implemented provisionally (#38), pending playtest |

## Notes

### #2 Balance evidence checkpoint

The evidence pair now includes the production idle simulation and settlement path in [runtime pass baseline](design/balance/runtime-pass-baseline.md), the production live plugin on a finite authored route in [live route baseline](design/balance/live-route-baseline.md), and the [economy sinks audit](design/balance/economy-sinks-audit.md). The live trace executes actual travel, engage, combat ticks, reward effects and return commands, but out-of-combat delays are sensitivity assumptions, not measured player timing. Its XP/hour denominator is the finite session’s combat duration plus an assumed delay per command; idle XP/hour is per requested content hour. These rates cannot be compared as sustainable throughput. DB ledger settlement, human command timing and repeat-route sustainability remain pending. Older hourly assumptions are not observations: free live regeneration, free group rerolls, 36 fights/hour and vendor value for drops are scenario assumptions (there is no sell command). Likewise, scenario/admin fixtures such as +4 attributes per level, design gear and Thornblade skills do not describe current new-player progression.

Current character creation seeds provisional attributes STR 9 / AGI 4 / INT 2 / VIT 10 / SPI 5 and four skills (shield bash, guard, cleave, mend), with zero unspent points and no starter equipment; see [character validation](../games/rpg/apps/server/src/characters/validation.ts) and [character service](../games/rpg/apps/server/src/characters/service.ts). Existing #13 behavior grants no attribute points on level change. Both baselines use this naked starter with explicit supplies. The live route measures plugin reward and death effects, but does not execute the PostgreSQL ledger/death hooks or model inventory acquisition and banking.

This is a methodological checkpoint, not a numeric finding or approval. Next, compare live and idle only after collecting human timing and DB settlement evidence, validate resource pressure, death behavior and the XP curve, then decide progression #13 separately before final formula targets. #2 remains open.

### #2 XP curve: open-ended (#129)

Owner decision, 2026-11-04 (provisional values, [#129](https://github.com/mcastrucci/idle-rpg-adventure/issues/129)):

- The authored table `[100, 250, 450, 700, 1000]` is unchanged, so every existing `(level, xp)` pair keeps its meaning.
- `content/progression/xp-curve.json` gains `tailGrowthBp: 12500`. For a level `L` beyond the table,
  `xpToNext(L) = ⌊xpToNext(L − 1) × tailGrowthBp / 10000⌋`: 1000 → 1250 → 1562 → 1952 → 2440 → 3050 …. There is **no
  maximum level**.
- Integer math on safe integers. The last level whose next threshold still fits in `Number.MAX_SAFE_INTEGER` (level
  132) acts as a deterministic cap; that safe-integer ceiling is the only limit. Every persisted XP quantity is a
  PostgreSQL `bigint` read and written as a JS safe integer (migration `0010_xp_bigint.sql`; in-level XP passes 32 bits
  at level 71), so reward settlement never fails on an XP value below that ceiling.
- Only the character that had piled XP up at the old cap (level 6 with ≥ 1250 XP into the level) changes: migration
  `0009_open_xp_curve.sql` turns its overflow into levels without changing total XP.
- Expedition snapshots persist the table and `tailGrowthBp`, so settlement never depends on deployed content. Whether
  the curve is *good* (pacing of levels 7+) remains part of the open balance pass.

### #8 Death XP penalty: level-scaled (#129)

Owner decision, 2026-11-04 (provisional values, [#129](https://github.com/mcastrucci/idle-rpg-adventure/issues/129)),
for live death and idle settlement alike. With `L` the level before the loss:

- `lossBp(L) = max(200, 1000 − 20 × (L − 1))` (10% at level 1, 8% at level 11, 2% from level 41);
- `xpLost = ⌊totalXp × lossBp(L) / 10000⌋`;
- one-level cap: total XP after the loss is never below the XP at which level `L − 1` starts, and never below 0 /
  level 1.

Item loss rules (50% of bag grants, corpse, escrow) are unchanged. Compatibility (ADR-0005): expeditions started
before this change were persisted under `rpg-idle@2.0.0` and settle with their original rule (10% of the next level's
requirement); new starts are stamped `rpg-idle@2.1.0` and use the level-scaled rule. Balance validation of both numbers
remains open.

### #5 Live disconnection policy (spike 3)

Spike 3 (#13, [ADR-0012](adr/0012-live-instance-hosting.md)) confirmed the proposal under adversarial tests and amended
it as follows. The 60 s grace and 30 s leases stay **provisional** numbers to tune in M4.

- **No pause.** A disconnected participant's character keeps acting through automation while the instance ticks
  (tested: a disconnect at the start of a losing fight still ends in death inside the grace). Out of combat it stays put.
- **Grace → `leaving` → `left`.** When the 60 s grace expires the participant becomes `leaving`; if its encounter is
  still running it keeps fighting until that encounter ends, then it is removed (`left`) and its activity lock is
  released in the same fenced transaction (run bag handling on leave stays with the run bag rules, still provisional).
  When every participant has left, the instance closes as `abandoned`.
- **Resume.** Reconnecting within the grace sends the last seen `(epoch, seq)`; the server replays exactly the missed
  events (bounded buffer) or sends a snapshot. Commands carry a `commandId` and are applied at most once per instance.
- **Node crash.** All participants restart as disconnected with a fresh grace from the moment another node restores the
  instance; reconnecting is impossible until the instance lease and the account's live-session lease expire (30 s
  each), which fits inside the grace. An encounter in progress restarts from its start (pre-encounter checkpoint).
- **One device.** A second device of the same account is refused while the first holds the live-session lease.

### #13 Attribute points on level change

Until #13 is resolved, changes in level from earned XP or death penalties neither grant nor revoke unspent points or
attributes. The level-up settlement hook must not change point allocation before an explicit decision; the existing
four active skill slots are a separate provisional loadout limit.

### #14, #17, #18, #20, #21 Live exploration rules (#38)

Implemented provisionally by #38 in the RPG live plugin (`games/rpg/apps/server/src/live/game.ts`; named constants
`SPAWN_ROLLS`, `BOSS_ROOM_SPAWN_ROLLS`, `RETREAT_HP_COST_BP`). **Not final**: every rule and number below waits for M4
playtests and may change without being treated as a regression.

- **#14 Spawns.** When the instance first enters a location that has an encounter table, the server rolls the table
  **2 times** (Region 1 design A10), or **once** in a `boss_room`; each roll is one enemy group. The roll uses the
  sim-core stream `spawn:<locationId>` of the instance seed, so it depends only on the instance and the location, not
  on the route or visit order. Groups are not re-rolled when the party comes back: defeated groups stay defeated for
  the rest of the instance; a new instance rolls again, so the mini-boss can be re-fought in every later instance.
  Boss credit (`bossDefeated` effect) goes to every participant who was in the winning fight; recording it once and
  evaluating conquest is #47. Outside boss rooms groups never aggro: combat starts with `engage`. A boss room's group
  aggroes on entry.
- **#17 Return to Sanctuary.** Out of combat only, from a location tagged `safe`, from the area's start location, or —
  amendment, since a boss room has no exits — from a `boss_room` whose groups are all defeated. Elsewhere the command
  is rejected (`not_safe_location`); in combat it is `in_combat`. The run bag commit is #42.
- **#18 Retreat.** Only in combat, only against a group with no `boss`-rank enemy and never in a `boss_room`
  (`retreat_not_allowed`). Always succeeds (no chance roll); cost: each living hero of the fight loses
  `⌊maxHp × 1000 / 10000⌋` HP (never below 1), and consumables used in the fight stay used. The party falls back to the
  location it came from (or stays, at the instance's first location); the group stays undefeated, at full HP next time.
- **#20 Hotspot flags** (new). Content declares hotspot `effects: [{ "setFlag": … }]` (not allowed on `lore`
  hotspots). The first successful `interact` per instance applies them; repeats show the text again and change nothing.
  Flags are **instance-scoped**: they satisfy `{ "flag": … }` exit requirements for every participant of that instance
  and are not persisted to the actor, so each new instance must pull the lever or search the panel again. The content
  compiler rejects an exit flag that no hotspot of the same area sets (`rpg.exitFlagNeverSet`). Persistent story flags
  (engine `world_flags`) remain future work.
- **#21 Out-of-combat consumables** (new). Out of combat, `useConsumable` accepts only consumables with a `heal` or
  `hot` effect from the hero's snapshot loadout, while the hero is alive and below max HP. `heal` heals
  `maxHp × coeff` (the combat engine's item scaling); a `hot` heals its whole duration at once
  (`perTick × ⌊ticks / period⌋`, tick durations only); other effects do nothing. Ledger consumption is #42/#28.
- **Exit requirements in a party** (new, provisional). An exit is open when its requirement holds for **every** present
  participant, evaluated against the server-recorded progress snapshot taken at instance start plus this instance's
  discoveries, boss defeats and flags. A locked `secret` exit is reported as `unknown_exit` and hidden from the view.
- **Not covered by #38:** live out-of-combat regeneration and full rest at `safe` locations (Region 1 design A9, open
  decision #16) — HP only changes through combat, retreat and consumables.
