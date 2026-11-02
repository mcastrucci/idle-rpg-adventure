# Region 1 content authoring checkpoint

Status: **structural content fixture, provisional balance**. This supplies data inputs for #24 and part of #46;
it does not complete the playable Region 1, the balance pass, or owner acceptance. Source: [paper design](region-1.md)
§2–§6, with the owner decisions in §9 taking precedence.

## Authored data

The compiler loads these alongside the existing `technical_seed` Sanctuary/Test Grove fixtures. Every new content
JSON file has `region_1` in its path. Existing technical seed entities and the global XP curve are unchanged.

| Collection | New entities | File |
|---|---:|---|
| Skills | 16 (8 hero/shared, 8 enemy-only) | `games/rpg/content/skills/region_1.json` |
| Enemies | 5 commons, 1 mini-boss | `games/rpg/content/enemies/region_1.json` |
| Items | 21 (9 materials, 1 quest item, 3 consumables, 8 equipment) | `games/rpg/content/items/region_1.json` |
| Loot tables | 6 enemy, 4 gathering | `games/rpg/content/loot-tables/region_1.json` |
| Encounter tables | 9 live, 2 idle | `games/rpg/content/encounter-tables/region_1.json` |
| Resource nodes | 4 | `games/rpg/content/resource-nodes/region_1.json` |
| Idle activities | Hunt, gather | `games/rpg/content/idle-activities/region_1.json` |
| World | 1 area, 11 locations, 1 Sanctuary route | `games/rpg/content/world/` |

The ordinary pool has eight locations and requires six discoveries at 7000 bp plus defeating
`enemy:hollow_matriarch`. The safe portal start is outside the pool. The safe antechamber remains inside it. The
secret greenhouse and boss room are outside it. No publication date or frozen baseline is invented: freeze the
baseline when publishing.

The Matriarch is tagged `mini_boss` and `native_fracture`. `rank: boss` is the existing mechanical schema category
required for phase tables and mandatory completion enemies; it does not make this creature a lore Guardian. The
three phase thresholds are 10000/6000/2500 bp, with `crushing_blow` telegraphed in every phase. Boss and secret
groups are excluded from idle tables, and the secret cache is excluded from idle resource yields. The boss remains
in its live encounter table for later-instance re-fights; once-only conquest credit belongs to #38.

Guaranteed drops remain independent of weighted rolls. Scrap gathers always grant 1–2 alloy scrap and roll a 10%
lens-shard bonus. The secret cache guarantees 1–2 healing potions and a seed capsule, with a 25% lens bonus. Hunt
encounter weights sum to 100 and yield a theoretical **21.9 XP per roll**, before combat outcomes. That arithmetic
is not measured XP/hour or a balance result.

## Runtime and authoring dependencies

| Gap | Intended mapping / decision | Follow-up |
|---|---|---|
| Guard must block the secondary stun | **Resolved by #71** (combat-engine §5 "Guard vs secondary control"): `guard`'s two armor/resist `stat_mod`s carry `guard: true` and `crushing_blow`'s stun carries `negatedByGuard: true`. `rpg-sim@1.1.0` skips the stun on a guarding target (`EffectNegated`); the Region 1 smoke test covers guarded versus unguarded blows against the compiled mini-boss. | — |
| Cleanse automation | `second_wind` and `sap_tonic` contain cleanse effects, but no hero loadout/rule collection exists. The `selfHasHarmfulEffect` condition exists since #71 (dot, stun or negative `stat_mod`); reference builds should use it for cleanse once loadouts/rules are authored. HP-only conditions in the draft are superseded. | build/loadout authoring |
| Bulkhead flag | **Resolved by #38**: `bulkhead_lever` carries `effects: [{ "setFlag": "region_1.bulkhead_open" }]`; the live plugin applies hotspot effects once per instance, server-side, without ID special cases. Flags are instance-scoped (open decision #20, provisional). | — |
| Hatch flag | **Resolved by #38**: `cracked_panel` carries `effects: [{ "setFlag": "region_1.hatch_found" }]`, revealing the secret greenhouse exits. The compiler rejects an exit flag no hotspot of its area sets (`rpg.exitFlagNeverSet`). | — |
| Text and scenes | IDs and text keys are present; localized strings, Tiled maps, tilesets, hotspot geometry and assets are absent. Optional `scene` fields are omitted until real scene files exist. | #45 scenes and text; #44 art |
| Vendor functionality | Item `value` stores sell value. The schema has no purchase price, vendor inventory, or post-conquest sale gate. Proposed buys remain 12/18/40 gold for minor potion/tonic/potion, and healing-potion sales must unlock after conquest. | Vendor/server content support |
| Live spawn and gathering limits | **Implemented provisionally by #38** in the live plugin, not in content: two encounter rolls per location (one in a boss room) and once-per-instance gathering (open decision #14). Node identity is `<resource>#<ordinal>` within the location (the grotto has `res:glowcap#0` and `#1`); scene geometry for nodes is #45. | Playtest (#14) |
| Conquest persistence | Completion objective is authored, while permanent credit and idle activity unlock enforcement require #47 integration. Later-instance boss re-fights work in live since #38 (each instance rolls the boss room again); the live plugin emits a `bossDefeated` effect that #47 records. | #47 persistence |

