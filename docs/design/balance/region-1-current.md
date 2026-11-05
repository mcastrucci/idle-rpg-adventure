# Region 1 current authored balance readout (#46)

> Bounded measurement of the current authored Region 1 content and reference simulation. This is evidence for review, not a balance decision or gameplay tuning. No content or gameplay rules were changed.

## Reproduction and identity

From the repository root, with the frozen lockfile dependencies:

```sh
pnpm balance-sim --runs 500 --hours 200 --seed 24 --out /tmp/r1-current.md
```

- Tool: `@rpg/balance-sim`; engine: `rpg-sim@1.1.0`
- Content hash: `ae933a84ae6d4568cec7cfb893d5ed9db94ef7277a17d9baacf9e714cec03c82`
- Seed root 24; 500 fights per encounter cell and boss row; 200 hours per hourly row
- Scenario: provisional Bulwark and Thornblade reference builds, design gear/rules by level, four fight/boss potions and five idle-hour potions; idle regen 15%. Live route is the modelled efficient route (36 fights/hour, selected tables, mite-only groups skipped, 20% between-fight rest).

This is comparable in method and controls to the previous [Region 1 baseline](region-1-baseline.md) (same engine version, run counts, seed, and modeled scenario). The previous content hash was `3e22df61ea5af0aa41894a6eaca49a86e019d188326be06e324ed66a8fbc2609`; despite the hash difference, an independent comparison found all 361 generated data rows identical. No measured change is visible in this matrix. The report summarizes **PASS 131 · WARN 55 · N/A 4**; its point-target status is a simulator convention, not a release gate.

## What the measurements say

- **Common fights are reliable, but TTK misses are concentrated in short fights.** All single-enemy cells win at 100%. At their own level, several §7.2 common-fight checks miss the 15–35 tick band on the fast side: sentinel lantern (7 Bulwark, 1 Thornblade) and rusted tiller (13 Thornblade), among other fast build/group cells. Bulwark vs rusted tiller is within both bands (31 ticks, 19.65% HP lost); Thornblade vs tiller + sentinel meets TTK (21 ticks) but exceeds the separate HP-loss band (47.64% vs 10–35%). Mixed packs can be costly; Bulwark L4 vs tiller + sentinel takes 55 ticks and 38.15% HP. Thus high win rates do not mean every fight is inside both pacing and attrition targets.
- **Boss automation/attentive outcomes are materially outside the intended progression window.** The L3 target is 0–5% automation wins for both builds, with attentive targets of 15–25% Bulwark and 50–70% Thornblade. Measured: Bulwark 0.4% automation / 100% attentive (automation in target; attentive high); Thornblade 100% / 100% (both high). At L4, target automation is 15–30% Bulwark and 45–60% Thornblade; attentive target is 85–95% both. Both modes win 100% for both builds, above target. At L5, both modes are 100%, within the 90–100% automation and 95–100% attentive bands. Boss fight-length medians are within the design ±30% tolerances in all rows, which isolates the mismatch mainly to success probability and action effectiveness, rather than duration. The attentive script is an idealized prediction/guard/cleanse policy, not a human sample.
- **Idle XP/h is on target in this model.** Hunt is 651 XP/h against ≈650 ±15%; gather is 154 against ≈150 ±15%. Hunt gross gold is 227/h against ≈210 ±25%. Level-3 hunt potion use is below the 0.5–1.5/h target (Bulwark 0.01, Thornblade 0.33); level-4 potion and death targets pass. This is a fixed encounter-budget/hour model with carryover, regen and shared supplies, and reports gross XP before death loss.
- **The modeled live route exceeds its efficiency target but does not establish sustainable live throughput.** At L4 it reports 1154 XP/h Bulwark and 1157 Thornblade against ≈970 ±15%, a 1.77× idle ratio against the 1.40–1.60× target (above target; the separate ≥1.25 premium floor passes). Bulwark uses 3.48 potions/h (within 3–6); Thornblade uses 1.46 (below target). The model prescribes 36 fights/hour over selected tables; this is a scenario assumption, not observed human pace or an unlimited repeat route.

## Interpretation and next validation

The historical baseline remains useful for the earlier authored snapshot. This controlled matrix is identical across the two hashes, so no balance movement is evidenced here. Inspect source/content diffs to explain hash drift before attributing a future changed cell to a deliberate balance change. Neither this bounded reference scenario nor the older baseline measures fresh-player progression: per-level design gear and stats, pre-set skills, access and supplies are assumed. In particular, the probability of a real owner reaching the L3/L4 boss with this gear is unknown; the #56 report also notes that real-owner L8 boss close-loss risk with unknown gear remains unknown; these L3–L5 fixture rows do not resolve it.

The broader #56 decision remains open. The [runtime pass](runtime-pass-baseline.md) uses a fixed requested-hour idle model, while the [live route trace](live-route-baseline.md) is one finite production-plugin route with assumed per-command delays; neither demonstrates a sustainable live/idle rate. The separate [#56 economy proofs](death-economy-cycle.md) and [server economy cycle](server-economy-cycle.md) establish bounded transaction/reachability properties, not death frequency, natural owner behavior, human input timing, or a sustainable gameplay economy.

Validate first, before considering tuning:

1. Capture one reproducible owner boss attempt: level and allocated stats, equipped gear, skills and auto rules, potions carried/used, boss HP and outcome, and manual guard timing. Then replay a matched cohort in the simulator to compare like with like.
2. Validate attainable owner progression, gear and potion acquisition, and boss access. The high win rates here assume design gear; the #56-reported L8 close-loss risk with unknown gear remains unmeasured by this matrix.
3. To close #56, measure human command timing, banked rewards, death/corpse losses and repeatable live/idle throughput in matched attainable states. The modeled live XP premium alone is not a sustainable rate. Hash drift can be investigated separately; the historical comparison found no change across 361 generated data rows.

## Model limits

- Hero stats are `@rpg/rpg-stats` defaults, not the paper model; the reference gear/rules and Thornblade configuration are provisional fixtures.
- Cell combat is automation from full HP. Boss attentive mode is scripted and optimally timed. Outcomes use injected seeded combat randomness and do not represent population variance or player behavior.
- Idle hours chain modeled encounters with assumed regen and provisions; live XP/h is based on the prescribed efficient-route budget. Neither is DB-backed economy evidence or an observed sustainable rate.
- First-time conquest time, level on reaching the boss, pre-conquest deaths, and recurring sink share remain unmodelled (the report marks these N/A).
