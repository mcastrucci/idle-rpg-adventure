# Region 1 runtime evidence pass

- ENGINE_VERSION: `rpg-sim@1.1.0`
- Combat engine: `rpg-idle@2.0.0+rpg-sim@1.1.0`
- Content hash: `c9531ec6b68c0c6c3213c3d07ce39a68767c92c931a11986b6e1f51a295488f3`
- Seed root: 56; 100 paired seeds per cell
- Command: `node games/rpg/tools/balance-sim/src/runtime-pass.ts`
- Activity: `idle:region_1.hunt`; budget 30 slots = one requested content hour by the production idle budget function

Actor for every cell: naked provisional starter character. The current server starter snapshot is level 1, attributes STR 9 / AGI 4 / INT 2 / VIT 10 / SPI 5, no equipped items, Basic Attack plus the four unlocked starter skills, and the starter automation rules. L3 and L5 change only the level field: current level-ups do not grant attribute points (open decision #13). The sixth rule uses a carried minor healing potion below 40% HP; each seeded expedition receives exactly 0 or 5 escrowed potions.

| Model | Level | Potions | Mean slots | Deaths / runs | Timeouts | Combat ticks / run | Gross XP / requested hour | Net XP / requested hour | Mean death XP loss / run | Gold kept | Potions used |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| idle-default-regen | 1 | 0 | 7.02 | 100/100 | 0 | 312.69 | 116.35 | 98.8 | 17.55 | 10.3 | 0 |
| idle-default-regen | 1 | 5 | 11.63 | 99/100 | 0 | 582.85 | 214.21 | 191.06 | 23.15 | 19.75 | 3.43 |
| idle-default-regen | 3 | 0 | 17.57 | 79/100 | 0 | 676.17 | 348.52 | 309.47 | 39.05 | 42.88 | 0 |
| idle-default-regen | 3 | 5 | 20.28 | 66/100 | 0 | 772.94 | 410.68 | 376.98 | 33.7 | 55.93 | 2.52 |
| idle-default-regen | 5 | 0 | 30 | 0/100 | 0 | 960.9 | 655.21 | 655.21 | 0 | 117.81 | 0 |
| idle-default-regen | 5 | 5 | 30 | 0/100 | 0 | 945.12 | 655.21 | 655.21 | 0 | 117.81 | 1.63 |
| idle-no-regen-counterfactual | 1 | 0 | 4.09 | 100/100 | 0 | 169.1 | 60.11 | 49.01 | 11.1 | 5.26 | 0 |
| idle-no-regen-counterfactual | 1 | 5 | 7.54 | 100/100 | 0 | 390.38 | 130.61 | 109.91 | 20.7 | 11.74 | 3.75 |
| idle-no-regen-counterfactual | 3 | 0 | 10.15 | 100/100 | 0 | 420.79 | 184.39 | 138.14 | 46.25 | 16.17 | 0 |
| idle-no-regen-counterfactual | 3 | 5 | 16.16 | 89/100 | 0 | 727.5 | 313.45 | 269.9 | 43.55 | 34.07 | 3.11 |
| idle-no-regen-counterfactual | 5 | 0 | 22.65 | 58/100 | 0 | 877.96 | 472.41 | 414.41 | 58 | 66.19 | 0 |
| idle-no-regen-counterfactual | 5 | 5 | 27.91 | 17/100 | 0 | 1095.86 | 602.41 | 585.41 | 17 | 102.51 | 3.35 |

## Interpretation and limits

- Idle rows run the actual compiled-content `simulateIdle`, `rpgProgress`, `settleIdle`, and XP-loss functions. Gross XP includes kill XP through the fatal segment; net XP applies the runtime death penalty after adding that gross XP. Gold is settled gold. Kept item stacks are listed below; they are not converted to gold because no sale was simulated.
- The no-regen rows are a counterfactual run of the idle simulator over the hunt activity’s real weighted encounters, with carried HP/inventory and actual timeout/death stopping. They are not live server measurements. Live navigation, input delays, loot grants, and live death handling were not simulated here, so this report makes no live throughput or XP/hour claim.
- The report assumes the idle activity’s expedition start gate is already satisfied. It is a combat/economy measurement of a provisioned input snapshot; starting inventory, potion acquisition, item acquisition, and unlocking hunt for a newly created character are not modeled.
- Idle default regen is 15% max HP between survived fights; no regeneration is free within a fight. The no-regen reference sets between-fight regen to zero. Deaths and timeouts are separate; timeout count is zero in this run unless shown otherwise.
- No gear is equipped. The content defines starter items but does not grant them on character creation or drop them as loot. This is the current reachable naked starter baseline, not a gear-acquisition model. Thornblade skills and the paper’s level-scaled attribute spreads are not available character configurations today. Retained item totals below include stack grants only; unique-item grants are omitted.
- This is evidence about current code/content, not a tuning recommendation. The XP curve, death loss, gear acquisition, character progression, live navigation pacing, and #56 balance decision remain open.

### Mean retained item stacks per requested expedition

| Model | Level | Potions | Retained item quantities |
|---|---:|---:|---|
| idle-default-regen | 1 | 0 | item:alloy_scrap: 0.29; item:amber_resin: 0.14; item:boar_hide: 1.12; item:creeper_fiber: 0.46; item:glowcap: 1.52; item:lens_shard: 0.06; item:minor_healing_potion: 0.23; item:raw_meat: 1.74; item:tiller_cog: 0.06 |
| idle-default-regen | 1 | 5 | item:alloy_scrap: 0.67; item:amber_resin: 0.2; item:boar_hide: 1.77; item:creeper_fiber: 0.72; item:glowcap: 2.81; item:lens_shard: 0.09; item:minor_healing_potion: 0.34; item:raw_meat: 2.68; item:tiller_cog: 0.19 |
| idle-default-regen | 3 | 0 | item:alloy_scrap: 1.27; item:amber_resin: 0.3; item:boar_hide: 3.31; item:creeper_fiber: 1.48; item:glowcap: 5.95; item:lens_shard: 0.18; item:minor_healing_potion: 0.61; item:raw_meat: 5.18; item:tiller_cog: 0.28 |
| idle-default-regen | 3 | 5 | item:alloy_scrap: 1.55; item:amber_resin: 0.38; item:boar_hide: 4.09; item:creeper_fiber: 1.83; item:glowcap: 7.74; item:lens_shard: 0.23; item:minor_healing_potion: 0.75; item:raw_meat: 6.44; item:tiller_cog: 0.33 |
| idle-default-regen | 5 | 0 | item:alloy_scrap: 3.62; item:amber_resin: 0.66; item:boar_hide: 7.6; item:creeper_fiber: 3.9; item:glowcap: 14.97; item:lens_shard: 0.45; item:minor_healing_potion: 1.2; item:raw_meat: 12.27; item:tiller_cog: 0.47 |
| idle-default-regen | 5 | 5 | item:alloy_scrap: 3.62; item:amber_resin: 0.66; item:boar_hide: 7.6; item:creeper_fiber: 3.9; item:glowcap: 14.97; item:lens_shard: 0.45; item:minor_healing_potion: 1.2; item:raw_meat: 12.27; item:tiller_cog: 0.47 |
| idle-no-regen-counterfactual | 1 | 0 | item:alloy_scrap: 0.14; item:amber_resin: 0.07; item:boar_hide: 0.57; item:creeper_fiber: 0.31; item:glowcap: 0.71; item:lens_shard: 0.02; item:minor_healing_potion: 0.16; item:raw_meat: 1.01; item:tiller_cog: 0.02 |
| idle-no-regen-counterfactual | 1 | 5 | item:alloy_scrap: 0.42; item:amber_resin: 0.12; item:boar_hide: 1.19; item:creeper_fiber: 0.46; item:glowcap: 1.52; item:lens_shard: 0.05; item:minor_healing_potion: 0.22; item:raw_meat: 1.82; item:tiller_cog: 0.09 |
| idle-no-regen-counterfactual | 3 | 0 | item:alloy_scrap: 0.59; item:amber_resin: 0.19; item:boar_hide: 1.55; item:creeper_fiber: 0.65; item:glowcap: 2.2; item:lens_shard: 0.08; item:minor_healing_potion: 0.33; item:raw_meat: 2.36; item:tiller_cog: 0.12 |
| idle-no-regen-counterfactual | 3 | 5 | item:alloy_scrap: 1; item:amber_resin: 0.27; item:boar_hide: 2.76; item:creeper_fiber: 1.17; item:glowcap: 4.83; item:lens_shard: 0.17; item:minor_healing_potion: 0.53; item:raw_meat: 4.32; item:tiller_cog: 0.27 |
| idle-no-regen-counterfactual | 5 | 0 | item:alloy_scrap: 1.87; item:amber_resin: 0.42; item:boar_hide: 4.73; item:creeper_fiber: 2.2; item:glowcap: 8.89; item:lens_shard: 0.27; item:minor_healing_potion: 0.87; item:raw_meat: 7.59; item:tiller_cog: 0.36 |
| idle-no-regen-counterfactual | 5 | 5 | item:alloy_scrap: 3.03; item:amber_resin: 0.6; item:boar_hide: 6.81; item:creeper_fiber: 3.35; item:glowcap: 13.16; item:lens_shard: 0.41; item:minor_healing_potion: 1.11; item:raw_meat: 10.98; item:tiller_cog: 0.44 |
