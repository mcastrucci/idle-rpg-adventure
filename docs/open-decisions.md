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
| 5 | Live disconnection policy | 60 s grace; combat continues on automation; then `left` — **amended by spike 3**, see [below](#5-live-disconnection-policy-spike-3) | Spike 3 / M4 | Confirmed with amendments (values provisional) |
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
| 16 | Idle encounter pacing (`encountersPerHour`) and between-fight regen | Per region/activity in content; regen % HP | Spike 1 / M6 | Open (spike 1: Region 1 uses 30/h hunt, 10/h gather, 15 % regen, all provisional) |
| 17 | Return-to-Sanctuary rules in live | Only from `safe`/start locations, out of combat | M4 | Open |
| 18 | Live retreat from combat | Allowed vs non-boss groups at a cost | M4 | Open |
| 19 | Game name | — | Product | Open |

## Notes

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
