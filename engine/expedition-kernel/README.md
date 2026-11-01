# @engine/expedition-kernel

Game-agnostic idle expedition kernel (ADR-0005, ADR-0019, [spec](../../docs/engine/expedition-kernel.md)). This is the
**pure part**: the simulator plugin contract, timeline types, wall-clock placement/reveal/cutoff helpers, Monte Carlo
estimates and a reusable contract checker. Persistence, jobs and the ledger wiring come later (M6). No game concepts
here; determinism rules (ADR-0004) apply: integer math, no clock (timestamps are integer ms passed in), no
`Math.random`.

## Versioning

`KERNEL_VERSION` (`0.1.0`) versions the kernel's behaviour (placement rule, settle semantics, estimate seeding).
Persisted expeditions record `KERNEL_VERSION` **and** the simulator's `id` + `version` (plus seed and content hash).
Bump the relevant one on any behaviour change.

## Simulator contract

```ts
interface ExpeditionSimulator<Config, Snapshot, Event, SimState = unknown, Report = unknown> {
  id: string;                    // 'rpg.hunt', 'survival.scavenge'
  version: string;
  parseConfig(input: unknown): Config;               // throws on invalid input (Zod optional, game-side)
  canStart(ctx: StartContext<Config, Snapshot>): StartCheck;
  budget(config: Config, durationMin: number, paceBp: number): number;  // planned total weight
  simulate(input: { config; actors: Snapshot[]; seed: Seed; budget: number;
                    from?: { segment: number; state: SimState } }): Timeline<Event, SimState>;
  settle(timeline, cutoff: number, reason: SettleReason): LedgerDelta[];  // segments 0..cutoff, -1 = none
  summarize(timeline, cutoff: number): Report;
}
type Timeline<E, S> = { segments: Segment<E, S>[]; outcome: 'completed' | 'retreated' | 'failed' };
type Segment<E, S> = { index; weight /* positive safe int */; events: E[]; deltas: LedgerDelta[]; stateAfter?: S };
type SettleReason = 'completed' | 'cancelled' | 'member_left';
```

Differences from the illustrative spec: `configSchema: ZodType` became `parseConfig(input)` (no Zod dependency);
`SimState` and `Report` are type parameters; `pace` is in basis points (`paceBp`); `budget` is the planned **total
weight** (= segment count with unit weights).

- `SettleReason` is closed. `completed` = natural end at `endsAt` (whatever the outcome; the outcome is on the
  timeline). `cancelled` = owner cancel at the cancel cutoff. `member_left` = a party member's share at a revision.
- `defaultSettle(timeline, cutoff)` = deltas of segments `0..cutoff`; simulators without special rules use
  `settle: defaultSettle`.
- Resumption (party revisions): `simulate` with `from: { segment: k, state: segments[k-1].stateAfter }`, seed
  `revisionSeed(seed, r)` and the **remaining** budget returns segments starting at index `k`;
  `spliceTimeline(original, k, resumed)` keeps the prefix. `stateAfter` is server-only (it may encode RNG state).

## Placement rule

```
revealAt[i] = startsAt + ⌊cumWeight[i] × durationMs / budget⌋
endsAt      = startsAt + ⌊Σweight × durationMs / budget⌋      (last revealAt, or startsAt if no segments)
```

The denominator is the **planned budget**, not the produced weight: a timeline that consumes the full budget ends
exactly at `startsAt + durationMs`; one that stops early (failed/retreated, Σweight < budget) ends early at its last
segment's reveal time. With unit weights this is the RPG spec's `startsAt + (i+1)/budget × duration`. Exact integer
math via `mulDivFloor`; reveal times are non-decreasing and may coincide when `durationMs < budget`.

`placeSegments(timeline, startsAtMs, durationMs, budget)` → `PlacedTimeline` with `revealAtMs` per segment,
`plannedEndsAtMs` and the actual `endsAtMs` (server-only until reached).

## Reveal, cancel, seeds

- `revealCutoff(placed, nowMs)` — last segment with `revealAtMs ≤ now` (−1 if none). `cancelCutoff` = same.
- `visibleView(placed, nowMs)` — client-safe: revealed segments without `stateAfter`, `revealedDeltas` (net), the
  **planned** end, and `outcome`/`endedAtMs` only once `now ≥ endsAt`. It never exposes the actual end or the segment
  count early (an early end would reveal a failure in advance), so progress bars use `plannedEndsAtMs`.
- `revisionSeed(seed, r)` — `r = 0` → `seed`, else `deriveSeed(seed, 'revision', r)`.

## Estimates

`estimate(simulator, { config, actors, budget }, runs, rootSeed)` runs `simulate` with
`estimateSeed(rootSeed, i) = deriveSeed(rootSeed, 'estimate', i)`, settles each full timeline with `completed`, and
returns per `(actorId, asset)` net holdings `min/p10/p50/p90/max` (nearest rank `⌈p·n/100⌉`; runs without a change
count as 0), outcome counts and `outcomeRatesBp = ⌊count·10000/runs⌋`. All integers.

## Contract checker

```ts
expect(checkSimulatorContract(simulator, [{ config, actors, budget, seeds: [1, 2, 3] }])).toEqual([]);
```

Returns `ContractViolation[]` (no test-framework dependency). Checks: determinism (stable JSON with sorted keys via
`stableStringify`), no input mutation, JSON-only data, contiguous indices from 0, positive integer weights, safe-integer
delta quantities, Σweight ≤ budget, `parseConfig` round-trip, `settle` validity/determinism for every reason and cutoff
(equality with `defaultSettle` when the simulator uses it, or with `{ settlement: 'default' }`), `summarize`
determinism, and resumption from `stateAfter` (when present).
