# Region 1 production live starter-kit paired baseline

- Engine: `rpg-sim@1.1.0`; live plugin: `rpg.live@0.5.0+rpg-sim@1.1.0`; tick: 500 ms
- Content hash: `c9531ec6b68c0c6c3213c3d07ce39a68767c92c931a11986b6e1f51a295488f3`; seed root: 56; 100 paired seeds per cell
- Command: `node games/rpg/apps/server/scripts/balance-live.ts --compare-starter-kit`; route: loc:region_1.portal_clearing → loc:region_1.overgrown_causeway → loc:region_1.tangle_orchard → loc:region_1.irrigation_terraces → loc:region_1.old_well → loc:region_1.overgrown_causeway → loc:region_1.portal_clearing → returnToSanctuary
- Resolved production gear: item:rusty_sword (weapon; power 5, critBp 150); item:padded_vest (chest; armor 3, maxHp 10); item:wooden_buckler (offhand; armor 3)

Each naked/geared pair is the same starter build, level cohort, potion provision, route, rules, and seed (`deriveSeed(seedRoot, 'runtime-pass', i)`). Live XP can level the hero during the route; level-up grants no attributes. This finite production plugin trace reports event counts and effects; it does not estimate sustainable XP/hour.

| Level | Potions | Returned naked → kit | Dead naked → kit | Censored naked → kit | Gross XP grant naked → kit | Gold eligible on return naked → kit | Corpse-at-risk gold naked → kit | Potions used naked → kit | Combat ticks naked → kit | Commands naked → kit | Δ returned | Δ dead | Δ XP | Δ return gold | Δ corpse gold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 17 → 36 | 83 → 64 | 0 → 0 | 86.22 → 108.42 | 4.12 → 9.12 | 9.95 → 9.13 | 0 → 0 | 217.94 → 184.31 | 9.48 → 10.92 | 19 | -19 | 22.2 | 5 | -0.82 |
| 1 | 5 | 46 → 72 | 54 → 28 | 0 → 0 | 114.95 → 136.89 | 12.04 → 19.81 | 7.45 → 3.48 | 2.77 → 1.52 | 328.02 → 239.4 | 11.47 → 13.12 | 26 | -26 | 21.94 | 7.77 | -3.97 |
| 3 | 0 | 43 → 90 | 57 → 10 | 0 → 0 | 116.19 → 157.27 | 10.95 → 25.05 | 8.57 → 1.75 | 0 → 0 | 240.41 → 228.05 | 11.4 → 14.44 | 47 | -47 | 41.08 | 14.1 | -6.82 |
| 3 | 5 | 69 → 100 | 31 → 0 | 0 → 0 | 135.67 → 163.79 | 19.02 → 27.81 | 4.16 → 0 | 1.28 → 1.02 | 295.02 → 242.18 | 12.96 → 15 | 31 | -31 | 28.12 | 8.79 | -4.16 |
| 5 | 0 | 95 → 100 | 5 → 0 | 0 → 0 | 160.07 → 163.79 | 26.41 → 27.81 | 0.77 → 0 | 0 → 0 | 279.88 → 206.36 | 14.7 → 15 | 5 | -5 | 3.72 | 1.4 | -0.77 |
| 5 | 5 | 98 → 100 | 2 → 0 | 0 → 0 | 162.27 → 163.79 | 27.18 → 27.81 | 0.35 → 0 | 0.79 → 0.34 | 281.56 → 203.96 | 14.88 → 15 | 2 | -2 | 1.52 | 0.63 | -0.35 |

## Limits

- XP is gross live grant only; no net XP is projected. Gold eligible on return is a plugin bag proxy, not banked ledger evidence. Corpse-at-risk gold is the grants from deaths before the run bag is cleared; censored runs remain unsettled.
- Access to this route is assumed; starter-kit ownership/acquisition and potion provision are also assumptions. L3/L5 with potions are provisioned cohorts. Claim reachability does not measure actual ledger grant or equipment transactions. No human or DB evidence is included.
- The route is one finite authored path and excludes the Region 1 Matriarch/boss room. A 100/100 return count therefore does not show R1 conquest or boss success. Do not compare these live denominators with idle requested-hour denominators or treat the trace as a sustainable rate. Thornblade unlocks and level-scaled attributes are excluded.
