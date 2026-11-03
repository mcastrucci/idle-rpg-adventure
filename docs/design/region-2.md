# Region 2 — Paper Design

> **Status: proposed paper design for issue #55; not owner-approved.** Creative names, layout, enemy identity, and all
> balance bands below are working proposals. Region 1's accepted decisions in
> [`region-1.md`](region-1.md) §9 and product constraints in [`concept.md`](../concept.md) govern. This document is a
> design proposal only: it does not add content, code, or art. Author content later against the current compiler and
> schemas. Region 2 must use the live balance-sim contract in §7 before numbers are treated as measured.

## 1. Design purpose

Region 2 proves the POC loop's next step: a character who personally conquered the Verdant Hollow can enter a more
demanding fragment, use R1 equipment and supplies to prepare, and encounter a solo-beatable tactical challenge with
room to grow into future cooperation. It should feel unlike an overgrown garden while keeping the setting's
Fracture-tech-as-magic premise.

**Working name: The Shard Choir.** A broken Ark signal observatory is fused with a crystalline, non-human Fracture
fragment. The locals interpret its resonant pylons as a choir calling travelers across a glass sea. The signal is a
malfunctioning navigation system; its light and tones are treated as ritual, without anyone in the POC explaining the
technology. This preserves the Ark/alien ambiguity and does not make the encounter a Guardian or reveal the Fracture's
origin.

**Provisional level and difficulty:** difficulty 2, recommended levels 4–8. The R1 boss room/reward can be reached at
lower levels, so these bands describe an intended next challenge, not an entry restriction. All values are targets for
measurement, not facts about current balance.

## 2. Compact map and progression

Seven candidate locations, fewer than R1's eleven. Working IDs stay neutral if names change.

| Candidate ID | Tags / pool | Scene purpose and route |
|---|---|---|
| `loc:region_2.fracture_landing` | `safe`, start; outside pool | A stable shelf at the portal, with a clear view of the glass sea. Connects only to `signal_shallows`. |
| `loc:region_2.signal_shallows` | `ordinary`; in pool | A shallow crystal field, first low-risk encounter, route hub. Connects landing, `prism_span`, and `echo_archive`. |
| `loc:region_2.prism_span` | `ordinary`; in pool | Narrow reflective bridge, a dangerous encounter table and an optional return loop to the hub. Connects `signal_shallows` and `resonance_court`. |
| `loc:region_2.echo_archive` | `ordinary`, `safe`; in pool | A quiet Ark shell with a rest point and noninteractive lore hotspot; connects the hub to `resonance_court`. |
| `loc:region_2.resonance_court` | `ordinary`; in pool | A fractured relay plaza, preparation threshold immediately before the special room. Connects to archive, prism span, and `choir_core`. |
| `loc:region_2.choir_core` | `boss_room`; outside pool | One special encounter: a resonant sentinel and its repeating signal pattern. No ordinary-location credit. |

The graph is deliberately compact and looped: the shortest route to the core crosses three ordinary locations, while
the player can take the archive or prism detour to discover the fourth. Proposed completion: ordinary pool tag,
threshold 7000 bp (3/4 locations), and mandatory defeat of `enemy:region_2.resonant_warden`. The safe landing is outside the pool; the safe
archive remains in it. The core is outside the pool. Freeze the actual pool size and required count at publication,
as R1 does; do not count future secrets retroactively.

**Access and unlock contract.** Proposed route ID `route:sanctuary_to_region_2` points to `area:region_2` and uses
`requires: { "areaCompleted": "area:region_1" }`; proposed area ID is `area:region_2`; activity IDs are
`idle:region_2.survey` and `idle:region_2.hunt`. The route requirement evaluates against this character's persisted
completed-area set. That is personal R1 conquest, not a party leader's access or a temporary discovery flag. R2's idle
activities are available only after this same character completes R2's discovery threshold and mandatory encounter.
The shared world requirement evaluator, server world view, and expedition-start validation must continue to enforce
these requirements on the server; map visibility is explanatory, not authority. This follows the existing
`areaCompleted` requirement and R1 completion contracts; it needs no new gate mechanic.

