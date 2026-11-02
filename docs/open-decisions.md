# Open Decisions

Pending decisions from the concept (§17) plus those surfaced by the design review. Each has a **provisional proposal** so
work can proceed, and a place where it must be resolved. Provisional values must not be treated as final: when resolved,
record the outcome here (and in an ADR if architectural).

| # | Decision | Provisional proposal | Resolve in | Status |
|---|---|---|---|---|
| 1 | Combat tick duration | 500 ms | Spike 1 / ADR-0013 | Open |
| 2 | XP, damage, defense and progression formulas | Integer formulas in [combat-engine.md](spec/combat-engine.md#4-formulas-provisional-integer-only); XP curve table | M1 balance pass | Open |
| 3 | Party loot distribution | Equal gold/XP split; round-robin loot (idle); personal loot (live) | M8 | Open |
| 4 | Max party size | 4 (POC validates 2) | M8 | Open |
| 5 | Live disconnection policy | 60 s grace; combat continues on automation; then `left` | Spike 3 / M4 | Open |
| 6 | Idle cancellation and partial rewards | Before the actual end, settle only revealed segments: their grants and used consumables apply, unused escrow returns, and no cancellation penalty applies. A cancel at/after the actual end settles as a natural completion. | M6 / kernel v0.3 | Resolved for solo POC; abuse/balance remains unvalidated |
| 7 | Corpse persistence and recovery in instances | Owner-only corpse at death location, 24 h, one active, spawned into future instances | M4 | Open |
| 8 | Exact death penalties | Idle solo POC: on natural failed completion, lose 50% of each positive gold/item bag grant (floored; odd unit kept) and apply 10% of the next-level XP requirement after adding expedition XP; used escrow is consumed and unused escrow returned. Live penalties remain in [rewards spec §4](spec/rewards-and-persistence.md). | M4/M6 + playtest | Idle behavior implemented; live behavior and balance validation remain open |
| 9 | Crafting | Out of POC beyond placeholders | Post-POC | Deferred |
| 10 | Premium accelerator balance | Pacing multiplier on encounter budget, capped | Post-POC | Deferred |
| 11 | Direct purchase of resources or power | Not in POC | Post-POC | Deferred |
| 12 | Economy and player trading | No trading in POC | Post-POC | Deferred |
| 13 | Final skill and build system | ~8 skills, 4 active slots, 2 reference builds (bruiser/tank, striker/sustain) | M1 / M3 | Open |
| 14 | Enemy spawn and respawn rules | Rolled per instance on first entry; no respawn within instance | M4 | Open |
| 15 | Start conditions for coop encounters | All members connected and in `none`; leader confirms | M8 | Open |
| 16 | Idle encounter pacing (`encountersPerHour`) and between-fight regen | Per region/activity in content; regen % HP | Spike 1 / M6 | Open |
| 17 | Return-to-Sanctuary rules in live | Only from `safe`/start locations, out of combat | M4 | Open |
| 18 | Live retreat from combat | Allowed vs non-boss groups at a cost | M4 | Open |
| 19 | Game name | — | Product | Open |
