# Open Decisions

Pending decisions from the concept (§17) plus those surfaced by the design review. Each has a **provisional proposal** so
work can proceed, and a place where it must be resolved. Provisional values must not be treated as final: when resolved,
record the outcome here (and in an ADR if architectural).

| # | Decision | Provisional proposal | Resolve in | Status |
|---|---|---|---|---|
| 1 | Combat tick duration | 500 ms | Spike 1 / ADR-0013 | Open (spike 1: idle cost is independent of tick; 500 ms kept as engine constant, feel to be judged in M4 playtests) |
| 2 | XP, damage, defense and progression formulas | Integer formulas in [combat-engine.md](spec/combat-engine.md#4-formulas-provisional-integer-only); XP curve table | M1 balance pass | Open |
| 3 | Party loot distribution | Equal gold/XP split; round-robin loot (idle); personal loot (live) | M8 | Open |
| 4 | Max party size | 4 (POC validates 2) | M8 | Open |
| 5 | Live disconnection policy | 60 s grace; combat continues on automation; then `left` | Spike 3 / M4 | Open |
| 6 | Idle cancellation and partial rewards | Revealed encounters granted; unused consumables returned; no extra penalty | M6 | Open |
| 7 | Corpse persistence and recovery in instances | Owner-only corpse at death location, 24 h, one active, spawned into future instances | M4 | Open |
| 8 | Exact death penalties | See [rewards spec §4](spec/rewards-and-persistence.md#4-death-penalties-provisional--open-decision-8) | M4/M6 + playtest | Open |
| 9 | Crafting | Out of POC beyond placeholders | Post-POC | Deferred |
| 10 | Premium accelerator balance | Pacing multiplier on encounter budget, capped | Post-POC | Deferred |
| 11 | Direct purchase of resources or power | Not in POC | Post-POC | Deferred |
| 12 | Economy and player trading | No trading in POC | Post-POC | Deferred |
| 13 | Final skill and build system | ~8 skills, 4 active slots, 2 reference builds (bruiser/tank, striker/sustain) | M1 / M3 | Open |
| 14 | Enemy spawn and respawn rules | Rolled per instance on first entry; no respawn within instance | M4 | Open |
| 15 | Start conditions for coop encounters | All members connected and in `none`; leader confirms | M8 | Open |
| 16 | Idle encounter pacing (`encountersPerHour`) and between-fight regen | Per region/activity in content; regen % HP | Spike 1 / M6 | Open (spike 1: Region 1 uses 30/h hunt, 10/h gather, 15 % regen, all provisional) |
| 17 | Return-to-Sanctuary rules in live | Only from `safe`/start locations, out of combat | M4 | Open |
| 18 | Live retreat from combat | Allowed vs non-boss groups at a cost | M4 | Open |
| 19 | Game name | — | Product | Open |
