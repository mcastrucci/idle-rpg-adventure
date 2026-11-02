# ADR-0013: Combat tick duration and idle encounter model

- **Status:** Accepted (spike 1, 2026-11-02; see the [spike report](../spikes/spike-1-sim.md))
- **Date:** 2026-11-01
- **Validation:** Spike 1 ([#11](https://github.com/mcastrucci/idle-rpg-adventure/issues/11))

## Context
Concept leaves tick duration open. Idle simulation is "independent of physical exploration" (concept §6.1).

## Decision
- Live tick: **500 ms** (configurable constant in the engine, part of `engineVersion`).
- Idle: expedition duration defines an encounter budget (`encountersPerHour` per region/activity); each encounter is
  simulated tick by tick with the same engine; simulated ticks are not mapped 1:1 to wall clock. Encounter outcomes are
  placed on the wall-clock timeline proportionally.
- Estimates: Monte Carlo over N seeds, cached by (build hash, region, activity, duration, contentHash, engineVersion).

## Consequences
- Premium "faster expeditions" = pacing multiplier, no engine change.
- Spike 1 success: 3h precompute p95 < 100 ms; 200-run estimate < 2 s or cacheable; identical replays across Node versions.

## Findings (spike 1)

Environment for the numbers: dev container, 4 vCPU Intel Xeon @ 2.10 GHz, Node 22.23.4, `rpg-sim@1.1.0`, kernel 0.3.0,
level-4 reference builds. Details and sources in the [spike report](../spikes/spike-1-sim.md).

- **Tick duration.** The engine counts abstract ticks; idle runs them as fast as possible, so the 500 ms value only
  matters for live pacing (spec: [combat-engine §2](../spec/combat-engine.md)). The public `step` copies the state
  each tick (about 50-85 us), negligible at 500 ms. Whether 500 ms *feels* right is not something spike 1 can show; it
  stays a provisional constant until live playtests (M4), tracked as open decision #1. Changing it bumps `engineVersion`.
- **Encounter / segment model, as implemented.** The kernel's timeline segment is an encounter
  (`engine/expedition-kernel`, `games/rpg/packages/rpg-sim/src/expedition`). Budget =
  `round(durationMin / 60 x encountersPerHour x pace)`: Region 1 hunt 30/h (90 encounters for 3 h), gather 10/h. Each
  segment draws its own RNG streams (`deriveSeed(seed, 'segment', i)`: `encounters` picks the group, `loot` rolls
  drops), runs the combat engine to the end with the automation policy, applies between-fight regen (default 15 %,
  provisional, open decision #16) and emits ledger deltas as data. Segments are placed on the wall clock by weight and
  revealed progressively; a death or retreat ends the timeline. Because every segment has its own seeded streams, a
  timeline can be resumed from any segment (used for party revisions and tested).
- **Precompute vs budget: met.** 180 min, 90 segments: p95 = 47.0 ms (Bulwark) and 24.0 ms (Thornblade), 60 runs each
  (earlier run: 25-37 ms), against the 100 ms budget.
- **Estimate latency vs target: missed, mitigated.** 200 runs take 3.9-5.2 s here (3.7-4.8 s earlier), above 2 s, since
  each run is a full 3 h precompute. Chosen mitigation: cache by `(buildHash, areaId, activityId, durationMin,
  consumables, rulesHash, contentHash, engineVersion)` ([idle-simulation §8](../spec/idle-simulation.md)), with a lower N
  or a worker thread for cold misses and the per-encounter composed estimate as the fallback. Implementation is
  [#53](https://github.com/mcastrucci/idle-rpg-adventure/issues/53) (M6), whose acceptance criterion points back to
  this budget. The estimate cost is not on the expedition-start path.
- **Determinism evidence.** Golden replays (combat and idle timelines, append-only per engine version) run in `pnpm check`
  on Node 22 and 24 in CI (`.github/workflows/ci.yml`, run 65 green on both); the kernel contract checker re-runs every
  simulator input twice, including a deep-cloned copy, and checks resumption from every `stateAfter`.
- **Not measured.** Hash equality over 1,000 repeated runs and heap/GC behaviour of internal mutation versus immutable
  copies have no existing test or benchmark and are recorded as gaps in the report; the per-tick time of both styles is
  known. Neither blocks acceptance: the precompute budget has a 2x margin and determinism is covered by the above.

### Why Accepted
The model (encounter budget, per-segment seeded streams, same engine for live and idle) is implemented twice over the
kernel interface and meets its precompute budget, replays are identical across Node 22/24, and the one missed target has
a documented, tracked mitigation. The 500 ms tick and the pacing/regen numbers remain provisional values inside this
model (open decisions #1 and #16), to be settled by playtest and balance, not by this ADR.

## Related
[ADR-0004](0004-deterministic-step-engine.md), [ADR-0005](0005-idle-precompute-at-start.md),
[ADR-0019](0019-game-agnostic-expedition-kernel.md) (amendments v0.2 and v0.3 are the interface findings of this spike).
