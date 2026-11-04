# Region 2 current preparation measurement

> Bounded present-code measurement. Results are evidence for this configured simulation comparison, not a final balance decision.

| ENGINE_VERSION | contentHash | seed root | N | command |
|---|---|---:|---:|---|
| rpg-sim@1.1.0 | `98e7c8332498bd43e5d30c186cf3bc06896cb9370f4c63b996633412a77383cd` | 24 | 1000 | `pnpm balance-sim --scenario region-2-preparation --runs 1000 --seed 24 --format md` |

## Setup boundary

All cohorts are the playable Bulwark starter at level 4: attributes STR/AGI/INT/VIT/SPI 9/4/2/10/5 and the currently unlocked Basic Attack, Shield Bash, Guard, Cleave, and Mend skills. The compiled authored XP curve puts the start of L4 at 800 cumulative XP; current level-ups grant no attributes. Gear-derived combat stats come from compiled equipment passed through @rpg/rpg-stats.
The four cohorts cross starter versus R1-farmed gear with fresh versus farmed supplies at the same level, using paired seed indices. All four use the same legal six-rule R2 common policy and six-rule boss policy. This is a configurable R2 comparison policy, not the server’s five-rule default automation. Common encounters have no harmful effects, so the carried sap tonic is not expected to be used there; it remains in the common inventory to keep the supply cohorts identical.

| cohort | gear | inventory | gear slots and authored stats | derived HP / power / armor / crit | supply cost assumption |
|---|---|---|---|---|---:|
| Fresh R1 departure | item:rusty_sword, item:padded_vest, item:wooden_buckler | item:minor_healing_potion ×4, item:sap_tonic ×2, item:healing_potion ×0 | item:rusty_sword (weapon: power 5, critBp 150); item:padded_vest (chest: armor 3, maxHp 10); item:wooden_buckler (offhand: armor 3) | 170 / 21 / 11 / 730 bp | 84g |
| Farmed gear only | item:sapforged_blade, item:padded_vest, item:heartwood_buckler, item:lantern_lens | item:minor_healing_potion ×4, item:sap_tonic ×2, item:healing_potion ×0 | item:sapforged_blade (weapon: power 10, critBp 200); item:padded_vest (chest: armor 3, maxHp 10); item:heartwood_buckler (offhand: armor 7, maxHp 15); item:lantern_lens (accessory: critBp 300) | 185 / 26 / 15 / 1080 bp | 84g |
| Farmed supplies only | item:rusty_sword, item:padded_vest, item:wooden_buckler | item:minor_healing_potion ×8, item:sap_tonic ×3, item:healing_potion ×2 | item:rusty_sword (weapon: power 5, critBp 150); item:padded_vest (chest: armor 3, maxHp 10); item:wooden_buckler (offhand: armor 3) | 170 / 21 / 11 / 730 bp | 230g |
| Farmed gear + supplies | item:sapforged_blade, item:padded_vest, item:heartwood_buckler, item:lantern_lens | item:minor_healing_potion ×8, item:sap_tonic ×3, item:healing_potion ×2 | item:sapforged_blade (weapon: power 10, critBp 200); item:padded_vest (chest: armor 3, maxHp 10); item:heartwood_buckler (offhand: armor 7, maxHp 15); item:lantern_lens (accessory: critBp 300) | 185 / 26 / 15 / 1080 bp | 230g |

## Exact policy inputs

### Shared across all cohorts
- Common skills: skill:basic_attack, skill:shield_bash, skill:guard, skill:cleave, skill:mend.
- Common rules: `[{"when":{"enemyTelegraphing":true,"skillReady":"skill:guard"},"do":{"useSkill":"skill:guard"}},{"when":{"selfHpBelowBp":5500,"hasConsumable":"item:healing_potion"},"do":{"useConsumable":"item:healing_potion"}},{"when":{"selfHpBelowBp":4000,"hasConsumable":"item:minor_healing_potion"},"do":{"useConsumable":"item:minor_healing_potion"}},{"when":{"skillReady":"skill:cleave","enemiesAtLeast":2},"do":{"useSkill":"skill:cleave"}},{"when":{"selfHpBelowBp":5500,"skillReady":"skill:mend"},"do":{"useSkill":"skill:mend","target":"self"}},{"when":{},"do":{"useSkill":"skill:basic_attack","target":"lowestHpEnemy"}}]`.
- Boss skills: skill:basic_attack, skill:shield_bash, skill:guard, skill:cleave, skill:mend.
- Boss rules: `[{"when":{"enemyTelegraphing":true,"skillReady":"skill:guard"},"do":{"useSkill":"skill:guard"}},{"when":{"selfHasHarmfulEffect":true,"hasConsumable":"item:sap_tonic"},"do":{"useConsumable":"item:sap_tonic"}},{"when":{"selfHpBelowBp":5500,"hasConsumable":"item:healing_potion"},"do":{"useConsumable":"item:healing_potion"}},{"when":{"selfHpBelowBp":4000,"hasConsumable":"item:minor_healing_potion"},"do":{"useConsumable":"item:minor_healing_potion"}},{"when":{"selfHpBelowBp":5500,"skillReady":"skill:mend"},"do":{"useSkill":"skill:mend","target":"self"}},{"when":{},"do":{"useSkill":"skill:basic_attack","target":"lowestHpEnemy"}}]`.

## Warden result