Narrative copy must describe a **native Fracture entity rooted into an Ark pump**, with roots strangling Sanctuary's
water supply. It must not repeat §1's superseded “Ark caretaker frame” origin. The Sanctuary water hook is narrative
only. The founder log stays a hint. No potion-brewing recipe or crafting placeholder is introduced.

## Provisional conflicts to resolve in balance-sim

The source design's simulation numbers came from a scratch model, not `rpg-sim`. The JSON copies coefficients,
enemy stat snapshots, durations and pacing as **testable inputs**, without changing engine/stat formulas to force
the draft outcomes.

| Topic | Paper assumptions / authored input | Current implementation or unresolved contract |
|---|---|---|
| Hero stats | Draft maxHp `40 + 6·VIT + 6·level + gear`, power `STR + weapon` | `rpg-stats` defaults use maxHp `50 + 10·(level−1) + 8·VIT + gear`, power `1.5·STR + (level−1) + gear` per physical school. Armor/resist, crit and healPower also differ; derive reference builds with the real package. |
| Haste/action interval | Draft five-tick base; −1 tick per 25 haste; frenzy +25 suggests four ticks | `rpg-stats` defaults use a six-tick base and a diminishing-return ceiling formula, with a two-tick floor. Keep the authored +25 haste provisional; do not promise a four-tick interval. |
| Armor | Scratch model `ARMOR_K = 200` | Engine formulas/numbers remain provisional; remeasure damage when the shared combat engine lands. |
| Consumable scaling | Coefficients 3000/5000 are intended as 30%/50% maxHp; sap HoT 300 every two ticks | Schema expresses coefficients without an explicit scaling source. Whether consumables scale on maxHp or healPower remains Q-B3. No scaling source is invented here. |
| Attack duration | Taunt = three outgoing eligible attacks by its owner; guard/bash armor = incoming hits on the buff owner in draft A7 | The duration schema has one `attacks` unit. Q-B4 and engine contract must distinguish eligibility. Current content preserves the requested units and must not be treated as evidence that counterplay works. |
| XP curve | Paper proposes `[60, 140, 240, 380, 560]` | Existing global technical curve remains `[100, 250, 450, 700, 1000]`; no unapproved progression change. |
| Item economy | Material value bands 2–3 and 4–8; equipment values and material stack caps unspecified | Chosen provisional material values: glowcap/fiber/meat 2; resin/hide 3; scrap 4; shard 6; cog 8; core 25. Material stack cap 99. Equipment and quest sale values are placeholders 0; equipment carries `provisional_price`. Final sellability and prices need economy review. |
| Regen, premium and pacing | Hunt 30/h; gather 10/h; resource rates copied from design | Regen, live/idle advantage, success rates, potion use, premium pace, conquest duration and spawn count remain unvalidated. No result targets are asserted by the authoring tests. |
| Loadout/attributes | Draft four active slots, 30 base attribute points and +4 per level | These remain open decision #13. No build or slot system is authored here. |

## Validation

`pnpm content:validate` compiles the entire content root with the actual RPG plugin, schemas, world graph and
cross-document references. `pnpm exec vitest run --project @rpg/content-plugin` includes focused Region 1 checks
for counts, native mini-boss phases/telegraphs, all three duration units, pool exclusions, flag-gated links,
independent resource bonuses, idle boss/secret exclusion and canonical hash stability under file reordering and
JSON reformatting. Mutating a boss HP value must change the hash. Existing plugin tests select only the original
explicit seed paths; the new suite loads every file, so seed isolation cannot hide invalid Region 1 content.

These checks establish structural validity and reproducible content compilation. They do not execute the combat
engine or establish #24's balance acceptance criteria.
