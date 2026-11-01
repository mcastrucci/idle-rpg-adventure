# ADR-0014: Tiled as the scene layout editor

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** M5 (Region 1 production)

## Context
Placing hotspots, exits, enemy anchors and resource nodes on illustrated backgrounds by hand-editing JSON is not viable.

## Decision (hypothesis)
- Author scene layout in **Tiled** (image layer for the background, object layers for hotspots/exits/anchors with custom
  properties). `content-cli` imports `.tmj` files and validates them against location JSON.
- Gameplay data (enemies, loot, conditions) stays in location JSON; Tiled only owns geometry.

## Consequences
- No custom editor in the POC. If Tiled proves awkward, a minimal internal editor reusing `SceneRenderer` is the fallback.
