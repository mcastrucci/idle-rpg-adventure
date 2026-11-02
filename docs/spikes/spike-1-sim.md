# Spike 1 report: step-based combat engine, idle precompute and estimates

- **Issue:** [#11](https://github.com/mcastrucci/idle-rpg-adventure/issues/11) (epic M0, [#1](https://github.com/mcastrucci/idle-rpg-adventure/issues/1))
- **Validates:** [ADR-0004](../adr/0004-deterministic-step-engine.md), [ADR-0005](../adr/0005-idle-precompute-at-start.md),
  [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md), the [ADR-0019](../adr/0019-game-agnostic-expedition-kernel.md)
  simulator interface.
- **Outcome:** ADR-0013 Accepted. Two measurement gaps remain (1,000-run hash equality and memory/GC), listed below; one
  target is missed with a documented mitigation (200-run estimate latency; the cache is tracked by
  [#53](https://github.com/mcastrucci/idle-rpg-adventure/issues/53)).

## What was built

| Spike scope | Where it lives |
|---|---|
| PCG32 RNG with named streams, integer/bp math, hashing | `engine/sim-core` |
| `step(state, inputs, rng)` combat engine, `rpg-sim@1.1.0` (initiative order, effects incl. taunt, telegraphed windups, boss phases, automation rules) | `games/rpg/packages/rpg-sim/src/combat` ([README](../../games/rpg/packages/rpg-sim/README.md)) |
| Same code in three modes: live loop with manual inputs (`step` + `CombatInput`), idle precompute (`rpg.hunt` / `rpg.gather`, `runToEnd` with a policy), Monte Carlo (`estimate`) | `rpg-sim/src/expedition`, `engine/expedition-kernel` |
| `ExpeditionSimulator` interface, contract checker, `timelineHash`, `KERNEL_VERSION` 0.3.0 | `engine/expedition-kernel`, [spec](../engine/expedition-kernel.md) |
| Second implementation of the interface (survival scavenging toy, built only on `@engine/*`) | `games/survival-sandbox` |
| Balance Monte Carlo CLI | `games/rpg/tools/balance-sim`, [Region 1 baseline](../design/balance/region-1-baseline.md) |
| Golden replays plus append-only check, CI on Node 22 and 24 | `rpg-sim/src/combat/golden.json`, `rpg-sim/src/expedition/golden.json`, `tools/golden/check-append-only.ts`, `.github/workflows/ci.yml` |

The shipped engine goes beyond the spike scope (Region 1 content, party-ready `participants[]`). The spike content set
(two builds, enemies, a boss with a taunt and a telegraphed heavy strike) is covered by the combat golden fixtures
(`boss-*` cases) and the Region 1 reference builds Bulwark and Thornblade.

## Success criteria

| # | Criterion | Result | Number | Source |
|---|---|---|---|---|
| 1 | 3h precompute p95 < 100 ms | ✅ | 180 min Region 1 hunt = 90 segments. Re-run for this report: p50 / p95 / max = 23.9 / 47.0 / 55.1 ms (Bulwark L4), 16.0 / 24.0 / 35.1 ms (Thornblade L4), 60 runs each. Earlier run (#76): p95 25-37 ms. | `rpg-sim/src/expedition/bench.test.ts` (opt-in `RPG_IDLE_BENCH=1`); [rpg-sim README, Measurements](../../games/rpg/packages/rpg-sim/README.md) |
| 2 | 200-run estimate < 2 s, or cache strategy documented | ⚠️ | Target **missed**: 200 runs take 5.2 s (Bulwark) and 3.9 s (Thornblade) here; 3.7-4.8 s in #76. Mitigation documented (cache key, per-encounter fallback); implementation is [#53](https://github.com/mcastrucci/idle-rpg-adventure/issues/53) (M6). | same bench; [idle-simulation §8](../spec/idle-simulation.md), [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md) |
| 3 | Identical replays across Node versions | ✅ | Golden replays (combat and idle timelines) run in `pnpm check` on Node 22 and 24 in CI. CI run 65 (head `0ccc0b7`) is green on both. | `.github/workflows/ci.yml`; [run 41482961356](https://github.com/mcastrucci/idle-rpg-adventure/actions/runs/41482961356) |
| 4 | Both simulators fit the interface without RPG leakage (or ADR-0019 amended) | ✅ | The survival sandbox exposed five boundary gaps (escrow, activity registry, kernel-owned duration, bounded settlement, `timelineHash`/segment RNG/predicate args), fixed in v0.2 (#67, #70). The RPG idle simulators exposed five more (cancel-after-end, kernel-owned target, start order, `unique_mint`, non-ledger estimate metrics), fixed in v0.3 (#76, #77). All new fields are optional. Both simulators pass the same contract checker. | [ADR-0019 amendments v0.2 and v0.3](../adr/0019-game-agnostic-expedition-kernel.md); `rpg-sim/src/expedition/contract.test.ts`, `games/survival-sandbox/src/scavenge.test.ts` |
| 5 | Findings written into ADR-0013, status updated | ✅ | ADR-0013 moved to Accepted (tick duration stays a playtest-tunable constant). | [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md) |

## Other measurements requested by the issue

| Measurement | Result | Number / evidence |
|---|---|---|
| Event-hash equality across 1,000 runs | ⚠️ gap | No test repeats one seed 1,000 times. Covered instead: the kernel contract checker runs every simulator input twice (second time deep-cloned) and compares stable JSON (`determinism` rule) for 4 RPG fixtures x 20 seeds and the sandbox fixtures; resuming from every `stateAfter` reproduces the suffix; `timelineHash` is equal after `structuredClone` (`engine/expedition-kernel/src/timeline.test.ts`); golden hashes pin 4 idle expeditions and the combat cases. A 1,000-run loop needs a new script or test and was not added (documentation-only task). |
| Memory/GC, internal mutation vs immutable copies | ⚠️ gap | Not measured as heap/GC. Time cost only: the public `step` deep-copies state each tick (about 50-85 us/tick), while a 10,000-tick `runToEnd` (working copy mutated internally, as ADR-0004 allows) takes about 20 ms for 7,184 events. In use: `step` copies at the boundary (live, 500 ms tick, negligible); batch callers use `runToEnd`. A heap profile of the 90-segment precompute and of a 200-run estimate remains to be taken. |
| Timings on Node 24 | gap | Benchmarks ran on Node 22 only. Node 24 is covered for replay equality (CI) but its timings are not recorded. |

## Environment of the numbers in this report

Dev container, 4 vCPU Intel Xeon @ 2.10 GHz, Node v22.23.4, pnpm 10.28.0,
`RPG_IDLE_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/bench --silent=false`, worktree based on
`0ccc0b7`. Level-4 reference builds; all runs completed (10000 bp completed); XP p10 / p50 / p90 = 1885 / 1974 / 2055.
Wall-clock timing is test-only (`process.hrtime`). Results vary by up to about 1.5x between runs on shared hardware
(p95 25-37 ms in #76 versus 24-47 ms here); the margin to the 100 ms budget is at least 2x in every observation.

## Findings carried forward

1. **Estimates need a cache or a cheaper path before the setup screen ships** (#53): cache by `(buildHash, areaId,
   activityId, durationMin, consumables, rulesHash, contentHash, engineVersion)`, a lower N for first paint, a worker
   thread if needed; a per-encounter composed estimate is the documented fallback if cold-cache latency still matters.
2. **Interface amendments were needed and are done** (ADR-0019 v0.2 and v0.3); none put RPG concepts in `engine/*`.
3. **Pacing numbers are content, not engine:** Region 1 hunt is 30 encounters/hour (90 per 3 h), gather 10/hour;
   between-fight regen defaults to 15 % (`DEFAULT_RPG_IDLE_TUNING`). Both remain provisional (open decisions #16 and #1).
4. **Balance side finding:** kill times in the Region 1 baseline miss the intended band at both ends; this is a content
   tuning matter (M1), not an engine limit ([baseline](../design/balance/region-1-baseline.md)).
5. **Follow-up if wanted before M1:** a repeated-run hash test and a heap/GC measurement (small script or opt-in test).