**Data flow.** The character's persisted completed-area state is the source for server route eligibility. The map can
render `route:sanctuary_to_region_2` locked with a “Complete the Verdant Hollow” reason until `area:region_1` is in
that state; the requirement is checked again by the server. Live discovery and Warden victory feed the same server-side,
transactional completion evaluation used by R1. Persist R2 completion once, then use that character state to unlock
`idle:region_2.*` at expedition start. Keep events and reports keyed by canonical area, activity, location, encounter,
and enemy IDs; do not emit synthetic attempts for rejected or client-only routes. Telemetry Q6 in
`docs/spec/telemetry.md` currently reports R2 attempts as unavailable. It should gain real coverage only from actual
R2 live-entry/attempt/completion rows after implementation, and still cannot infer interest or motivation.

## 3. Encounter and preparation

Reuse the existing R1 tactical vocabulary; Region 2 adds challenge through combinations, enemy statistics, and timing,
not new combat verbs. Candidate content IDs are `enemy:region_2.glass_echo` (ordinary pressure),
`enemy:region_2.prism_guard` (a telegraphed heavy hit), and `enemy:region_2.resonant_warden` (boss-rank schema,
presented in fiction as an automated signal process, not a Guardian). These are proposals only.

- The first tables favor one `glass_echo`; the prism span and court can mix it with one `prism_guard`. Keep each
  encounter group legible and survivable alone; do not make combat mandatory at every location.
- Reuse the existing `skill:basic_attack`, `skill:heavy_rake`, `skill:bramble_lash`, and
  `skill:overcharge` definitions exactly when suitable. Current schema permits enemies to reference these skills;
  balancing their coefficients/cooldowns would require new skill IDs and is not assumed here.
- The Warden's proposed special is a boss phase rotation that attempts `overcharge` and `bramble_lash` in an
  alternating pattern. The existing skills have cooldowns, so an unavailable rotation skill falls through to the
  enemy's AI priority list; this can insert fallback actions rather than guarantee a strict sequence. Do not claim a
  fixed cadence until combat simulation verifies it. A later faster phase is optional only if current phase and
  cooldown rules express it cleanly. The intended lesson is to guard the windup, then clear the DoT with `second_wind` or
  `sap_tonic`; `mend` and healing potions are recovery. A deliberately telegraphed pattern is visible in live, and
  automation can use current `enemyTelegraphing` and `selfHasHarmfulEffect` conditions. The player must have a
  reasonable manual counter window at the actual action interval.
- Proposed encounter accepts one hero and has no party check, role requirement, add coordination, or ally-only
  counter. In future co-op, the same enemy-targeted pressure, taunt, `mend` ally targeting, and shared boss encounter
  could support a tank/support/damage composition. That is potential, not a co-op acceptance criterion; don't promise
  that a self-targeted `guard` can protect another player.

