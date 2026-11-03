# Spike 1 report: step-based combat engine, idle precompute and estimates

- **Issue:** [#11](https://github.com/mcastrucci/idle-rpg-adventure/issues/11) (epic M0, [#1](https://github.com/mcastrucci/idle-rpg-adventure/issues/1))
- **Validates:** [ADR-0004](../adr/0004-deterministic-step-engine.md), [ADR-0005](../adr/0005-idle-precompute-at-start.md),
  [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md), the [ADR-0019](../adr/0019-game-agnostic-expedition-kernel.md)
  simulator interface.
- **Outcome:** ADR-0013 Accepted. All requested measurements are now recorded (1,000-run hash equality, memory/GC,
  Node 22 and 24 timings). One target is missed as a raw measurement (a 200-run estimate of a 3 h hunt takes 2.1-3.0 s here);
  its mitigation (worker pool, run count n = clamp(⌊5000/segments⌋, 60, 200), cache) is implemented by
  [#53](https://github.com/mcastrucci/idle-rpg-adventure/issues/53) ([PR #92](https://github.com/mcastrucci/idle-rpg-adventure/pull/92)).

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
| 1 | 3h precompute p95 < 100 ms | ✅ | 180 min Region 1 hunt = 90 segments. Re-run for this report: p50 / p95 / max = 23.9 / 47.0 / 55.1 ms (Bulwark L4), 16.0 / 24.0 / 35.1 ms (Thornblade L4), 60 runs each. Earlier run (#76): p95 25-37 ms. Re-measured on Node 22 and 24 (two runs each, see "Node 22 and 24 timings"): p95 12-19 ms on both, max 22 ms. | `rpg-sim/src/expedition/bench.test.ts` (opt-in `RPG_IDLE_BENCH=1`); [rpg-sim README, Measurements](../../games/rpg/packages/rpg-sim/README.md) |
| 2 | 200-run estimate < 2 s, or cache strategy documented | ⚠️ | Raw target **still missed**: 200 full 3 h runs take 2.6-3.0 s (Bulwark) and 2.2-2.4 s (Thornblade) in the latest runs (5.2 s / 3.9 s in the first run of this report, 3.7-4.8 s in #76; the spread is machine load). **Mitigation implemented by [#53](https://github.com/mcastrucci/idle-rpg-adventure/issues/53)** ([PR #92](https://github.com/mcastrucci/idle-rpg-adventure/pull/92)): n = clamp(⌊5000/segments⌋, 60, 200) runs, a worker pool started at boot and an LRU cache with single-flight. Documented in the [server README, "Expedition estimates (#53)"](../../games/rpg/apps/server/README.md): first cache miss after boot warm-up about 0.36-1.06 s (15 to 180 min; 3 h uses n = 60), cache hit 0.02-0.03 ms (under 0.1 ms). Those numbers are quoted, not re-derived here. | same bench; [idle-simulation §8](../spec/idle-simulation.md), [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md) |
| 3 | Identical replays across Node versions | ✅ | Golden replays (combat and idle timelines) run in `pnpm check` on Node 22 and 24 in CI. CI run 65 (head `0ccc0b7`) is green on both. The new 1,000-run determinism test (below) also runs on both. | `.github/workflows/ci.yml`; [run 41482961356](https://github.com/mcastrucci/idle-rpg-adventure/actions/runs/41482961356) |
| 4 | Both simulators fit the interface without RPG leakage (or ADR-0019 amended) | ✅ | The survival sandbox exposed five boundary gaps (escrow, activity registry, kernel-owned duration, bounded settlement, `timelineHash`/segment RNG/predicate args), fixed in v0.2 (#67, #70). The RPG idle simulators exposed five more (cancel-after-end, kernel-owned target, start order, `unique_mint`, non-ledger estimate metrics), fixed in v0.3 (#76, #77). All new fields are optional. Both simulators pass the same contract checker. | [ADR-0019 amendments v0.2 and v0.3](../adr/0019-game-agnostic-expedition-kernel.md); `rpg-sim/src/expedition/contract.test.ts`, `games/survival-sandbox/src/scavenge.test.ts` |
| 5 | Findings written into ADR-0013, status updated | ✅ | ADR-0013 moved to Accepted (tick duration stays a playtest-tunable constant). | [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md) |

## Other measurements requested by the issue

| Measurement | Result | Number / evidence |
|---|---|---|
| Event-hash equality across 1,000 runs | ✅ | `rpg-sim/src/expedition/determinism.test.ts`, part of the normal suite (`pnpm check`, CI on Node 22 and 24). 1,000 runs with inputs rebuilt every run: the idle hunt `hunt-thornblade-l1-30min-no-potions-seed-3` gives one single `timelineHash`, and the combat case `party-auto-seed-42` one single event hash; both equal the frozen golden hashes of the current versions (no new golden entries). Duration of the file: 2.2 s on Node 22.23.4 and 2.2 s on Node 24.22.1 (explicit 60 s timeout per test). Also covered earlier: the kernel contract checker (second run on deep-cloned inputs, 4 RPG fixtures x 20 seeds), resumption from every `stateAfter`, `timelineHash` after `structuredClone`. |
| Memory/GC, internal mutation vs immutable copies | ✅ | `rpg-sim/src/expedition/memory.bench.test.ts` (opt-in). Over the same 10,000-tick fight the public `step` (deep copy per tick) allocates about 4x more than `runToEnd` (internal mutation) and takes about 16x longer; the collector keeps up in both (minor GCs, at most one major, a few ms of pause). See "Memory and GC" below. |
| Timings on Node 24 | ✅ | Precompute p95 12-17 ms on Node 24.22.1, in line with Node 22.23.4 (12-19 ms). Tables below. |

## Node 22 and 24 timings

Command (once per Node version; Node 24 is `/opt/node24/bin/node`, run with that binary's `node_modules/vitest/vitest.mjs`
or with `/opt/node24/bin` first in `PATH`):

```
RPG_IDLE_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/bench --silent=false
```

Same machine and session for both versions, 60 precompute runs per build and per bench run, 2 bench runs per version
(range shown). Estimate = 200 runs of the full 90-segment hunt on one thread (not the #53 path).

| Build | Metric | Node 22.23.4 | Node 24.22.1 |
|---|---|---|---|
| Bulwark L4 | precompute p50 | 14.0-14.4 ms | 13.8-14.6 ms |
| Bulwark L4 | precompute p95 | 16.6-16.7 ms | 17.3-17.5 ms |
| Bulwark L4 | precompute max | 17.5-18.1 ms | 20.5-22.0 ms |
| Bulwark L4 | 200-run estimate | 2.64-2.95 s | 2.75-2.96 s |
| Thornblade L4 | precompute p50 | 10.2-10.5 ms | 11.1-11.8 ms |
| Thornblade L4 | precompute p95 | 12.0-18.7 ms | 12.7-13.4 ms |
| Thornblade L4 | precompute max | 13.3-21.8 ms | 14.1-15.2 ms |
| Thornblade L4 | 200-run estimate | 2.15-2.18 s | 2.28-2.41 s |

Node 24 is within about 10 % of Node 22 on every row and the ranges overlap; there is no regression, and both versions
meet the 100 ms precompute budget by more than 5x. Outcomes (10000 bp completed, XP p10 / p50 / p90 = 1885 / 1974 /
2055) are identical on both versions.

## Memory and GC

Command (`--expose-gc` through `NODE_OPTIONS` so the forks used by vitest inherit it; forces a GC before each case):

```
NODE_OPTIONS=--expose-gc RPG_MEMORY_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/memory.bench --silent=false
```

Heap = `process.memoryUsage().heapUsed`. "After" is read right after the case without a forced GC, so it includes
garbage not yet collected (and, for `runToEnd`, the retained events array). "Peak" is the maximum of samples (every 100
ticks, or after every simulated run), a lower bound of the true peak. "Allocated" is the sum of the positive heap
increments between samples, also a lower bound (Node exposes no allocation counter); the rate is that figure over wall
time. GC counts and pauses come from a `PerformanceObserver` with `entryTypes: ['gc']`. Two runs per Node version;
ranges across them.

Node 22.23.4:

| Case (reps) | ms / rep | Heap before / after / peak (MB) | Allocated (MB), rate | GC minor / major | GC pause total |
|---|---|---|---|---|---|
| `step` x 10,000 ticks (3) | 324-350 | 21.3 / 26.0-26.2 / 37.5-37.6 | 441, 421-453 MB/s | 31 / 0 | 6.8-8.2 ms |
| `runToEnd` 10,000 ticks (3) | 20-26 | 21.5 / 39.0-39.5 / 39.5-39.6 | 104, 1.35-1.76 GB/s | 7 / 0 | 9.1-9.8 ms |
| precompute 180 min, 90 segments (20) | 13.1-14.0 | 21.5 / 24.0-24.9 / 37.5-38.4 | 79-80, 285-304 MB/s | 29 / 0 | 11.8-14.1 ms |
| estimate, 200 runs of 180 min (1) | 2,173-2,200 | 21.8 / 35.8-48.5 / 60.0-61.1 | 683-687, 311-316 MB/s | 263-264 / 3 | 100-102 ms |

Node 24.22.1:

| Case (reps) | ms / rep | Heap before / after / peak (MB) | Allocated (MB), rate | GC minor / major | GC pause total |
|---|---|---|---|---|---|
| `step` x 10,000 ticks (3) | 315-328 | 22.2 / 23.1-28.4 / 38.8-42.7 | 419, 427-444 MB/s | 29 / 0 | 6.7-11.4 ms |
| `runToEnd` 10,000 ticks (3) | 17-19 | 22.2 / 36.3-48.2 / 40.7-56.8 | 117, 2.0-2.3 GB/s | 5-7 / 0-1 | 4.3-5.2 ms |
| precompute 180 min, 90 segments (20) | 15.9-16.2 | 22.1-22.2 / 24.3-30.2 / 51.7-54.3 | 113-120, 350-377 MB/s | 15-17 / 0-1 | 9.3-9.4 ms |
| estimate, 200 runs of 180 min (1) | 2,505-2,718 | 22.1-22.3 / 86.5-100.4 / 112.0-124.6 | 1,569-2,457, 626-904 MB/s | 82-125 / 1-3 | 64-79 ms |

Reading:

- **`step` vs `runToEnd`.** The immutable boundary of `step` (a `structuredClone` of the whole state per tick) allocates
  about 14-15 KB per tick against about 3.5-4 KB for `runToEnd`, and takes about 32 us per tick against about 2 us (about
  16x). The collector keeps up: the extra garbage is short-lived, GCs are minor (at most one major on Node 24), the total
  pause is under 12 ms per 30,000 ticks in both styles, and peak heap is 37-43 MB (Node 22) for both. ADR-0004's design
  (copy at the public boundary, mutate internally for batch callers) is confirmed: copying is affordable for live play at
  500 ms per tick and not for precompute.
- **Precompute.** About 4 MB allocated per 3 h timeline, 1-2 minor GCs per run and under 1 ms of pause per run; the heap
  does not grow across 20 runs (about 24-30 MB after).
- **Estimate.** A 200-run estimate allocates about 0.7 GB (Node 22) in 2.2 s, peaks at about 60 MB and pauses for about
  100 ms in total (about 5 % of the wall time), with 3 major GCs. On Node 24 the heap grows more before collecting (peak
  112-125 MB, fewer minor GCs: a larger young generation) with a lower total pause; the allocated-byte figures of the two
  versions are not comparable because of the lower-bound sampling. Neither is a concern for a server worker, but worker
  sizing for #53 should allow about 125 MB of heap per in-flight estimate.

## Environment of the numbers in this report

Dev container, 4 vCPU Intel Xeon @ 2.10 GHz (the later session, with the Node 22 / 24 and memory numbers, reported
`nproc` = 4 and `/proc/cpuinfo` model "Intel(R) Xeon(R) Processor @ 2.30GHz"), Node v22.23.4 and v24.22.1, pnpm 10.28.0,
`RPG_IDLE_BENCH=1 pnpm exec vitest run --project @rpg/rpg-sim expedition/bench --silent=false`, worktree based on
`0ccc0b7`. Level-4 reference builds; all runs completed (10000 bp completed); XP p10 / p50 / p90 = 1885 / 1974 / 2055.
Wall-clock timing is test-only (`process.hrtime`). Results vary by up to about 1.5x between runs on shared hardware (the first run of this report measured a 200-run
estimate of 3.9-5.2 s, later runs 2.2-3.0 s on the same container)
(p95 25-37 ms in #76 versus 12-47 ms here); the margin to the 100 ms budget is at least 2x in every observation.

## Findings carried forward

1. **Estimates needed a cache or a cheaper path before the setup screen ships:** implemented by #53 (PR #92): cache key,
   run count n = clamp(⌊5000/segments⌋, 60, 200), a worker pool; first miss about 0.36-1.06 s, hit under 0.1 ms. A
   per-encounter composed estimate remains the documented fallback if cold-cache latency still matters.
2. **Interface amendments were needed and are done** (ADR-0019 v0.2 and v0.3); none put RPG concepts in `engine/*`.
3. **Pacing numbers are content, not engine:** Region 1 hunt is 30 encounters/hour (90 per 3 h), gather 10/hour;
   between-fight regen defaults to 15 % (`DEFAULT_RPG_IDLE_TUNING`). Both remain provisional (open decisions #16 and #1).
4. **Balance side finding:** kill times in the Region 1 baseline miss the intended band at both ends; this is a content
   tuning matter (M1), not an engine limit ([baseline](../design/balance/region-1-baseline.md)).
5. **Measurement gaps closed:** the 1,000-run hash test (`determinism.test.ts`, in `pnpm check`) and the opt-in
   heap/GC bench (`memory.bench.test.ts`, `RPG_MEMORY_BENCH=1`) exist, and Node 22 and 24 timings are recorded. No
   follow-up is required before M1; re-run the benches after any change to the combat engine or the idle model.
