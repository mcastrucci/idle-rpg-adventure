# ADR-0013: Combat tick duration and idle encounter model

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** Spike 1

## Context
Concept leaves tick duration open. Idle simulation is "independent of physical exploration" (concept §6.1).

## Decision (hypothesis)
- Live tick: **500 ms** (configurable constant in the engine, part of `engineVersion`).
- Idle: expedition duration defines an encounter budget (`encountersPerHour` per region/activity); each encounter is
  simulated tick by tick with the same engine; simulated ticks are not mapped 1:1 to wall clock. Encounter outcomes are
  placed on the wall-clock timeline proportionally.
- Estimates: Monte Carlo over N seeds, cached by (build hash, region, activity, duration, contentHash, engineVersion).

## Consequences
- Premium "faster expeditions" = pacing multiplier, no engine change.
- Spike 1 success: 3h precompute p95 < 100 ms; 200-run estimate < 2 s or cacheable; identical replays across Node versions.
