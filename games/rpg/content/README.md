# RPG content

Declarative JSON content for the RPG ([ADR-0008](../../../docs/adr/0008-declarative-content-pipeline.md),
[content-format](../../../docs/spec/content-format.md)), compiled and validated by `@engine/content-compiler` with the RPG
plugin [`@rpg/content-plugin`](../tools/content-plugin/README.md) (schemas from `@rpg/rpg-schema`).

```sh
pnpm content:validate   # = pnpm content-cli validate games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts
```

It runs as part of `pnpm check` (and therefore CI). Run it before committing content.

## Layout

| Directory | Collection | ID namespace |
|---|---|---|
| `world/areas/` | engine areas + RPG fields | `area:` |
| `world/locations/<area_slug>/` | engine locations + RPG fields | `loc:` |
| `world/routes/` | engine routes | `route:` |
| `enemies/` | enemies and bosses | `enemy:` |
| `skills/` | skills | `skill:` |
| `items/` | items | `item:` |
| `loot-tables/` | loot tables | `loot:` |
| `encounter-tables/` | encounter tables | `enc:` |
| `resource-nodes/` | gather nodes | `res:` |
| `idle-activities/` | idle activities | `idle:` |
| `progression/xp-curve.json` | the XP curve (exactly one, `progression:xp_curve`): authored `xpToNext` table plus `tailGrowthBp` for the open-ended tail beyond it (#129) | `progression:` |

A file holds one entity or an array of them; file names never matter, only IDs. IDs are never renamed (deprecate with
`"deprecated": true` instead).

## Technical seed

The `test_*` / `test_grove` files remain a technical seed for the pipeline. They exist so the plugin, compiler and CI
have a small independent fixture. They are **not Region 1**; numbers are placeholders, not balance.

- `area:sanctuary` — hub with one safe location (`loc:sanctuary.plaza`).
- `area:test_grove` — explorable test area (tag `technical_seed`), 4 `ordinary` locations: `entrance` (start),
  `glade` (encounters, a gather node, a hotspot; exits gated by `levelAtLeast 2` to the den and by a `secret` exit to
  the hollow), `warden_den` (boss room), `hidden_hollow` (secret). Completion: 70% of the pool + defeat
  `enemy:test_grove.warden`. Idle activity `idle:test_grove.hunt`.
- `route:sanctuary_to_test_grove` — instant portal.
- Skills `skill:test_strike` (instant) and `skill:test_slam` (telegraphed, `windupTicks: 3`); enemies
  `enemy:test_grove.slime` (normal) and `enemy:test_grove.warden` (boss, telegraphs `test_slam` in phase 2).
- Items `item:test_grove.herb` (material) and `item:test_tonic` (consumable); loot tables, encounter tables, one resource
  node, the XP curve.

The plugin tests (`games/rpg/tools/content-plugin`) continue to use the original seed as an independent fixture.

## Region 1 structural content fixture

Files named `region_1.json` and `world/locations/region_1/` add the reviewed Verdant Hollow paper design: skills,
enemies, items, loot/resources, live/idle encounter tables, activities and the 11-location graph. All balance inputs
are provisional. The five commons and native Fracture mini-boss preserve the owner decisions in the design.

This is not yet a playable or balanced region. Flag-producing hotspots are declarative since #38 (hotspot
`effects: [{ "setFlag": … }]`, applied by the live plugin); localized text and scenes/art still need implementation
(guarded-stun semantics landed with #71). See the
[authoring checkpoint](../../../docs/design/region-1-content.md) for exact data choices, unresolved contracts and
remaining #46/#24 work.
