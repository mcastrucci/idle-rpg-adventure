# Spec: Idle Expedition Simulation

> Status: **Solo POC implementation contract; pacing and penalty values remain unvalidated**. Decision: [ADR-0005](../adr/0005-idle-precompute-at-start.md),
> [ADR-0013](../adr/0013-tick-and-idle-encounter-model.md).

> **Engine mapping (ADR-0019):** lifecycle, reveal, settlement, cancellation, party and estimates are implemented by
> `engine/expedition-kernel` ([spec](../engine/expedition-kernel.md)); this document describes the RPG simulator
> plugin (`games/rpg/packages/rpg-sim`): segments = encounters. The current contract uses kernel v0.3; duration, pace,
> area and activity come from the kernel-owned start request, and RPG config contains only consumables and retreat policy.

## 1. Lifecycle

```
draft ──(solo)──────────────────────────► running ──► completed | cancelled
  │                                         │
  └─(party, phase 2)─► pending_invites ─────┤
                         │ expiry/decline   └──cancel──► cancelled (partial settlement)
                         ▼
                       draft
```

The timeline outcome (`completed`, `retreated` or `failed`) is separate from the persisted lifecycle state.

## 2. Configuration

| Field | Values (POC) |
|---|---|
| Start request `areaId`, `activityId` | A content activity listed in that area and registered to an RPG simulator; server checks the actor's persisted completion state |
| Start request `durationMin`, `paceBp` | Duration is one of 15, 30, 60, 180 minutes; the current server allows `paceBp = 10000` (normal pace) |
| `consumables` | item IDs + quantities from inventory (escrowed) |
| `retreat` | `belowHpBp` and `onlyWhenNoHealing`; policy is stored in config |
| `snapshot` | Server-generated attributes, level, equipped-item stats, skills and automation rules for each actor. Starting HP defaults to derived max HP in the current character model. |

## 3. Start (single transaction)

1. Lock the actor row, validate ownership and `activity_state = 'none'`, then evaluate the area's completion rule from server-owned progress.
2. Parse the start request and RPG config; derive the actor snapshot on the server.
3. Move requested consumables `inventory → expedition escrow` through the ledger, and CAS the actor to `expedition`.
4. Generate a seed, simulate, place segments, and persist the input snapshot, config, content/simulator/kernel versions, timeline hash and compressed timeline.
5. Insert the durable settlement job in the same transaction, due at the actual end.
6. Commit and return a client-safe view only.

## 4. Simulation model

- The kernel asks the simulator for an integer segment budget using the requested duration and pace. The current RPG
  rule floors the per-hour rate calculation and plans at least one segment.
- For each encounter `i`: roll enemy group from the activity's encounter table (`encounters` stream); run combat to end
  with automation policy; apply between-encounter regen *(provisional: % HP regen between fights)*; roll loot
  (`loot` stream) into a virtual expedition bag; consume escrowed consumables as used.
- Wall-clock placement uses each segment's weight against the planned budget. An early failed or retreated timeline
  ends at its last segment's reveal time; the planned end remains safe to show before then.
- Each simulated segment stores its events, deltas and server-only post-segment state; the complete deterministic
  timeline is compressed and persisted at start so reveal and settlement do not rerun the simulation.

## 5. Reveal

`GET /expeditions/:id` returns only segments with `revealAt ≤ now()` and aggregates derived from those segments. It omits
`stateAfter`, the total segment count, actual end and outcome until the actual end is reached. Progress uses the planned
end. The server lazily settles an overdue expedition before returning its final view; the durable job provides the
background settlement path. `visibleView` enforces the kernel-level reveal boundary.

## 6. Settlement (idempotent)

Triggered by the durable job at the actual end or lazily on read after the actual end. The settlement transaction:

```sql
UPDATE expeditions SET status=:final_state, settled_at=:settled_at
WHERE id=:id AND revision=:revision AND status='running'
RETURNING *;
```

`:final_state` is `completed` for a natural end and `cancelled` for a pre-end cancellation.

The running-state claim, ledger deltas (including escrow returns), XP progression/death penalty, actor unlock and final
expedition status are committed together. Retried jobs or lazy settlement apply the mutation once. The persisted final
state distinguishes completed from cancelled; the timeline outcome is `completed`, `retreated` or `failed`.

## 7. Cancellation (solo POC policy; decision #6)

- Before the actual end, cancellation settles through the last revealed segment: its grants apply in full, its used
  consumables are consumed, and unused escrow is returned. There is no separate cancellation penalty.
- At or after the actual end, a cancel request is resolved as natural completion over the full timeline, so a fatal
  segment revealed at the end receives the normal death penalties. The kernel owns the cutoff/reason resolution.
- Revisit the policy if playtests show cancellation abuse.

## 8. Estimates

- Monte Carlo runs use the same simulator with derived seeds and can aggregate ledger deltas plus RPG metrics such as
  gross XP and death rate. Report percentiles and label the result as an estimate.
- Cache inputs must include canonical server snapshot/build, area/activity, duration/pace, config/rules, content hash and
  kernel/simulator versions. Cache implementation and target latency are tracked separately (#53).
- On Node 24.22.1, 60-seed 180-minute/90-segment simulation benchmarks measured p95 31.9 ms for the Bulwark build and
  23.7 ms for Thornblade. Two hundred estimates took 5.169 s and 3.882 s, respectively, above the 2 s target; estimate
  caching remains a prerequisite tracked by #53. These figures measure simulator work, not database-backed start latency.
- UI must label estimates as estimates.
- **Implemented (#53):** `POST /characters/:actorId/expedition-estimate` (read-only, same server snapshot and start gate
  as a real start; the client sends no stats). Run count `n = clamp(⌊5000 / budget⌋, 60, 200)` *(provisional)*: a
  180-minute hunt uses 60 runs, 15–30 minutes 200. Samples run on a worker-thread pool (started at boot) in 4 fixed seed
  chunks whose root seed derives from the cache key, never from a start seed. Results are cached in an in-process LRU
  keyed by the SHA-256 of `(buildHash, rulesHash, configHash, areaId, activityId, durationMin, paceBp, n, contentHash,
  kernelVersion, simulatorId, simulatorVersion, estimate model version)`. Measured: first cache miss 0.36–1.06 s, cache
  hit < 0.1 ms in process (about 15 ms over HTTP), so the 2 s spike-1 budget is met cached or not and the per-encounter
  fallback is not needed. A validation test checks that about 80 % of independent real runs fall within [p10, p90].
  Design and numbers: [server README, Expedition estimates](../../games/rpg/apps/server/README.md#expedition-estimates-53).

## 9. Death in idle

- A failed timeline ends at the fatal encounter; the client learns this only when that segment is revealed.
- Report includes a **death log**: last encounter's key events (big hits, missed heals, consumables exhausted) in plain
  language.
- Current idle POC penalties are recorded in [rewards-and-persistence.md](rewards-and-persistence.md); their values remain provisional pending playtesting.