| cohort | runs | wins | deaths | timeouts | win rate | TTK p10 / p50 / p90 | mean HP lost | consumables used per trial |
|---|---:|---:|---:|---:|---:|---|---:|---|
| fresh | 1000 | 0 | 1000 | 0 | 0.00% | – / – / – | 100.00% | item:minor_healing_potion: 4.00<br>item:sap_tonic: 2.00<br>item:healing_potion: 0.00 |
| gear-only | 1000 | 0 | 1000 | 0 | 0.00% | – / – / – | 100.00% | item:minor_healing_potion: 4.00<br>item:sap_tonic: 2.00<br>item:healing_potion: 0.00 |
| supplies-only | 1000 | 0 | 1000 | 0 | 0.00% | – / – / – | 100.00% | item:minor_healing_potion: 8.00<br>item:sap_tonic: 3.00<br>item:healing_potion: 2.00 |
| prepared | 1000 | 1000 | 0 | 0 | 100.00% | 283 / 319 / 343 | 50.66% | item:minor_healing_potion: 7.13<br>item:sap_tonic: 3.00<br>item:healing_potion: 2.00 |

**The sampled simulation meets the fresh-struggles / prepared-succeeds contrast for this configured Bulwark comparison.** Fresh won 0/1000; gear-only won 0/1000; supplies-only won 0/1000; combined preparation won 1000/1000. In this sample, both gear and supplies were needed for success. This is simulation evidence under the stated policy, not final balance or proof of a reachable R1 farming path.
Fresh-to-prepared Warden change: win rate 100.00 pp; mean HP lost -49.34 pp; median fight duration no winning fresh trials → 319 ticks. Prepared used per trial: item:minor_healing_potion 7.13, item:sap_tonic 3.00, item:healing_potion 2.00.

## Ordinary R2 encounter groups

| cohort | encounter group | runs | wins | deaths | timeouts | win rate | TTK p10 / p50 / p90 | mean HP lost | consumables used per trial |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| fresh | region_2.glass_echo | 1000 | 1000 | 0 | 0 | 100.00% | 19 / 19 / 19 | 17.56% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| fresh | region_2.glass_echo ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 43 / 55 / 55 | 44.96% | item:minor_healing_potion: 0.61<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| fresh | region_2.glass_echo + region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 115 / 121 / 121 | 43.26% | item:minor_healing_potion: 3.28<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| fresh | region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 49 / 55 / 55 | 30.80% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| fresh | region_2.prism_guard ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 139 / 139 / 139 | 71.57% | item:minor_healing_potion: 4.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| gear-only | region_2.glass_echo | 1000 | 1000 | 0 | 0 | 100.00% | 13 / 19 / 19 | 14.72% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| gear-only | region_2.glass_echo ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 31 / 31 / 31 | 43.22% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| gear-only | region_2.glass_echo + region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 79 / 97 / 97 | 46.10% | item:minor_healing_potion: 0.85<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| gear-only | region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 37 / 37 / 37 | 24.41% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| gear-only | region_2.prism_guard ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 115 / 121 / 121 | 48.05% | item:minor_healing_potion: 3.20<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| supplies-only | region_2.glass_echo | 1000 | 1000 | 0 | 0 | 100.00% | 19 / 19 / 19 | 17.56% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| supplies-only | region_2.glass_echo ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 43 / 49 / 55 | 34.90% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 1.00 |
| supplies-only | region_2.glass_echo + region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 91 / 109 / 109 | 40.00% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 2.00 |
| supplies-only | region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 49 / 55 / 55 | 30.80% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| supplies-only | region_2.prism_guard ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 121 / 133 / 139 | 43.14% | item:minor_healing_potion: 0.48<br>item:sap_tonic: 0.00<br>item:healing_potion: 2.00 |
| prepared | region_2.glass_echo | 1000 | 1000 | 0 | 0 | 100.00% | 13 / 19 / 19 | 14.72% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| prepared | region_2.glass_echo ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 31 / 31 / 31 | 43.22% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| prepared | region_2.glass_echo + region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 61 / 79 / 79 | 12.80% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 1.79 |
| prepared | region_2.prism_guard | 1000 | 1000 | 0 | 0 | 100.00% | 37 / 37 / 37 | 24.41% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 0.00 |
| prepared | region_2.prism_guard ×2 | 1000 | 1000 | 0 | 0 | 100.00% | 91 / 97 / 109 | 35.35% | item:minor_healing_potion: 0.00<br>item:sap_tonic: 0.00<br>item:healing_potion: 2.00 |

## Limits and next hypotheses

- Direct encounters start at full HP; there is no R1 farm route, drop/purchase history, affordability, travel, retreat, rest, live settlement, or idle expedition settlement. The supply prices are arithmetic assumptions only. The report measures combat samples, not a sustainable acquisition path or hourly progression.
- The configured policy uses automation only; it is not a human performance estimate. Ordinary encounters use the same common policy and Warden runs use the same boss policy across all cohorts. All gear and supplies are explicit snapshots. Content is unchanged by this work.
- Human validation should play the same L4 starter and prepared Bulwark setups against the Warden, record completion/death, duration, HP remaining, and item use, and confirm that the assumed drops/supplies are actually reachable by the stated R1 departure point. This report does not substitute for that playtest.
- The historical `region-2-measurements.md` report and default `region-2` scenario are preserved unchanged.
