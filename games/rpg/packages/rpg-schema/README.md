# @rpg/rpg-schema

Zod v4 schemas and inferred TypeScript types for RPG content
([content-format](../../../../docs/spec/content-format.md), [data-model §1](../../../../docs/spec/data-model.md),
[combat-engine §3–§7](../../../../docs/spec/combat-engine.md)). Pure data validation: no I/O, no RNG. Every number is an
integer; percentages and coefficients are basis points (`10000` = 100%).

## Modules

| Module | Exports |
|---|---|
| `ids.ts` | `enemy:` `skill:` `item:` `loot:` `enc:` `res:` `idle:` ID schemas/types (+ re-exported `area:`/`loc:` from `@engine/world`), `TextKeySchema`, `LocalIdSchema`. |
| `stats.ts` | Closed stat set (`STR AGI INT VIT SPI maxHp power armor resist critBp haste healPower`), `StatMapSchema`, `EnemyStatsSchema`, `BP`, `BpSchema`. |
| `effects.ts` | `EffectSchema`: closed union on `type` — `damage`, `heal`, `shield`, `dot`, `hot`, `stat_mod`, `taunt`, `stun`, `cleanse`; `DurationSchema` `{ value, unit: ticks \| actions \| attacks }`; optional `to: target \| self`; guard vs secondary control (combat-engine §5): `guard: true` on `shield`/positive `stat_mod`, `negatedByGuard: true` on a target `stun` (`isNegatedByGuard`). |
| `rules.ts` | `AutomationRulesSchema` (≤ `MAX_AUTOMATION_RULES` = 6, provisional), closed conditions/actions (incl. `selfHasHarmfulEffect`, also allowed in enemy AI), `SkillTargetingSchema`, `TargetSelectorSchema`, enemy `AiRulesSchema`. |
| `skills.ts` | `SkillSchema` (cooldown/windup ticks, targeting, optional cost, effects); `negatedByGuard` only in attack skills. |
| `items.ts` | `ItemSchema`: `equipment` (slot, stats) / `consumable` (`use` effects) / `material` / `quest`, with stacking rules. |
| `enemies.ts` | `EnemySchema`: `rank: normal \| boss`; bosses add `phases[]` (`fromHpBp`, `rotation`, `telegraphs`). |
| `tables.ts` | `LootTableSchema` (weighted entries, `nothingWeight`, guaranteed drops, gold range), `EncounterTableSchema`. |
| `gathering.ts` | `ResourceNodeSchema`, `IdleActivitySchema` (`encountersPerHour`, encounter table, resource yields). |
| `world.ts` | `RpgAreaSchema`, `RpgLocationSchema` and the bare field maps `rpgAreaFields`, `rpgLocationFields`. |
| `progression.ts` | `XpCurveSchema` (`xpToNext` table strictly increasing + `tailGrowthBp` for the open-ended tail, #129), `CappedXpCurveSchema` (table only, the pre-#129 shape kept for old snapshots), `maxLevel` (`null` for an open curve). |
| `predicates.ts` | `createRpgPredicateRegistry()` with `defeated { enemy }` and `levelAtLeast { level }` over `RpgGameContext { defeatedEnemies, level }`. |
| `collections.ts` | `rpgCollections` (`{ name: { schema, idPrefix } }`), `rpgSingletons`, `rpgEntityExtensions`, `rpgJsonSchemas()`. |

## Area/location composition

The RPG **extends engine entities with flat top-level fields** (as in content-format §3), not an `rpg: {}` sub-object.
`RpgAreaSchema`/`RpgLocationSchema` are strict objects made of the engine shape plus the RPG fields, so typos fail in RPG
content, while `@engine/world` still parses the same JSON with its loose schemas and ignores the RPG fields. The content
compiler can also merge `rpgAreaFields`/`rpgLocationFields` itself.

Mapping from the pre-engine format: `region:` → `area:`; location `kind`/`conquestPool` → engine `tags` and
`completion.pool`; `mandatoryBosses` → `completion.required` with `{ "game": "defeated", "enemy": … }`;
`idle.activities` → engine `activities` (restricted to `idle:` IDs).

## Scope limits

Schemas check single documents (including intra-document references such as AI rules only using the enemy's own
skills). Cross-document references (does `skill:x` exist, do telegraphs have `windupTicks > 0`) are the content
compiler's job. Provisional values: rule slots (6), equipment slots, hotspot types, damage schools, and skill `cost`
(placeholder `energy`, pending open decision #13).
