# Region 1 production live route trace

- Engine: `rpg-sim@1.1.0`; live plugin: `rpg.live@0.5.0+rpg-sim@1.1.0`; tick: 500 ms
- Content hash: `c9531ec6b68c0c6c3213c3d07ce39a68767c92c931a11986b6e1f51a295488f3`; seed root: 56; 100 seeds per cell
- Command: `node games/rpg/apps/server/scripts/balance-live.ts`; route: loc:region_1.portal_clearing → loc:region_1.overgrown_causeway → loc:region_1.tangle_orchard → loc:region_1.irrigation_terraces → loc:region_1.old_well → loc:region_1.overgrown_causeway → loc:region_1.portal_clearing → returnToSanctuary

The script runs the actual `createRpgLiveGame(compiled.bundle)` plugin. Each location’s actual rolled undefeated groups are engaged once with production commands; effects are captured from every command and combat tick. The starter attributes, skills and base rules come from server validation; the potion rule is inserted before the basic-attack fallback in the same order and with the same threshold as the idle runtime pass. L1/L3/L5 denote initial level cohorts; live XP is granted on each victory and the plugin updates the hero level during the route, while the idle runtime pass holds the cohort snapshot level. The trace assumes access/init is permitted and inventory provisioned; it does not model acquisition.

| Level | Carried potions | Returned | Dead | Censored | Mean XP grant | Mean gold effects | Gold eligible on return | Corpse-at-risk gold | Potions used | Combat ticks | Commands | XP/h at 0s, 5s, 30s per command |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 0 | 17 | 83 | 0 | 86.22 | 14.07 | 4.12 | 9.95 | 0 | 217.94 | 9.48 | 0s: 2848.42; 5s: 1984.98; 30s: 789.06 |
| 1 | 5 | 46 | 54 | 0 | 114.95 | 19.49 | 12.04 | 7.45 | 2.77 | 328.02 | 11.47 | 0s: 2523.14; 5s: 1869.44; 30s: 814.43 |
| 3 | 0 | 43 | 57 | 0 | 116.19 | 19.52 | 10.95 | 8.57 | 0 | 240.41 | 11.4 | 0s: 3479.76; 5s: 2360.45; 30s: 904.98 |
| 3 | 5 | 69 | 31 | 0 | 135.67 | 23.18 | 19.02 | 4.16 | 1.28 | 295.02 | 12.96 | 0s: 3311.04; 5s: 2300.47; 30s: 910.69 |
| 5 | 0 | 95 | 5 | 0 | 160.07 | 27.18 | 26.41 | 0.77 | 0 | 279.88 | 14.7 | 0s: 4117.85; 5s: 2699.83; 30s: 991.93 |
| 5 | 5 | 98 | 2 | 0 | 162.27 | 27.53 | 27.18 | 0.35 | 0.79 | 281.56 | 14.88 | 0s: 4149.54; 5s: 2714.81; 30s: 994.88 |

## Limits

- Seeds are `deriveSeed(56, 'runtime-pass', i)`, paired by index with the idle pass for conceptual comparison. Live/idle random streams differ, so pairing does not mean identical fights.
- This is an offline plugin trace, not DB ledger settlement or human telemetry. XP/gold are measured from actual grant effects. XP is gross granted only; death has internal level-sensitive floor semantics, so no net XP projection is reported. Gold eligible on return is plugin bag value, not ledger-confirmed banking; corpse-at-risk gold totals grants from deaths before the plugin clears the run bag.
- Gold in the run bag is recovered only on successful return. On death it is marked corpse-at-risk; no recovery probability is inferred. Censored runs are unsettled. No rest, reset, reroll, respawn, or repeat route is modeled.
- XP/hour is a sensitivity calculation: actual combat ticks × 500 ms plus 0, 5, or 30 seconds for each recorded out-of-combat command (travel, engage, return). It assumes only this single finite route and is not an unlimited route rate or optimal/manual-player claim.
- The idle runtime-pass baseline reports XP per requested content hour; this trace normalizes XP over one finite live session using combat ticks and assumed command delays. These denominators differ, so the rates cannot be read as a sustainable idle/live throughput comparison.
- The live plugin applies victory XP and may level the hero up during the route. Idle runtime-pass runs hold the requested level snapshot, so level cohorts are not otherwise identical across the two passes.
- Entry gate and inventory provision are assumed; no acquisition, access, banking, or persistence transaction is simulated. The complete authored route is portal_clearing → overgrown_causeway → tangle_orchard → irrigation_terraces → old_well → overgrown_causeway → portal_clearing → returnToSanctuary. The old well is not safe; all actual groups there are fought. Causeway groups remain defeated on revisit.
- A deterministic successful L5/0-potion run is retained as a compact diagnostic trace by the exported function for test assertions; the baseline includes aggregate counts only.
