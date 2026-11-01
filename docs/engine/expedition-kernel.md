# Engine Spec: Expedition Kernel

> Status: **Draft v0.2** (kernel 0.2.0, ADR-0019 amendment 2026-11). Decisions: [ADR-0005](../adr/0005-idle-precompute-at-start.md),
> [ADR-0019](../adr/0019-game-agnostic-expedition-kernel.md). RPG specifics:
> [`../spec/idle-simulation.md`](../spec/idle-simulation.md).

## 1. Simulator interface (illustrative)

> The implemented contract lives in [`engine/expedition-kernel`](../../engine/expedition-kernel/README.md):
> `configSchema` became `parseConfig(input: unknown)` (no Zod in the engine), `pace` is in basis points, `budget` is
> the planned total segment weight, `SimState`/`Report` are type parameters, and `SettleReason` is
> `'completed' | 'cancelled' | 'member_left'`. Placement: `revealAt = startsAt + ⌊cumWeight × duration / budget⌋`, so
> an early end ends early. Reveal exposes the *planned* end only; the actual end and outcome appear once reached.
>
> v0.2 additions: optional `escrow(config, actors)` (automatic returns via `settleWithEscrow`), `canStart` receives
> world/area/eval contexts/predicates, a `Game` type parameter, simulator IDs follow `<game>.<name>`, `timelineHash`,
> `segmentStreams`. Duration is kernel-owned: game configs must not carry it.

```ts
interface ExpeditionSimulator<Config, Snapshot, Event> {
  id: string;               // e.g. "rpg.hunt", "survival.scavenge"
  version: string;          // part of the stored engine/plugin version
  configSchema: ZodType<Config>;
  canStart(ctx: StartContext<Config>): Result;          // beyond engine checks (§2.1); gets world, area, eval ctxs
  escrow?(config: Config, actors: Snapshot[]): LedgerDelta[];   // moved source → 'escrow' at start (v0.2)
  budget(config: Config, durationMin: number, pace: number): number;   // number of segments
  simulate(input: {
    config: Config;
    actors: Snapshot[];
    seed: Seed;
    budget: number;
    from?: { segment: number; state: unknown };          // party re-simulation
  }): Timeline<Event>;                                   // pure, deterministic
  settle(timeline: Timeline<Event>, cutoff: number, reason: SettleReason): LedgerDelta[];
  summarize(timeline: Timeline<Event>, cutoff: number): ReportData;    // report + failure log
}

type Timeline<E> = {
  segments: { index: number; weight: number; events: E[]; deltas: LedgerDelta[]; stateAfter?: unknown }[];
  outcome: 'completed' | 'retreated' | 'failed';
};
type LedgerDelta = { actorId; asset; qty; from?: Container; to?: Container };
type StartRequest = { areaId: AreaId; activityId: string /* ns:name in area.activities */; durationMin; paceBp };
```

**IDs.** Simulator IDs name code (`<game>.<name>`, `SIMULATOR_ID_PATTERN`); activity IDs are content (`ns:name`)
listed in `area.activities`. An `ActivityRegistry` maps activity → simulator (many-to-one allowed).

**Inputs.** `Config` is per expedition; per-actor inputs live in actor snapshots or are expanded per actor by
`escrow(config, actors)`. `durationMin`/`paceBp` belong to the start request only.

**RNG.** Recommended: `segmentStreams(seed, i)` per segment (`deriveSeed(seed, 'segment', i)`), so `stateAfter`
holds game state only and same-seed resumption reproduces the suffix.

## 2. Kernel responsibilities

1. **Start** — `checkStart` (pure): area exists, activity listed in `area.activities` and registered to this
   simulator, positive duration/pace, one eval context per actor, area completed by every actor (`evaluateCompletion`;
   no rule = open), well-formed escrow, positive budget, then `simulator.canStart`. Then lock actors (ascending ID), CAS
   activity, apply the escrow deltas (source → `escrow`), snapshot via game `snapshotActor`, call `simulate`, persist
   timeline + `seed` + versions + `timelineHash`, compute `revealAt` per segment from weights, schedule settlement.
2. **Reveal** — return segments with `revealAt ≤ now` and aggregates; never the outcome early.
3. **Settle** — idempotent conditional update; apply `settleWithEscrow(...).deltas` (the simulator's `settle` deltas
   followed by the automatic return of unused escrow, `escrowed − consumed` per actor and asset) through `economy` with keys
   `(expedition, revision, seq)`; run game `afterSettlement` hook; release activity lock.
4. **Cancel** — `cutoff = last revealed segment` (−1 before the first one: everything escrowed is returned); same
   settle path with `reason = cancelled`. The partial-reward policy itself remains open decision #6.
5. **Party** — invitations (`config_version`, expiry), revisions on leave (`from` state + derived seed).
6. **Estimate** — N calls to `simulate` with derived seeds; percentile aggregation of deltas and outcome rate; cache.

## 3. Guarantees the kernel tests generically

- Same inputs ⇒ same timeline hash (`timelineHash`).
- Custom settlement stays within the default bound and conserves escrow (contract checker, per-reason modes).
- Settlement applied at most once per revision.
- Σ deltas applied == ledger change; escrow fully consumed or returned.
- No API response contains unrevealed segments.

These tests run against both `games/rpg` and `games/survival-sandbox` simulators.

## 4. Survival sandbox simulator (boundary test)

- Config: district, duration, supplies (food, water, medkits).
- Segment = one in-game hour: consume food/water, roll finds (`loot` stream), roll threats (`encounters` stream),
  injuries reduce condition; outcome `failed` at condition 0, `retreated` when supplies run out.
- No combat engine, no XP — if implementing it requires RPG code, the kernel boundary is wrong.
