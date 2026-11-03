# ADR-0014: Tiled as the scene layout editor

- **Status:** Proposed (compiler importer implemented; authoring/device validation remains open)
- **Date:** 2026-11-01
- **Validation:** compiler fixture covers local map import, geometry parity, safety checks and deterministic bundle hashing.
  This does not validate Tiled's GUI authoring workflow or renderer behavior on a device; see spike #12.

## Context
Placing hotspots, exits, enemy anchors and resource nodes on illustrated backgrounds by hand-editing JSON is not viable.

## Decision (provisional)
- Author scene layout in **Tiled** using one finite orthogonal map, one image background layer and named object layers.
  `content-cli` imports the supported `.tmj` subset and validates it against location JSON. The geometry contract and
  supported Tiled fields are documented in [`authoring-scenes.md`](../content/authoring-scenes.md).
- Gameplay IDs and data (enemies, loot, conditions, exits, hotspots, resource placements and enemy anchors) stay in JSON;
  Tiled owns only their pixel-space geometry.
- Scene-less bundles remain format 1. Bundles with normalized geometry use format 2 and are content-hashed with it.
- If Tiled proves awkward in actual authoring, a minimal internal editor reusing `SceneRenderer` remains the fallback.

## Consequences and remaining evidence
- No custom editor is included. Tiled maps are local, inert JSON inputs; custom properties, external tilesets, URL backgrounds,
  transforms and unsupported layer/object types fail validation.
- The importer has no art-budget defaults. #12 must establish and validate explicit budgets before any production art or
  renderer decision. The importer implementation is not evidence that visual assets fit those budgets.
