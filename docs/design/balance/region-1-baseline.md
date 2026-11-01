# Region 1 balance baseline (provisional)

> **Provisional baseline at ENGINE_VERSION `rpg-sim@1.1.0` / contentHash
> `3e22df61ea5af0aa…` (full hash in the generated header below).** Issue
> [#24](https://github.com/mcastrucci/idle-rpg-adventure/issues/24). These numbers measure the current structural
> Region 1 content ([checkpoint](../region-1-content.md)) and engine. They are compared against the provisional
> targets in the [paper design](../region-1.md) §5.3/§7. They are **not** balance decisions, and nothing was tuned.
> Re-run after any `ENGINE_VERSION` or content change.

Regenerate (≈ 20 s on the dev container, Node 22):

```sh
pnpm balance-sim --runs 500 --hours 200 --out report.md   # seed root 24, levels 1-5 / boss 3-5 / hourly 3-5, regen 15%
```

The generated report follows the observations unchanged, with its headings demoted one level.

## Observations vs targets

Summary: **PASS 131 · WARN 55 · N/A 4.** The idle economy is close to target. Common fights are faster and safer
than the paper model predicts. The mini-boss is far easier than intended.

1. **Commons die faster than §7.2 assumes, and Thornblade loses less HP.** Median kill times are multiples of the
   hero's action interval (1, 7, 13, 19, 25… ticks). `rpg-stats` uses a 6-tick base interval and different stat
   formulas from the paper model (A1/A3). From L2, Thornblade kills a lantern with one `precise_strike`; it does the
   same to a boar at L5. Those fights cost Thornblade 0% HP. **15 of the 36** §7.2 TTK targets WARN, as do 3 of the
   12 HP-lost targets (all Thornblade at L3). Every single-enemy cell has a 100% win rate from L1.
2. **The §7.2 band (15–35 ticks and 10–35% HP at the group's own level) misses at both ends.** Single commons at
   their own level are mostly too short. Median kill times: lantern 1–7 ticks, creeper 13–19, boar 9–19, tiller
   13–31. Mixed groups are too costly:
   - `rusted_tiller + sentinel_lantern` at L4 costs 38% HP for Bulwark (55 ticks) and 48% for Thornblade.
   - `glowcap_mite ×2 + sentinel_lantern` at L3 costs 36% / 46%.
   - `hollow_creeper + sentinel_lantern` at L3 costs Thornblade 39%.
   
   At L1, Bulwark always loses to `rusted_tiller + sentinel_lantern`, even with 4 potions.
3. **Mini-boss: success is far above §7.4 from L3 (Thornblade) and L4 (Bulwark).**
   - Automation wins 100% at L4 for both builds (targets: Bulwark 15–30%, Thornblade 45–60%).
   - Thornblade automation already wins 100% at L3 (target ≈ 0%).
   - The attentive live script wins 100% in every row, including L3 (targets: Bulwark 15–25%, Thornblade 50–70%).
   
   Fight lengths are within ±30% of the design in every row. Live potion use per win is below target: Bulwark L4
   1.81 (target 2–3.5) and L5 0.59 (target 1–3); Thornblade 0.51 at L4 and 0 at L5. Outcomes barely vary between
   seeds, because crits are the only randomness (fight-length p10 ≈ p90). Success rates therefore jump between
   adjacent levels instead of rising gradually.
4. **With #71, the live vs idle gap is now visible, about one level, but one level too low.** Guard now negates the
   `crushing_blow` stun. For Bulwark at L3, automation wins 0.4% and the attentive script wins 100%. At L4 the script
   also shortens the fight (229 vs 271 ticks) and saves a potion (1.81 vs 2.81). Thornblade's success is 100% in both
   modes from L3, so its gap shows only in potions (L3: 1.72 vs 3.99) and HP lost.
5. **Idle hunt meets its XP and gold targets.** Hunt gives 651 XP/h (target ≈ 650) and 227 gold/h gross (117 from
   enemies, 109 vendor value; target ≈ 210). Gather gives 154 XP/h (target ≈ 150). XP/h is the same for every build
   at levels 3–5, because no idle hour ended in a death; the encounter budget alone sets XP. At L3, potions/h is 0.01
   (Bulwark) and 0.33 (Thornblade), below the 0.5–1.5 target: 15% regen covers the cheap fights.
6. **The live route overshoots the margin.** At L4 the modelled efficient route yields 1154–1157 XP/h (target ≈ 970).
   That is **×1.77** idle (target ×1.40–×1.60). The ≥ ×1.25 premium-cap constraint passes, and gold is 346–349 g/h
   (target ≈ 320, PASS). The driver is the route assumption: 36 fights/h at ≈ 32 XP/fight on lantern ruins, pump
   station and terraces, against the design's ≈ 27 XP/fight. Potions/h at L4 is 3.48 for Bulwark (PASS) and 1.46 for
   Thornblade (target 3–6). At L3, Bulwark dies 0.88 times per hour on this route and Thornblade 0.17.
7. **The `selfHasHarmfulEffect` cleanse rule (Thornblade, §9 Q-B7) changes its fights.** `second_wind` now fires as
   soon as the creeper DoT lands, so creeper fights cost about 0% HP. The cleanse takes the place of attacks, so mixed
   creeper groups last longer (creeper + boar at L3: 33 ticks, previously 19 with the HP-threshold rule).
8. **Not modelled (N/A):** first-time conquest time, level on reaching the boss, deaths before conquest, and the
   gold-sink share. These need the live instance and conquest model (#38, open decisions #14/#16).

Inputs to revisit (no change made here):

- stat and action-interval formulas vs A1/A3 (open decision #2);
- boss HP and power vs hero scaling;
- mixed-group composition in the pump station, lantern ruins and greenhouse tables;
- the live-route model (fights per hour and table choice);
- the potion and regen assumptions.

## Generated report

> Provisional measurement at **rpg-sim@1.1.0** / contentHash `3e22df61ea5af0aa…`. Not a balance decision; balance is not a CI gate.

| Field | Value |
|---|---|
| tool | @rpg/balance-sim |
| ENGINE_VERSION | rpg-sim@1.1.0 |
| contentHash | `3e22df61ea5af0aa41894a6eaca49a86e019d188326be06e324ed66a8fbc2609` |
| scenario | region-1 (provisional reference builds, design §4.2–§4.3) |
| seed root | 24 |
| N (fights per cell, attempts per boss row) | 500 |
| hours per hourly row | 200 |
| cell levels | 1, 2, 3, 4, 5 |
| boss levels | 3, 4, 5 |
| hourly levels | 3, 4, 5 |
| potions carried: cell / boss / idle hour / live hour | 4 / 4 / 5 / 6 |
| idle between-fight regen (provisional) | 15.00% |
| live route | efficient live (lantern/tiller spots, mite-only packs skipped): 36 fights/h over enc:region_1.lantern_ruins, enc:region_1.pump_station, enc:region_1.terraces; skips groups made only of enemy:glowcap_mite; rest 20.00% between fights |

### Modelling assumptions

- All numbers are **provisional** measurements of the current content and engine, not balance decisions.
- Hero stats come from `@rpg/rpg-stats` defaults (not the paper model A3); builds, gear per level and rules are the provisional scenario in `games/rpg/tools/balance-sim/src/scenario.ts`.
- Cells: automation only (no manual input), hero starts at full HP with the cell potions; TTK percentiles are over wins only; HP lost is the mean net loss (a death counts as 100%).
- Boss "automation" = the build's boss rules only. Boss "attentive live" = same rules plus a script that queues `guard` at the last hero action before each predicted telegraphed hit and cleanses DoTs (Thornblade); manual inputs wait for the next ready tick (A8).
- Hourly rows chain fights with HP carry-over, regen between fights and a shared potion supply; an hour ends at the first death (or timeout), and a death keeps 50% of that hour's gold and loot. XP/h is gross (no death XP loss). Gold: enemy gold rolls; vendor value = item sell `value` of drops and idle resource yields.
- Idle encounter budget = `encountersPerHour` (pace multiplier 1); live route budget, route tables, skip rule, rest and potions are scenario assumptions.
- PASS/WARN tolerances for point targets are a tool convention; WARN never fails CI.

### Encounter groups (automation, full HP)

| Group | Grp lvl | Build | Hero L | Win | TTK p10 / p50 / p90 | HP lost | Potions/fight | Deaths | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| glowcap_mite ×2 | 1 | bulwark | 1 | 100.00% | 13 / 13 / 13 | 7.85% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | bulwark | 2 | 100.00% | 13 / 13 / 13 | 6.62% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | bulwark | 3 | 100.00% | 13 / 13 / 13 | 5.44% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | bulwark | 4 | 100.00% | 7 / 13 / 13 | 4.17% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | bulwark | 5 | 100.00% | 7 / 13 / 13 | 3.76% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | thornblade | 1 | 100.00% | 13 / 13 / 13 | 12.00% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | thornblade | 2 | 100.00% | 13 / 13 / 13 | 10.16% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | thornblade | 3 | 100.00% | 7 / 13 / 13 | 7.24% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | thornblade | 4 | 100.00% | 7 / 13 / 13 | 6.18% | 0.00 | 0 | 0 |
| glowcap_mite ×2 | 1 | thornblade | 5 | 100.00% | 7 / 13 / 13 | 5.54% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | bulwark | 1 | 100.00% | 19 / 25 / 25 | 19.19% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | bulwark | 2 | 100.00% | 13 / 13 / 13 | 10.84% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | bulwark | 3 | 100.00% | 13 / 13 / 13 | 8.91% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | bulwark | 4 | 100.00% | 13 / 13 / 13 | 6.94% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | bulwark | 5 | 100.00% | 13 / 13 / 13 | 6.25% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | thornblade | 1 | 100.00% | 13 / 13 / 13 | 20.00% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | thornblade | 2 | 100.00% | 13 / 13 / 13 | 16.94% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | thornblade | 3 | 100.00% | 13 / 13 / 13 | 12.36% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | thornblade | 4 | 100.00% | 13 / 13 / 13 | 10.47% | 0.00 | 0 | 0 |
| glowcap_mite ×3 | 1 | thornblade | 5 | 100.00% | 13 / 13 / 13 | 9.39% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | bulwark | 1 | 100.00% | 25 / 25 / 25 | 25.70% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | bulwark | 2 | 100.00% | 19 / 25 / 25 | 21.18% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | bulwark | 3 | 100.00% | 19 / 25 / 25 | 16.21% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | bulwark | 4 | 100.00% | 19 / 19 / 19 | 11.42% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | bulwark | 5 | 100.00% | 19 / 19 / 19 | 10.29% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | thornblade | 1 | 100.00% | 19 / 19 / 19 | 28.02% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | thornblade | 2 | 100.00% | 19 / 19 / 19 | 24.71% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | thornblade | 3 | 100.00% | 19 / 19 / 19 | 18.48% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | thornblade | 4 | 100.00% | 7 / 19 / 19 | 18.82% | 0.00 | 0 | 0 |
| glowcap_mite + thornback_boar | 2 | thornblade | 5 | 100.00% | 7 / 19 / 19 | 16.93% | 0.00 | 0 | 0 |
| thornback_boar | 2 | bulwark | 1 | 100.00% | 19 / 19 / 19 | 17.08% | 0.00 | 0 | 0 |
| thornback_boar | 2 | bulwark | 2 | 100.00% | 13 / 19 / 19 | 13.71% | 0.00 | 0 | 0 |
| thornback_boar | 2 | bulwark | 3 | 100.00% | 13 / 13 / 13 | 8.38% | 0.00 | 0 | 0 |
| thornback_boar | 2 | bulwark | 4 | 100.00% | 7 / 13 / 13 | 6.70% | 0.00 | 0 | 0 |
| thornback_boar | 2 | bulwark | 5 | 100.00% | 7 / 13 / 13 | 6.04% | 0.00 | 0 | 0 |
| thornback_boar | 2 | thornblade | 1 | 100.00% | 11 / 13 / 13 | 22.23% | 0.00 | 0 | 0 |
| thornback_boar | 2 | thornblade | 2 | 100.00% | 7 / 9 / 9 | 17.23% | 0.00 | 0 | 0 |
| thornback_boar | 2 | thornblade | 3 | 100.00% | 7 / 7 / 7 | 8.66% | 0.00 | 0 | 0 |
| thornback_boar | 2 | thornblade | 4 | 100.00% | 1 / 7 / 7 | 7.50% | 0.00 | 0 | 0 |
| thornback_boar | 2 | thornblade | 5 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | bulwark | 1 | 100.00% | 25 / 31 / 31 | 26.26% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | bulwark | 2 | 100.00% | 25 / 25 / 25 | 19.26% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | bulwark | 3 | 100.00% | 25 / 25 / 25 | 15.03% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | bulwark | 4 | 100.00% | 19 / 25 / 25 | 11.91% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | bulwark | 5 | 100.00% | 19 / 19 / 19 | 8.43% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | thornblade | 1 | 100.00% | 19 / 25 / 25 | 17.00% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | thornblade | 2 | 100.00% | 19 / 19 / 19 | 1.69% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | thornblade | 3 | 100.00% | 19 / 19 / 19 | 1.33% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | thornblade | 4 | 100.00% | 13 / 19 / 19 | 1.06% | 0.00 | 0 | 0 |
| glowcap_mite + hollow_creeper | 3 | thornblade | 5 | 100.00% | 13 / 19 / 19 | 0.95% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | bulwark | 1 | 100.00% | 43 / 43 / 43 | 54.57% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | bulwark | 2 | 100.00% | 19 / 37 / 37 | 41.37% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | bulwark | 3 | 100.00% | 19 / 19 / 19 | 35.64% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | bulwark | 4 | 100.00% | 19 / 19 / 19 | 29.46% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | bulwark | 5 | 100.00% | 13 / 19 / 19 | 25.44% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | thornblade | 1 | 100.00% | 25 / 25 / 25 | 54.00% | 1.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | thornblade | 2 | 100.00% | 25 / 25 / 25 | 41.52% | 1.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | thornblade | 3 | 100.00% | 17 / 19 / 19 | 45.92% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | thornblade | 4 | 100.00% | 13 / 19 / 19 | 37.55% | 0.00 | 0 | 0 |
| glowcap_mite ×2 + sentinel_lantern | 3 | thornblade | 5 | 100.00% | 13 / 19 / 19 | 33.72% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | bulwark | 1 | 100.00% | 19 / 19 / 19 | 14.28% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | bulwark | 2 | 100.00% | 19 / 19 / 19 | 11.81% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | bulwark | 3 | 100.00% | 13 / 19 / 19 | 8.40% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | bulwark | 4 | 100.00% | 13 / 13 / 13 | 5.44% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | bulwark | 5 | 100.00% | 13 / 13 / 13 | 4.90% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | thornblade | 1 | 100.00% | 13 / 13 / 13 | 2.00% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | thornblade | 2 | 100.00% | 13 / 13 / 13 | 0.00% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | thornblade | 3 | 100.00% | 13 / 13 / 13 | 0.00% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | thornblade | 4 | 100.00% | 1 / 13 / 13 | 0.00% | 0.00 | 0 | 0 |
| hollow_creeper | 3 | thornblade | 5 | 100.00% | 1 / 13 / 13 | 0.00% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | bulwark | 1 | 100.00% | 61 / 73 / 73 | 41.94% | 1.83 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | bulwark | 2 | 100.00% | 31 / 43 / 43 | 42.87% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | bulwark | 3 | 100.00% | 25 / 25 / 25 | 30.71% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | bulwark | 4 | 100.00% | 25 / 25 / 25 | 25.65% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | bulwark | 5 | 100.00% | 19 / 25 / 25 | 22.57% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | thornblade | 1 | 100.00% | 61 / 61 / 61 | 40.16% | 2.97 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | thornblade | 2 | 100.00% | 35 / 37 / 37 | 43.02% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | thornblade | 3 | 100.00% | 31 / 33 / 33 | 38.80% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | thornblade | 4 | 100.00% | 19 / 31 / 31 | 22.93% | 0.00 | 0 | 0 |
| hollow_creeper + sentinel_lantern | 3 | thornblade | 5 | 100.00% | 19 / 29 / 29 | 17.88% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | bulwark | 1 | 100.00% | 43 / 55 / 55 | 46.30% | 0.05 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | bulwark | 2 | 100.00% | 31 / 37 / 37 | 41.27% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | bulwark | 3 | 100.00% | 31 / 31 / 31 | 28.12% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | bulwark | 4 | 100.00% | 25 / 31 / 31 | 22.85% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | bulwark | 5 | 100.00% | 25 / 31 / 31 | 20.41% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | thornblade | 1 | 100.00% | 31 / 37 / 37 | 39.17% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | thornblade | 2 | 100.00% | 31 / 37 / 37 | 14.48% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | thornblade | 3 | 100.00% | 31 / 33 / 33 | 18.64% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | thornblade | 4 | 100.00% | 29 / 31 / 31 | 11.71% | 0.00 | 0 | 0 |
| hollow_creeper + thornback_boar | 3 | thornblade | 5 | 100.00% | 27 / 29 / 29 | 9.78% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | bulwark | 1 | 100.00% | 13 / 13 / 13 | 25.28% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | bulwark | 2 | 100.00% | 7 / 13 / 13 | 20.81% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | bulwark | 3 | 100.00% | 7 / 7 / 7 | 12.37% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | bulwark | 4 | 100.00% | 7 / 7 / 7 | 10.50% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | bulwark | 5 | 100.00% | 7 / 7 / 7 | 9.46% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | thornblade | 1 | 100.00% | 7 / 7 / 7 | 22.60% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | thornblade | 2 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | thornblade | 3 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | thornblade | 4 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |
| sentinel_lantern | 3 | thornblade | 5 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | bulwark | 1 | 100.00% | 61 / 61 / 61 | 44.23% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | bulwark | 2 | 100.00% | 37 / 37 / 37 | 41.10% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | bulwark | 3 | 100.00% | 31 / 37 / 37 | 30.03% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | bulwark | 4 | 100.00% | 31 / 31 / 31 | 19.65% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | bulwark | 5 | 100.00% | 25 / 31 / 31 | 16.89% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | thornblade | 1 | 100.00% | 13 / 19 / 19 | 38.00% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | thornblade | 2 | 100.00% | 13 / 13 / 13 | 32.20% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | thornblade | 3 | 100.00% | 13 / 13 / 13 | 25.34% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | thornblade | 4 | 100.00% | 13 / 13 / 13 | 21.95% | 0.00 | 0 | 0 |
| rusted_tiller | 4 | thornblade | 5 | 100.00% | 9 / 13 / 13 | 19.04% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | bulwark | 1 | 0.00% | – / – / – | 100.00% | 4.00 | 500 | 0 |
| rusted_tiller + sentinel_lantern | 4 | bulwark | 2 | 100.00% | 73 / 127 / 145 | 65.93% | 3.20 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | bulwark | 3 | 100.00% | 61 / 67 / 67 | 42.79% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | bulwark | 4 | 100.00% | 37 / 55 / 55 | 38.15% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | bulwark | 5 | 100.00% | 37 / 43 / 43 | 41.36% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | thornblade | 1 | 100.00% | 43 / 43 / 43 | 49.00% | 3.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | thornblade | 2 | 100.00% | 31 / 31 / 31 | 57.26% | 0.91 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | thornblade | 3 | 100.00% | 21 / 23 / 23 | 57.97% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | thornblade | 4 | 100.00% | 19 / 21 / 21 | 47.64% | 0.00 | 0 | 0 |
| rusted_tiller + sentinel_lantern | 4 | thornblade | 5 | 100.00% | 19 / 19 / 19 | 33.51% | 0.00 | 0 | 0 |

### Mini-boss attempts

| Build | Hero L | Mode | Success | Fight ticks p10 / p50 / p90 (wins) | Potions/attempt | Potions/win | HP lost | Deaths | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| bulwark | 3 | automation | 0.40% | 313 / 313 / 313 | 4.00 | 4.00 | 99.94% | 498 | 0 |
| bulwark | 3 | attentive live | 100.00% | 307 / 319 / 325 | 3.99 | 3.99 | 48.47% | 0 | 0 |
| bulwark | 4 | automation | 100.00% | 253 / 271 / 289 | 2.81 | 2.81 | 51.01% | 0 | 0 |
| bulwark | 4 | attentive live | 100.00% | 223 / 229 / 241 | 1.81 | 1.81 | 42.01% | 0 | 0 |
| bulwark | 5 | automation | 100.00% | 205 / 223 / 247 | 1.27 | 1.27 | 45.15% | 0 | 0 |
| bulwark | 5 | attentive live | 100.00% | 205 / 217 / 235 | 0.59 | 0.59 | 42.34% | 0 | 0 |
| thornblade | 3 | automation | 100.00% | 121 / 121 / 129 | 3.99 | 3.99 | 65.63% | 0 | 0 |
| thornblade | 3 | attentive live | 100.00% | 103 / 115 / 115 | 1.72 | 1.72 | 54.11% | 0 | 0 |
| thornblade | 4 | automation | 100.00% | 79 / 79 / 97 | 0.41 | 0.41 | 50.45% | 0 | 0 |
| thornblade | 4 | attentive live | 100.00% | 85 / 109 / 109 | 0.51 | 0.51 | 42.96% | 0 | 0 |
| thornblade | 5 | automation | 100.00% | 65 / 67 / 73 | 0.00 | 0.00 | 55.50% | 0 | 0 |
| thornblade | 5 | attentive live | 100.00% | 73 / 85 / 85 | 0.00 | 0.00 | 31.23% | 0 | 0 |

### XP and gold per hour

| Activity | Build | Hero L | XP/h (mean) | XP/h p10 / p50 / p90 | Enemy gold/h | Vendor value/h | Gross/h | Potions/h | Fights/h | Deaths/h |
|---|---|---|---|---|---|---|---|---|---|---|
| idle:region_1.hunt | bulwark | 3 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.01 | 30.00 | 0.00 |
| idle:region_1.hunt | bulwark | 4 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.00 | 30.00 | 0.00 |
| idle:region_1.hunt | bulwark | 5 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.00 | 30.00 | 0.00 |
| idle:region_1.hunt | thornblade | 3 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.33 | 30.00 | 0.00 |
| idle:region_1.hunt | thornblade | 4 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.03 | 30.00 | 0.00 |
| idle:region_1.hunt | thornblade | 5 | 651 | 604 / 648 / 701 | 117 | 109 | 227 | 0.00 | 30.00 | 0.00 |
| idle:region_1.gather | bulwark | 3 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| idle:region_1.gather | bulwark | 4 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| idle:region_1.gather | bulwark | 5 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| idle:region_1.gather | thornblade | 3 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| idle:region_1.gather | thornblade | 4 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| idle:region_1.gather | thornblade | 5 | 154 | 141 / 153 / 169 | 25 | 249 | 274 | 0.00 | 10.00 | 0.00 |
| live:route | bulwark | 3 | 505 | 139 / 433 / 1046 | 61 | 32 | 94 | 5.93 | 17.23 | 0.88 |
| live:route | bulwark | 4 | 1154 | 1090 / 1149 / 1239 | 227 | 118 | 346 | 3.48 | 35.93 | 0.01 |
| live:route | bulwark | 5 | 1157 | 1091 / 1150 / 1239 | 229 | 119 | 349 | 1.03 | 36.00 | 0.00 |
| live:route | thornblade | 3 | 1099 | 1013 / 1130 / 1195 | 202 | 105 | 308 | 4.09 | 34.47 | 0.17 |
| live:route | thornblade | 4 | 1157 | 1091 / 1150 / 1239 | 229 | 119 | 349 | 1.46 | 36.00 | 0.00 |
| live:route | thornblade | 5 | 1157 | 1091 / 1150 / 1239 | 229 | 119 | 349 | 0.26 | 36.00 | 0.00 |

### Targets (docs/design/region-1.md §5.3, §7)

PASS 131 · WARN 55 · N/A 4

| Ref | Metric | Subject | Target | Measured | Status |
|---|---|---|---|---|---|
| §7.2 | TTK p50 (ticks) | mite ×3 · bulwark L1 | 24 ±30% | 25 | PASS |
| §7.2 | win rate | mite ×3 · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | mite ×3 · bulwark L3 | 24 ±30% | 13 | WARN |
| §7.2 | win rate | mite ×3 · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | mite ×3 · bulwark L5 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | mite ×3 · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | mite ×3 · bulwark L3 | 16% ±10% (abs) | 8.91% | PASS |
| §7.2 | TTK p50 (ticks) | mite ×3 · thornblade L1 | 23 ±30% | 13 | WARN |
| §7.2 | win rate | mite ×3 · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | mite ×3 · thornblade L3 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | mite ×3 · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | mite ×3 · thornblade L5 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | mite ×3 · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | mite ×3 · thornblade L3 | 21% ±10% (abs) | 12.36% | PASS |
| §7.2 | TTK p50 (ticks) | boar · bulwark L1 | 24 ±30% | 19 | PASS |
| §7.2 | win rate | boar · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar · bulwark L3 | 19 ±30% | 13 | WARN |
| §7.2 | win rate | boar · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar · bulwark L5 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | boar · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | boar · bulwark L3 | 13% ±10% (abs) | 8.38% | PASS |
| §7.2 | TTK p50 (ticks) | boar · thornblade L1 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | boar · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar · thornblade L3 | 13 ±30% | 7 | WARN |
| §7.2 | win rate | boar · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar · thornblade L5 | 9 ±30% | 1 | WARN |
| §7.2 | win rate | boar · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | boar · thornblade L3 | 19% ±10% (abs) | 8.66% | WARN |
| §7.2 | TTK p50 (ticks) | creeper · bulwark L1 | 29 ±30% | 19 | WARN |
| §7.2 | win rate | creeper · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | creeper · bulwark L3 | 23 ±30% | 19 | PASS |
| §7.2 | win rate | creeper · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | creeper · bulwark L5 | 19 ±30% | 13 | WARN |
| §7.2 | win rate | creeper · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | creeper · bulwark L3 | 14% ±10% (abs) | 8.40% | PASS |
| §7.2 | TTK p50 (ticks) | creeper · thornblade L1 | 20 ±30% | 13 | WARN |
| §7.2 | win rate | creeper · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | creeper · thornblade L3 | 15 ±30% | 13 | PASS |
| §7.2 | win rate | creeper · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | creeper · thornblade L5 | 14 ±30% | 13 | PASS |
| §7.2 | win rate | creeper · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | creeper · thornblade L3 | 2% ±10% (abs) | 0.00% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · bulwark L1 | 19 ±30% | 13 | WARN |
| §7.2 | win rate | lantern · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · bulwark L3 | 14 ±30% | 7 | WARN |
| §7.2 | win rate | lantern · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · bulwark L5 | 9 ±30% | 7 | PASS |
| §7.2 | win rate | lantern · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | lantern · bulwark L3 | 19% ±10% (abs) | 12.37% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · thornblade L1 | 9 ±30% | 7 | PASS |
| §7.2 | win rate | lantern · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · thornblade L3 | 9 ±30% | 1 | WARN |
| §7.2 | win rate | lantern · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | lantern · thornblade L5 | 4 ±30% | 1 | WARN |
| §7.2 | win rate | lantern · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | lantern · thornblade L3 | 14% ±10% (abs) | 0.00% | WARN |
| §7.2 | TTK p50 (ticks) | tiller · bulwark L1 | 73 ±30% | 61 | PASS |
| §7.2 | win rate | tiller · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | tiller · bulwark L3 | 44 ±30% | 37 | PASS |
| §7.2 | win rate | tiller · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | tiller · bulwark L5 | 33 ±30% | 31 | PASS |
| §7.2 | win rate | tiller · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | tiller · bulwark L3 | 37% ±10% (abs) | 30.03% | PASS |
| §7.2 | TTK p50 (ticks) | tiller · thornblade L1 | 30 ±30% | 19 | WARN |
| §7.2 | win rate | tiller · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | tiller · thornblade L3 | 21 ±30% | 13 | WARN |
| §7.2 | win rate | tiller · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | tiller · thornblade L5 | 15 ±30% | 13 | PASS |
| §7.2 | win rate | tiller · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | tiller · thornblade L3 | 32% ±10% (abs) | 25.34% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · bulwark L1 | 34 ±30% | 25 | PASS |
| §7.2 | win rate | boar + mite · bulwark L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · bulwark L3 | 24 ±30% | 25 | PASS |
| §7.2 | win rate | boar + mite · bulwark L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · bulwark L5 | 24 ±30% | 19 | PASS |
| §7.2 | win rate | boar + mite · bulwark L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | boar + mite · bulwark L3 | 20% ±10% (abs) | 16.21% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · thornblade L1 | 29 ±30% | 19 | WARN |
| §7.2 | win rate | boar + mite · thornblade L1 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · thornblade L3 | 19 ±30% | 19 | PASS |
| §7.2 | win rate | boar + mite · thornblade L3 | ≥ 99% | 100.00% | PASS |
| §7.2 | TTK p50 (ticks) | boar + mite · thornblade L5 | 19 ±30% | 19 | PASS |
| §7.2 | win rate | boar + mite · thornblade L5 | ≥ 99% | 100.00% | PASS |
| §7.2 | HP lost per fight | boar + mite · thornblade L3 | 31% ±10% (abs) | 18.48% | WARN |
| §7.2 band | TTK p50 at own level | glowcap_mite ×2 · bulwark L1 | 15–35 ticks | 13 | WARN |
| §7.2 band | HP lost at own level | glowcap_mite ×2 · bulwark L1 | 10–35% | 7.85% | WARN |
| §7.2 band | TTK p50 at own level | glowcap_mite ×2 · thornblade L1 | 15–35 ticks | 13 | WARN |
| §7.2 band | HP lost at own level | glowcap_mite ×2 · thornblade L1 | 10–35% | 12.00% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite ×3 · bulwark L1 | 15–35 ticks | 25 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite ×3 · bulwark L1 | 10–35% | 19.19% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite ×3 · thornblade L1 | 15–35 ticks | 13 | WARN |
| §7.2 band | HP lost at own level | glowcap_mite ×3 · thornblade L1 | 10–35% | 20.00% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite + thornback_boar · bulwark L2 | 15–35 ticks | 25 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite + thornback_boar · bulwark L2 | 10–35% | 21.18% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite + thornback_boar · thornblade L2 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite + thornback_boar · thornblade L2 | 10–35% | 24.71% | PASS |
| §7.2 band | TTK p50 at own level | thornback_boar · bulwark L2 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | thornback_boar · bulwark L2 | 10–35% | 13.71% | PASS |
| §7.2 band | TTK p50 at own level | thornback_boar · thornblade L2 | 15–35 ticks | 9 | WARN |
| §7.2 band | HP lost at own level | thornback_boar · thornblade L2 | 10–35% | 17.23% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite + hollow_creeper · bulwark L3 | 15–35 ticks | 25 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite + hollow_creeper · bulwark L3 | 10–35% | 15.03% | PASS |
| §7.2 band | TTK p50 at own level | glowcap_mite + hollow_creeper · thornblade L3 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite + hollow_creeper · thornblade L3 | 10–35% | 1.33% | WARN |
| §7.2 band | TTK p50 at own level | glowcap_mite ×2 + sentinel_lantern · bulwark L3 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite ×2 + sentinel_lantern · bulwark L3 | 10–35% | 35.64% | WARN |
| §7.2 band | TTK p50 at own level | glowcap_mite ×2 + sentinel_lantern · thornblade L3 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | glowcap_mite ×2 + sentinel_lantern · thornblade L3 | 10–35% | 45.92% | WARN |
| §7.2 band | TTK p50 at own level | hollow_creeper · bulwark L3 | 15–35 ticks | 19 | PASS |
| §7.2 band | HP lost at own level | hollow_creeper · bulwark L3 | 10–35% | 8.40% | WARN |
| §7.2 band | TTK p50 at own level | hollow_creeper · thornblade L3 | 15–35 ticks | 13 | WARN |
| §7.2 band | HP lost at own level | hollow_creeper · thornblade L3 | 10–35% | 0.00% | WARN |
| §7.2 band | TTK p50 at own level | hollow_creeper + sentinel_lantern · bulwark L3 | 15–35 ticks | 25 | PASS |
| §7.2 band | HP lost at own level | hollow_creeper + sentinel_lantern · bulwark L3 | 10–35% | 30.71% | PASS |
| §7.2 band | TTK p50 at own level | hollow_creeper + sentinel_lantern · thornblade L3 | 15–35 ticks | 33 | PASS |
| §7.2 band | HP lost at own level | hollow_creeper + sentinel_lantern · thornblade L3 | 10–35% | 38.80% | WARN |
| §7.2 band | TTK p50 at own level | hollow_creeper + thornback_boar · bulwark L3 | 15–35 ticks | 31 | PASS |
| §7.2 band | HP lost at own level | hollow_creeper + thornback_boar · bulwark L3 | 10–35% | 28.12% | PASS |
| §7.2 band | TTK p50 at own level | hollow_creeper + thornback_boar · thornblade L3 | 15–35 ticks | 33 | PASS |
| §7.2 band | HP lost at own level | hollow_creeper + thornback_boar · thornblade L3 | 10–35% | 18.64% | PASS |
| §7.2 band | TTK p50 at own level | sentinel_lantern · bulwark L3 | 15–35 ticks | 7 | WARN |
| §7.2 band | HP lost at own level | sentinel_lantern · bulwark L3 | 10–35% | 12.37% | PASS |
| §7.2 band | TTK p50 at own level | sentinel_lantern · thornblade L3 | 15–35 ticks | 1 | WARN |
| §7.2 band | HP lost at own level | sentinel_lantern · thornblade L3 | 10–35% | 0.00% | WARN |
| §7.2 band | TTK p50 at own level | rusted_tiller · bulwark L4 | 15–35 ticks | 31 | PASS |
| §7.2 band | HP lost at own level | rusted_tiller · bulwark L4 | 10–35% | 19.65% | PASS |
| §7.2 band | TTK p50 at own level | rusted_tiller · thornblade L4 | 15–35 ticks | 13 | WARN |
| §7.2 band | HP lost at own level | rusted_tiller · thornblade L4 | 10–35% | 21.95% | PASS |
| §7.2 band | TTK p50 at own level | rusted_tiller + sentinel_lantern · bulwark L4 | 15–35 ticks | 55 | WARN |
| §7.2 band | HP lost at own level | rusted_tiller + sentinel_lantern · bulwark L4 | 10–35% | 38.15% | WARN |
| §7.2 band | TTK p50 at own level | rusted_tiller + sentinel_lantern · thornblade L4 | 15–35 ticks | 21 | PASS |
| §7.2 band | HP lost at own level | rusted_tiller + sentinel_lantern · thornblade L4 | 10–35% | 47.64% | WARN |
| §7.4 | boss success (attentive live) | bulwark L3 | 15%–25% | 100.00% | WARN |
| §7.4 | boss success (automation) | bulwark L3 | 0%–5% | 0.40% | PASS |
| §7.4 | boss fight length p50, live wins (ticks) | bulwark L3 | 360 ±30% | 319 | PASS |
| §7.4 | boss success (attentive live) | bulwark L4 | 85%–95% | 100.00% | WARN |
| §7.4 | boss success (automation) | bulwark L4 | 15%–30% | 100.00% | WARN |
| §7.4 | boss fight length p50, live wins (ticks) | bulwark L4 | 300 ±30% | 229 | PASS |
| §7.4 | potions per winning live attempt | bulwark L4 | 2.00–3.50 | 1.81 | WARN |
| §7.4 | boss success (attentive live) | bulwark L5 | 95%–100% | 100.00% | PASS |
| §7.4 | boss success (automation) | bulwark L5 | 90%–100% | 100.00% | PASS |
| §7.4 | boss fight length p50, live wins (ticks) | bulwark L5 | 235 ±30% | 217 | PASS |
| §7.4 | potions per winning live attempt | bulwark L5 | 1.00–3.00 | 0.59 | WARN |
| §7.4 | boss success (attentive live) | thornblade L3 | 50%–70% | 100.00% | WARN |
| §7.4 | boss success (automation) | thornblade L3 | 0%–5% | 100.00% | WARN |
| §7.4 | boss fight length p50, live wins (ticks) | thornblade L3 | 160 ±30% | 115 | PASS |
| §7.4 | boss success (attentive live) | thornblade L4 | 85%–95% | 100.00% | WARN |
| §7.4 | boss success (automation) | thornblade L4 | 45%–60% | 100.00% | WARN |
| §7.4 | boss fight length p50, live wins (ticks) | thornblade L4 | 125 ±30% | 109 | PASS |
| §7.4 | potions per winning live attempt | thornblade L4 | 2.00–3.50 | 0.51 | WARN |
| §7.4 | boss success (attentive live) | thornblade L5 | 95%–100% | 100.00% | PASS |
| §7.4 | boss success (automation) | thornblade L5 | 90%–100% | 100.00% | PASS |
| §7.4 | boss fight length p50, live wins (ticks) | thornblade L5 | 105 ±30% | 85 | PASS |
| §7.4 | potions per winning live attempt | thornblade L5 | 1.00–3.00 | 0.00 | WARN |
| §7.3 | XP/h | idle hunt · bulwark L4 | ≈ 650 ±15% | 651 | PASS |
| §7.3 | potions/h | idle hunt · bulwark L4 | ≤ 1 | 0.00 | PASS |
| §7.3 | deaths/h | idle hunt · bulwark L4 | < 1% | 0.00% | PASS |
| §5.3 | gross gold/h | idle hunt · bulwark L4 | ≈ 210 ±25% | 227 | PASS |
| §5.3 | enemy gold/h | idle hunt · bulwark L4 | ≈ 120 ±25% | 117 | PASS |
| §5.3 | vendor value/h | idle hunt · bulwark L4 | ≈ 90 ±25% | 109 | PASS |
| §7.3 | potions/h | idle hunt · bulwark L3 | 0.50–1.50 | 0.01 | WARN |
| §7.3 | XP/h | idle gather · bulwark L4 | ≈ 150 ±15% | 154 | PASS |
| §7.3 | deaths/h | idle gather · bulwark L4 | < 1% | 0.00% | PASS |
| §7.3 | XP/h | live route · bulwark L4 | ≈ 970 ±15% | 1154 | WARN |
| §7.3 | potions/h | live route · bulwark L4 | 3–6 | 3.48 | PASS |
| §5.3 | gross gold/h | live route · bulwark L4 | ≈ 320 ±25% | 346 | PASS |
| §7.3 | live/idle XP ratio | bulwark L4 | ×1.40–×1.60 | ×1.77 | WARN |
| §7.3 | live ≥ idle × premium cap 1.25 | bulwark L4 | ≥ ×1.25 | ×1.77 | PASS |
| §7.1/§7.3 | deaths/h | live route · bulwark L4 | ≤ 0.10 | 0.01 | PASS |
| §7.1/§7.3 | deaths/h | live route · bulwark L5 | ≤ 0.10 | 0.00 | PASS |
| §7.3 | XP/h | idle hunt · thornblade L4 | ≈ 650 ±15% | 651 | PASS |
| §7.3 | potions/h | idle hunt · thornblade L4 | ≤ 1 | 0.03 | PASS |
| §7.3 | deaths/h | idle hunt · thornblade L4 | < 1% | 0.00% | PASS |
| §5.3 | gross gold/h | idle hunt · thornblade L4 | ≈ 210 ±25% | 227 | PASS |
| §5.3 | enemy gold/h | idle hunt · thornblade L4 | ≈ 120 ±25% | 117 | PASS |
| §5.3 | vendor value/h | idle hunt · thornblade L4 | ≈ 90 ±25% | 109 | PASS |
| §7.3 | potions/h | idle hunt · thornblade L3 | 0.50–1.50 | 0.33 | WARN |
| §7.3 | XP/h | idle gather · thornblade L4 | ≈ 150 ±15% | 154 | PASS |
| §7.3 | deaths/h | idle gather · thornblade L4 | < 1% | 0.00% | PASS |
| §7.3 | XP/h | live route · thornblade L4 | ≈ 970 ±15% | 1157 | WARN |
| §7.3 | potions/h | live route · thornblade L4 | 3–6 | 1.46 | WARN |
| §5.3 | gross gold/h | live route · thornblade L4 | ≈ 320 ±25% | 349 | PASS |
| §7.3 | live/idle XP ratio | thornblade L4 | ×1.40–×1.60 | ×1.77 | WARN |
| §7.3 | live ≥ idle × premium cap 1.25 | thornblade L4 | ≥ ×1.25 | ×1.77 | PASS |
| §7.1/§7.3 | deaths/h | live route · thornblade L4 | ≤ 0.10 | 0.00 | PASS |
| §7.1/§7.3 | deaths/h | live route · thornblade L5 | ≤ 0.10 | 0.00 | PASS |
| §7.1 | first-time conquest (live, median) | region | 45–60 min, 20–25 encounters | not modelled (needs the live instance/conquest model) | N/A |
| §7.1 | level on reaching the boss | region | 4 (3–5) | not modelled (needs the live instance/conquest model) | N/A |
| §7.1 | deaths before conquest | region | mean ≤ 0.8, p90 ≤ 2 | not modelled (needs the live instance/conquest model) | N/A |
| §5.3 | recurring sinks share of gross gold | live / idle | 20–35% / 5–15% | not modelled (needs the live instance/conquest model) | N/A |
