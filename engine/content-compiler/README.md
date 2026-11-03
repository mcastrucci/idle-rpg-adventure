# @engine/content-compiler

Game-agnostic content compiler ([ADR-0008](../../docs/adr/0008-declarative-content-pipeline.md),
[`docs/spec/content-format.md`](../../docs/spec/content-format.md)). It loads the JSON files of a content root, validates
them with the engine world schemas (`@engine/world`) plus the schemas a game registers, and writes one bundle with a
`contentHash`. It is a build tool, not a simulator: file I/O and `node:crypto` are allowed here (ADR-0004 rules do not
apply).

## Content layout

```
<content root>/
  world/areas/**/*.json        # @engine/world Area     (id area:…)
  world/locations/**/*.json    # @engine/world Location (id loc:…), flat: areas list their location IDs
  world/routes/**/*.json       # @engine/world Route    (id route:…)
  scenes/**/*.tmj              # referenced Tiled JSON scenes
  <game collection dir>/**/*.json
```

- Each `.json` file holds **one entity or an array of entities**. Subdirectories are free-form (e.g.
  `world/locations/<area_slug>/<location_slug>.json`); file names never matter, only IDs do.
- Other files (README, art) are ignored; a `.json` file outside every collection directory is an error
  (`file.unknownCollection`), so typos in directory names do not silently drop content. `.tmj` files under `scenes/`
  are imported only when referenced by a location's `scene` field; orphan maps are errors.
- The assembled world is exactly `@engine/world`'s `World`: `{ areas, locations, routes }`, each sorted by ID.

## Game plugin

```ts
import { defineContentPlugin, referencesAt } from '@engine/content-compiler';

export default defineContentPlugin<GameState>({
  id: 'rpg',
  collections: { enemies: { dir: 'enemies', schema: EnemySchema, idPrefix: 'enemy' } },
  predicates,                                           // PredicateRegistry used to validate requirements
  extend: { locations: RpgLocationFieldsSchema },        // optional: game fields on areas / locations / routes
  references: (content) => [                            // optional: references to resolve
    ...referencesAt(content, 'locations', 'encounters.*', 'enemies'),
  ],
  validate: (content) => [],                             // optional: game checks → PluginIssue[]
  validateScenes: (content, scenes) => [],               // optional: gameplay JSON ↔ geometry parity
});
```

- Collection names `areas`, `locations`, `routes` are reserved; directories must not overlap and ID prefixes must be
  unique (`plugin.invalid` otherwise).
- `referencesAt(content, collection, pattern, to)` walks a dot path where `*` matches every array element / object
  value; missing fields are skipped. `to` may be one collection or several (any of them).
- `extend` schemas are checked in addition to the engine schema (engine fields win when both parse a field).
- `validateScenes` receives a `SceneGeometry` record keyed by location ID after local map import and can compare game-owned
  geometry names with game-owned JSON placement IDs.

## Pipeline

1. **Parse** — files are read in sorted path order, assigned to a collection by directory, parsed as JSON, validated
   with the collection schema (+ extension) and the ID namespace. Errors carry the file and the JSON path inside it.
2. **Cross-checks** — duplicate IDs across all collections; `validateWorld` (graph, requirements, completion
   feasibility; its world paths are mapped back to files); references declared by the game; frozen baselines against
   `--previous`.
3. **Game checks** — the plugin's `validate` hook.
4. **Bundle** — scene-less content stays format 1 with `{ format, game, world, collections, contentHash }` and the
   existing SHA-256 contract. When geometry exists, format 2 adds `scenes: { [locationId]: SceneGeometry }` and hashes
   `{ format, game, world, collections, scenes }`. Geometry uses map pixel coordinates and canonical root-relative
   background paths; keys and entities are sorted, so hashes do not depend on filesystem order.

Each stage runs only if the previous one found no error (avoids cascades).

## Frozen completion baselines

`build --previous <bundle.json>` compares the new world with a previously published bundle. For every area whose
completion rule has `frozen` in the previous bundle:

- the area must still exist (`baseline.areaRemoved`) and keep `frozen` with the same `poolSize`, `requiredCount` and
  `at` (`baseline.frozenChanged`);
- every location of the previous pool (area locations carrying the previous pool tag) must still belong to the area
  (`baseline.poolLocationRemoved`) and still carry the pool tag (`baseline.poolLocationUntagged`).

Adding locations, tagged or not, is always allowed. Areas without `frozen` in the previous bundle are not checked
(freezing happens at first publish).

## CLI

```
content-cli validate <root> --game <module>
content-cli build <root> --game <module> --out <file> [--previous <bundle.json>]
content-cli graph <root> --game <module> [--area <id>]      # Mermaid to stdout (world map or one area)
content-cli schema --game <module> [--out <dir>]             # JSON Schema per collection
```

`<module>` is a path (relative to the current directory) or package specifier of an ES module whose default export (or
`plugin` export) is a `ContentGamePlugin`. Exit codes: `0` ok, `1` content errors (printed grouped by file as
`code  $.json.path  message`), `2` usage or plugin-loading errors. `graph` still prints the diagram when the world
parses but has errors (exit `1`).

Running it (Node ≥ 22.18 executes the TypeScript sources directly, no build step):

```sh
pnpm content-cli validate <root> --game <plugin module>          # from the repo root, paths relative to it
pnpm --filter @engine/content-compiler content-cli validate fixtures/sample-content --game fixtures/sample-game.ts
```

Packages depending on `@engine/content-compiler` also get the `content-cli` bin. JSON Schemas describe one entity per
file (array files are not covered by the schema).

`fixtures/` holds a generic sample game (`sample-game.ts`) and content set used by the CLI smoke test.

## Error codes

`file.unknownCollection`, `json.invalid`, `schema.invalid`, `id.missing`, `id.wrongNamespace`, `id.duplicate`, the
`@engine/world` validation codes, `ref.unknown`, `ref.invalid`, `baseline.*` (above), `previous.invalid`,
`plugin.invalid`, `scene.*`, plus any code returned by the game's validation hooks.

**Not yet covered:** art budgets (spike #12), a `freeze` command computing the baseline at first publish, explicit
migration notes allowing a baseline change.
