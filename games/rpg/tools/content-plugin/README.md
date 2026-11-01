# @rpg/content-plugin

The RPG `ContentGamePlugin` for [`@engine/content-compiler`](../../../../engine/content-compiler/README.md): it connects
the schemas of [`@rpg/rpg-schema`](../../packages/rpg-schema/README.md) to the compiler. It lives in `tools/` so runtime
apps never bundle compiler dependencies.

```sh
pnpm content:validate
pnpm content-cli validate games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts
pnpm content-cli graph games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts --area area:test_grove
```

Exports: `default` / `rpgContentPlugin`, plus the building blocks (`RPG_CONTENT_COLLECTIONS`, `RPG_COLLECTION_DIRS`,
`XpCurveDocumentSchema`, `RpgAreaExtensionSchema`, `RpgLocationExtensionSchema`, `rpgReferences`, `validateRpgContent`,
`RPG_ISSUE_CODES`).

## Collections

`rpgCollections` mapped to the directories of [content-format §1](../../../../docs/spec/content-format.md): `enemies`,
`skills`, `items`, `loot-tables`, `encounter-tables`, `resource-nodes`, `idle-activities`; plus `progression` for the XP
curve (`progression/xp-curve.json`, ID `progression:xp_curve`, contents validated by `XpCurveSchema`). The compiler has
no singleton documents, so the curve carries an ID.

## World extensions

Areas and locations get the flat RPG fields (`rpgAreaFields`, `rpgLocationFields`, with their defaults), and then the
strict `RpgAreaSchema` / `RpgLocationSchema`: unknown fields (typos) and RPG refinements (explorable areas need
`difficulty` and `recommendedLevel`, unique hotspot IDs) fail, while engine field errors are left to the engine schema
so they are reported once. Predicates: `createRpgPredicateRegistry()` (`defeated`, `levelAtLeast`).

## References (`ref.unknown`)

| From | Field | To |
|---|---|---|
| loot tables | `entries.*.item`, `guaranteed.*.item` | items |
| encounter tables | `entries.*.enemies.*.enemy` | enemies |
| enemies | `skills.*`, `ai.*.when.skillReady` | skills |
| enemies | `lootTable` | loot tables |
| idle activities | `encounterTable` / `resourceYields.*.node` / `resourceYields.*.lootTable` | encounter tables / resource nodes / loot tables |
| areas | `activities.*` | idle activities |
| locations | `encounters` / `resources.*.node` / `resources.*.lootTable` | encounter tables / resource nodes / loot tables |
| requirements (area `completion.required`, `revealedBy`, exit `requires`, route `requires`) | `{ "game": "defeated", "enemy" }` / `{ "hasItem": { "item" } }` | enemies / items |

AI `do.useSkill`, boss rotations and telegraphs are checked by the enemy schema to be in the enemy's `skills`, which are
resolved above. Automation rules (`useConsumable`, `hasConsumable`) are player data, not content, so no content
collection carries them yet.

## Cross-document checks (`validate` hook)

| Code | Rule |
|---|---|
| `rpg.telegraphWithoutWindup` | Skills in a boss phase's `telegraphs` have `windupTicks > 0`. |
| `rpg.completionEnemyNotBoss` | Enemies required by `defeated` in an area's `completion.required` are `rank: "boss"`. |
| `rpg.activitiesOnNonExplorable` | `activities` only on `explorable` areas. |
| `rpg.xpCurveMissing` / `rpg.xpCurveUnexpected` | Exactly one progression document, `progression:xp_curve`. |
| `rpg.aiSkillNotKnown` | An AI rule's `skillReady` condition names one of the enemy's own skills. |

Tests (`src/index.test.ts`) compile the seed content of [`games/rpg/content`](../../content/README.md) and give every
reference and check a failing fixture (in-memory edits of the seed).