**Preparation payoff.** A fresh R1 conqueror starts from the starter kit, with any random boss drop recorded
separately. R1's content currently gives a `tiller_plate_buckler` 5% weight from tillers and a `lantern_lens` 3%
weight from lanterns; its Matriarch table has a 35% `sapforged_blade` entry and a 35% `heartwood_buckler` entry. None
is a guaranteed conquest reward. `boar_hide_jerkin` exists as an item definition but has no current R1 acquisition
path, so do not equip it in an obtainable cohort unless content later adds a valid source. The player can farm the R1
ordinary encounters/idle hunt, then buy R1's `minor_healing_potion` (12g) and
`sap_tonic` (18g) from the Sanctuary merchant. `healing_potion` (40g) becomes purchasable after R1 completion. The
shards, hides, resin, scrap, or materials currently have no POC crafting recipe; do not imply that raw materials
upgrade gear. R2 should reward a tangible next gear upgrade or useful consumables from the special encounter and
repeatable R2 encounters, so the preparation loop has a payoff. Proposed fixed-stat boss drops are
`item:choirglass_blade` (weapon, power +14, critBp +300) and `item:resonance_buckler` (offhand, armor +9, maxHp +20);
one weighted roll chooses between them, with a guaranteed `item:warden_signal` quest trophy. These are working names
and provisional stat targets: no R2 item currently exists. The ordinary hunt should favor repeated encounters in the
shallows/court and use its own loot tables for a sellable `item:prism_dust` plus a modest chance of the existing
`item:sap_tonic`;
do not create a crafting recipe to give dust a use. This gives farming an immediate gold/supply payoff and the boss a
longer-term equipment payoff. The balance pass must account for which reference build can use each weapon/offhand slot and for
the weighted reward's acquisition odds.

Do not call a cohort "fresh" if it equips a low-chance equipment drop from an R1 loot roll or the R1 boss, or an
unavailable merchant offer. The current `gearByLevel` modelling loadouts equip `boar_hide_jerkin`, which has no R1
acquisition path; override them with the cohort gear above. Balance-sim is not an acquisition simulator.

## 4. World and content IDs (proposal)

Use the established `area:region_2`, `loc:region_2.*`, `enc:region_2.*`, `loot:region_2.*`, `idle:region_2.*`,
`res:region_2.*`, and `enemy:region_2.*` namespaces. Include one area, six locations, one Sanctuary route, at least
three live encounter tables (shallows, span, court), and a boss table for the core. Give the area both proposed idle
activities only after conquest. The hunt table must exclude the boss room; the survey activity may expose a lower-risk
selection but must not bypass R2 conquest. Discovery pool tags, mandatory enemy predicate and per-character completion
record are the data contract; the server applies credit once, even if the Warden can be fought again in a later live
instance.

R1 experience is the technical seed plus the authored Region 1 draft/checkpoint, not a rule that every suggested
detail is accepted content. The R1 technical seed is explicitly separate from authored content; Region 1's owner
decisions in §9 govern its theme and mechanics. In particular, don't copy the superseded caretaker origin, infer
Region 2 approval from R1's approval, or change existing IDs/gear to suit this proposal.

## 5. Schema and engine fit

Verified against current `games/rpg/packages/rpg-schema/src/{world,enemies,skills,rules,tables,items}.ts`,
`games/rpg/packages/rpg-sim/src/combat/`, `games/rpg/packages/rpg-stats/src/`, and
`games/rpg/tools/balance-sim/`:

| Need | Existing support | Limit to preserve |
|---|---|---|
| Ordinary, safe, start, boss-room locations; graph; discovery threshold and required enemy | RPG `RpgAreaSchema` / `RpgLocationSchema`, engine location tags, `completion.pool`, `thresholdBp`, game-defeated predicate, and route `requires` with `areaCompleted` | `secret` labels and exit flags are constrained by existing world/tag and compiler rules; validate final tags and graph through compiler. |
| Enemies, single-hero or party combat, enemy AI | `EnemySchema`, closed skill refs, AI rules, target selectors and combat actor model | No summon/add-spawn mechanic or custom boss script is proposed. Party is not needed to start or clear this encounter. |
| Telegraph counter and DoT removal | Skill `windupTicks`, boss phase `rotation`/`telegraphs`, `enemyTelegraphing`, `guard`, cleanse and `selfHasHarmfulEffect` | A telegraph is useful only if the hero can act before resolution; check at real action intervals and current sim. Current `guard` is self-targeted. |
| Reward tables and supplies | Loot weighted entries, independent rolls, guaranteed drops, item kinds; merchant buy price and `requiresCompletedArea` | Loot outputs item IDs; runtime equipment instances receive UUIDs with empty `rolls`. Authored random-affix rolls and crafting recipes are not supported. |
| R2 idle unlock | Area `activities` plus completion predicate; expedition start validates the character's completed areas | Only verified from existing R1 contracts. R2 must use the persisted per-character completion path; never trust a map/client unlock. |

