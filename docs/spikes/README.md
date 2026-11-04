# Spikes

Reports: [spike 1 (sim)](spike-1-sim.md), [spike 3 (live)](spike-3-live.md). Spike 2 (mobile render) has no report yet:
real-device results are pending in [#12](https://github.com/mcastrucci/idle-rpg-adventure/issues/12).

## Decision plan for spike 2

ADR-0010 (renderer) and ADR-0011 (Capacitor) stay **Proposed**. They will be decided after real-device results in #12.
Evidence needed: numbers from the `spikes/render-mobile` kit run on real mid/low-end phones (FPS and 1 percent low, frame
p50/p95, time to first frame, transition time, texture memory, WebGL context loss/resume) for PixiJS and Phaser, plus a
Capacitor go/no-go. Desktop or headless runs are smoke tests, not evidence. No date is set; it depends on device access.

## Spike code: kept vs discarded

| Spike | Code | Outcome |
|---|---|---|
| 1 (sim) | Combat engine, idle precompute, estimates | Promoted: `engine/sim-core`, `engine/expedition-kernel`, `games/rpg/packages/rpg-sim`, `games/survival-sandbox`, `games/rpg/tools/balance-sim` |
| 2 (render) | `spikes/render-mobile` (PixiJS and Phaser scene, metrics HUD) | Kept as the device test kit, not production code |
| 3 (live) | In-house `InstanceHost`, leases, checkpoints | Promoted: `engine/live-kernel`, `engine/server-kit`, `games/rpg/apps/server` (live, adversarial tests) |
| 3 (live) | Colyseus comparison prototype (`spikes/live-colyseus`) | Discarded; recoverable at commit `10652c4` (see [ADR-0012](../adr/0012-live-instance-hosting.md)) |
