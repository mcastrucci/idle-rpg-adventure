# Region 1 idle starter-kit paired baseline

- ENGINE_VERSION: `rpg-sim@1.1.0`; idle simulator: `rpg-idle@2.0.0+rpg-sim@1.1.0`
- Content hash: `c9531ec6b68c0c6c3213c3d07ce39a68767c92c931a11986b6e1f51a295488f3`; seed root: 56; 100 paired seeds per cell
- Command: `node games/rpg/tools/balance-sim/src/runtime-pass.ts --compare-starter-kit`; activity: `idle:region_1.hunt`; requested-hour budget: 30 slots
- Resolved production gear: item:rusty_sword (weapon; power 5, critBp 150); item:padded_vest (chest; armor 3, maxHp 10); item:wooden_buckler (offhand; armor 3)

Each naked/geared pair uses the same level, potion provision, rules, activity, and seed (`deriveSeed(seedRoot, 'runtime-pass', i)`). The kit is equipped in the snapshot; level-up does not add attributes. `idle-default-regen` is the current production idle tuning; `idle-no-regen-counterfactual` is a counterfactual sensitivity run, not another production policy.

| Model | Level | Potions | Deaths naked → kit | Timeouts naked → kit | Censored | Gross XP naked → kit | Net XP naked → kit | Gold retained proxy naked → kit | Potions used naked → kit | Combat ticks naked → kit | Δ deaths | Δ gross XP | Δ net XP | Δ gold proxy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| idle-default-regen | 1 | 0 | 100/100 → 81/100 | 0 → 0 | 0 | 116.35 → 358.01 | 98.8 → 332.91 | 10.3 → 42.74 | 0 → 0 | 312.69 → 546.51 | -19 | 241.66 | 234.11 | 32.44 |
| idle-default-regen | 1 | 5 | 99/100 → 58/100 | 0 → 0 | 0 | 214.21 → 462.32 | 191.06 → 442.27 | 19.75 → 65.33 | 3.43 → 2.94 | 582.85 → 681.76 | -41 | 248.11 | 251.21 | 45.58 |
| idle-default-regen | 3 | 0 | 79/100 → 11/100 | 0 → 0 | 0 | 348.52 → 613.26 | 309.47 → 608.06 | 42.88 → 107.33 | 0 → 0 | 676.17 → 691.65 | -68 | 264.74 | 298.59 | 64.45 |
| idle-default-regen | 3 | 5 | 66/100 → 0/100 | 0 → 0 | 0 | 410.68 → 655.21 | 376.98 → 655.21 | 55.93 → 117.81 | 2.52 → 1.48 | 772.94 → 722.82 | -66 | 244.53 | 278.23 | 61.88 |
| idle-default-regen | 5 | 0 | 0/100 → 0/100 | 0 → 0 | 0 | 655.21 → 655.21 | 655.21 → 655.21 | 117.81 → 117.81 | 0 → 0 | 960.9 → 588.06 | 0 | 0 | 0 | 0 |
| idle-default-regen | 5 | 5 | 0/100 → 0/100 | 0 → 0 | 0 | 655.21 → 655.21 | 655.21 → 655.21 | 117.81 → 117.81 | 1.63 → 0.05 | 945.12 → 588 | 0 | 0 | 0 | 0 |
| idle-no-regen-counterfactual | 1 | 0 | 100/100 → 100/100 | 0 → 0 | 0 | 60.11 → 127.34 | 49.01 → 106.24 | 5.26 → 11.13 | 0 → 0 | 169.1 → 227 | 0 | 67.23 | 57.23 | 5.87 |
| idle-no-regen-counterfactual | 1 | 5 | 100/100 → 100/100 | 0 → 0 | 0 | 130.61 → 260.03 | 109.91 → 232.78 | 11.74 → 23.34 | 3.75 → 3.82 | 390.38 → 510.4 | 0 | 129.42 | 122.87 | 11.6 |
| idle-no-regen-counterfactual | 3 | 0 | 100/100 → 94/100 | 0 → 0 | 0 | 184.39 → 309.83 | 138.14 → 263.53 | 16.17 → 30.88 | 0 → 0 | 420.79 → 475.73 | -6 | 125.44 | 125.39 | 14.71 |
| idle-no-regen-counterfactual | 3 | 5 | 89/100 → 61/100 | 0 → 0 | 0 | 313.45 → 457.8 | 269.9 → 425.35 | 34.07 → 63.09 | 3.11 → 3.14 | 727.5 → 689.51 | -28 | 144.35 | 155.45 | 29.02 |
| idle-no-regen-counterfactual | 5 | 0 | 58/100 → 14/100 | 0 → 0 | 0 | 472.41 → 610.94 | 414.41 → 596.94 | 66.19 → 104.92 | 0 → 0 | 877.96 → 777.2 | -44 | 138.53 | 182.53 | 38.73 |
| idle-no-regen-counterfactual | 5 | 5 | 17/100 → 0/100 | 0 → 0 | 0 | 602.41 → 655.21 | 585.41 → 655.21 | 102.51 → 117.81 | 3.35 → 2.25 | 1095.86 → 812.94 | -17 | 52.8 | 69.8 | 15.3 |

## Limits

- Gross XP is credited before death loss; net XP applies the production idle death penalty. Gold retained is the result of in-memory idle settlement math, not DB-confirmed banking or sales. Idle settlement has no live corpse flow; this gold quantity is not corpse-at-risk gold. Timeout count is reported separately and censored is zero for this completed idle matrix.
- Access to the Region 1 hunt activity is assumed already unlocked; a new level-1 character is not necessarily eligible to start it. Kit ownership/acquisition and potion provision are also assumed. L3/L5 potion cohorts are provisioned. Current server kit claim reachability is not evidence of a ledger grant, equipment transaction, or banked sales. This does not measure human play, DB evidence, or sustainable rates.
- This is a bounded current-code comparison, not a target or a balance verdict. Thornblade unlocks and level-scaled attributes are excluded.