The setting can be conveyed with scene composition, hotspots and localized text. There is no requirement for a new
renderer feature, animation budget, complex geometry, or final scene art in this paper design. Real-device scene
rendering/asset budgets remain pending; use placeholders or existing scene conventions during implementation.

Verification references: [`RouteSchema` and `RequirementSchema`](../../engine/world/src/schemas.ts),
[`areaCompleted` evaluation](../../engine/world/src/requirements.ts),
[route completion fixture](../../games/rpg/apps/server/src/world/test-content.ts),
[Region 1 area/completion authoring](../../games/rpg/content/world/areas/region_1.json),
[Region 1 skill IDs and cooldowns](../../games/rpg/content/skills/region_1.json),
[equipment instance storage](../spec/data-model.md#item_instances-equipment-unique-items),
[combat rotation fallback](../../games/rpg/packages/rpg-sim/src/combat/rules.ts), and
[telemetry coverage limits](../spec/telemetry.md). These references establish current technical affordances only;
they do not approve the proposed Region 2 names, content, or balance.

## 6. Provisional result goals

These are hypotheses for the Region 2 balance pass, not measured outputs or promises. Keep the region hard but
progressable solo: an underprepared arrival should learn the telegraph/DoT pattern and retreat safely; a prepared
R1-farmed character should have a credible route through common groups and the special fight.

| Measure | Proposed band |
|---|---|
| Fresh R1-complete solo character enters | Common groups generally beatable, with retreat/rest decisions; avoid routine one-shot deaths. |
| Farmed/prepared solo character | At least 80% win rate on each ordinary encounter group with automation, at least 90% on attentive live special encounter, at most 60% on the same encounter under automation. |
| Special fight | Telegraph counter changes received damage/control; expected duration roughly 1.5–3× an R1 common fight, not a prolonged attrition wall. |
| R2 hunt after R2 conquest | Useful progression with consumable cost and measurable death risk; not a replacement for active discovery or an automatic way past the region gate. |

Treat these as candidate bands to discuss after a current-state run. If the actual engine makes the special fight too
hard or too easy, adjust the authored encounter/content after review; don't alter formulas or invent mechanics to force
the targets.

## 7. Balance-sim measurement contract

The committed R1 report at `docs/design/balance/region-1-baseline.md` is only a historical R1 reference:
`rpg-sim@1.1.0`, content hash
`3e22df61ea5af0aa41894a6eaca49a86e019d188326be06e324ed66a8fbc2609`. It predates the current branch/content state.
Regenerate R1 and R2 against the same current `ENGINE_VERSION`, compiled content hash, and model parameters before
comparing results. A changed engine version or content hash invalidates the comparison; record both in each report.

Use two fixed level snapshots and two distinct reference builds (the existing `BULWARK` and `THORNBLADE` scenario
definitions in `games/rpg/tools/balance-sim/src/scenario.ts`). These are test inputs, not proof that an actual player
arrives at that level or inventory:

| Cohort | Level and gear rule | Purpose |
|---|---|---|
| Fresh R1 clear | L4; Bulwark attributes STR/AGI/INT/VIT/SPI 12/4/2/16/8, Thornblade 15/12/2/8/5. Both use `rusty_sword` + `padded_vest`; Bulwark also has starter `wooden_buckler`. Use their scenario common/boss skill sets and rules. Conservative lower-bound inventory: 4 `minor_healing_potion`, 2 `sap_tonic`, 0 `healing_potion` (84g at current prices, merchant gated by R1 completion). Run Matriarch reward branches separately only if testing the just-conquered snapshot: `sapforged_blade`, `heartwood_buckler`, or 2 `healing_potion`, each from its actual weighted entry. | Tests whether conquest hands the player a fair next step without farming. |
| Farmed / prepared R1 | L5; Bulwark attributes 13/4/2/18/9 with `rusty_sword`, `padded_vest`, `tiller_plate_buckler`; Thornblade 17/13/2/9/5 with `sapforged_blade`, `padded_vest`, `lantern_lens`. All items have current R1 sources. Same named reference skill sets/rules. Declare a concrete carried supply vector, e.g. 8 `minor_healing_potion`, 3 `sap_tonic`, 2 `healing_potion` (230g at current prices, purchasable after R1 completion); report zero-healing-potion sensitivity separately. Never equip both mutually exclusive offhands. | Tests whether R1 progress and preparation materially improve R2 survival. |

Reference loadouts to encode exactly: Bulwark common and boss `skill:basic_attack`, `skill:shield_bash`,
`skill:guard`, `skill:cleave`, `skill:mend`; Thornblade common `skill:basic_attack`, `skill:precise_strike`,
`skill:rend`, `skill:second_wind`, `skill:cleave`, and boss swaps `skill:cleave` for `skill:guard`. Use the
six-rule automation from that scenario file, with Thornblade's harmful-effect cleanse rule. Keep manual mode's current
attentive guard/cleanse script distinct from automation.

The existing `Scenario`/`HeroBuildDef` types can encode builds, gear, automation, encounter tables, potions, and repeat
trials, but not character acquisition history, a deterministic “fresh from conquest” inventory, location discovery,
retreat decisions, or the Region 2 entry gate. Model the two cohorts transparently as scenario inputs and label the
gear/potion assumptions; do not present them as simulated economy outcomes. The live-vs-idle hourly model does not
measure first-conquest time. Use per-encounter and boss sections for this pass unless the simulator is explicitly
extended under a separate scope.

For each build × cohort × ordinary group and boss mode, use `--runs 1000` (more if rates stay near a target boundary),
fixed seed root `24` for reproducibility, and the exact current content root. Record win rate, p10/p50/p90 ticks,
mean HP lost (the report counts a death as 100% lost), consumables per trial and per win, and death/timeout counts.
Win rate is wins divided by started trials; death rate is deaths divided by started trials, with timeouts stated
separately. The current report has no telegraph-counter-rate metric; use
the sim event trace for a small auditable sample if that counter needs reporting, or leave it unmeasured. Test both attentive
live and automation on the Warden; state the live script's guard/cleanse behavior. For supply comparisons, use declared
inventory vectors and separately report the effect of removing the healing potion, tonic, or R1 gear. Current
`balance-sim` does not model gold cost, purchase availability history, retreat, stage completion, or durable corpse/
recovery rules; don't report those as outcomes. Its cells/boss sections charge one simulated combat per sample and do
not represent live route travel or a region clear. For any future stage-cost report, state the denominator as one
instance and count the current provisional live spawn contract (up to two encounter rolls per ordinary combat
location, one in a boss room) plus supplies used; report travel/rest and the R2 run bag separately if they are not
simulated. Do not multiply a boss-attempt result into a conquest cost and call it measured.

All numeric targets in §6 remain **proposed** until a report generated from current code/content and a design/owner
review. The paper must not copy R1's older measurements as Region 2 evidence.

## 8. Decisions and follow-up boundaries

Owner review is needed for working name/theme, six-scene topology, entrance gate, Warden identity/pattern, ordinary
enemy mix, reward direction, and target bands. The entry condition, durable completion, route/map display, and idle
unlock must agree with the current server navigation/persistence implementation. Open decisions on build slots,
attributes, tick/combat formulas, regen and enemy spawn pacing remain open; this document assumes no resolution beyond
the actual current schemas/code. Do not expand engine scope for area gates, new targeting, enemy summons, equipment
affixes, crafting, scene tooling, or balance-sim cohort state under this paper-design task.
