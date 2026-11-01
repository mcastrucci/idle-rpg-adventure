# Engine Spec: Expedition Kernel

> Status: **Draft v0.1**. Decisions: [ADR-0005](../adr/0005-idle-precompute-at-start.md),
> [ADR-0019](../adr/0019-game-agnostic-expedition-kernel.md). RPG specifics:
> [`../spec/idle-simulation.md`](../spec/idle-simulation.md).

## 1. Simulator interface (illustrative)

```ts
interface ExpeditionSimulator<Config, Snapshot, Event> {
  id: string;               // e.g. "rpg.hunt", "survival.scavenge"
  version: string;          // part of the stored engine/plugin version
  configSchema: ZodType<Config>;
  canStart(ctx: StartContext<Config>): Result;          // beyond engine checks (completion, activity lock)
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
```

## 2. Kernel responsibilities

1. **Start** — lock actors (ascending ID), CAS activity, escrow inputs, snapshot via game `snapshotActor`, call
   `simulate`, persist timeline + `seed` + versions, compute `revealAt` per segment from weights, schedule settlement.
2. **Reveal** — return segments with `revealAt ≤ now` and aggregates; never the outcome early.
3. **Settle** — idempotent conditional update; apply `settle(...)` deltas through `economy` with keys
   `(expedition, revision, seq)`; run game `afterSettlement` hook; release activity lock.
4. **Cancel** — `cutoff = last revealed segment`; same settle path with `reason = cancelled`.
5. **Party** — invitations (`config_version`, expiry), revisions on leave (`from` state + derived seed).
6. **Estimate** — N calls to `simulate` with derived seeds; percentile aggregation of deltas and outcome rate; cache.

## 3. Guarantees the kernel tests generically

- Same inputs ⇒ same timeline hash.
- Settlement applied at most once per revision.
- Σ deltas applied == ledger change; escrow fully consumed or returned.
- No API response contains unrevealed segments.

These tests run against both `games/rpg` and `games/survival-sandbox` simulators.

## 4. Survival sandbox simulator (boundary test)

- Config: district, duration, supplies (food, water, medkits).
- Segment = one in-game hour: consume food/water, roll finds (`loot` stream), roll threats (`encounters` stream),
  injuries reduce condition; outcome `failed` at condition 0, `retreated` when supplies run out.
- No combat engine, no XP — if implementing it requires RPG code, the kernel boundary is wrong.
