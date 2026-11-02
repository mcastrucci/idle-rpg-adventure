/**
 * The `ExpeditionSimulator` plugin contract (ADR-0019, docs/engine/expedition-kernel.md §1).
 *
 * The kernel knows nothing about what happens during an expedition. A game plugs in a pure, deterministic simulator
 * that turns `(config, actor snapshots, seed, budget)` into a {@link Timeline} of weighted segments with events and
 * ledger deltas *as data*. The kernel places segments on the wall clock, reveals them, settles and estimates.
 */

import type { LedgerDelta } from '@engine/economy';
import type { Seed } from '@engine/sim-core';
import type { Area, AreaId, EvalContext, PredicateRegistry, World } from '@engine/world';

/**
 * Simulator (plugin) IDs: `<game>.<name>` in lowercase snake case separated by dots, e.g. `rpg.hunt`,
 * `survival.scavenge`. They name *code* (stored with `version` on every expedition) and are deliberately distinct from
 * content IDs (`ns:name`, `IdSchema`): areas list **activity** IDs (content), and an `ActivityRegistry` maps each
 * activity ID to the simulator that runs it (several activities may share one simulator).
 */
export const SIMULATOR_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** How the simulated expedition ended. */
export type Outcome = 'completed' | 'retreated' | 'failed';

export const OUTCOMES: readonly Outcome[] = ['completed', 'retreated', 'failed'];

/**
 * Why a timeline is being settled (closed union; extending it is a kernel version bump).
 * - `completed`: the expedition reached its end (`now ≥ endsAt`). The *outcome* (completed/retreated/failed) is in
 *   `timeline.outcome`; this reason only says the whole timeline is being settled naturally.
 * - `cancelled`: the owner cancelled; the cutoff is the last revealed segment (see `cancelCutoff`).
 * - `member_left`: a party member leaves; their share is settled up to the cutoff before the remainder is
 *   re-simulated for the others with a revision seed.
 */
export type SettleReason = 'completed' | 'cancelled' | 'member_left';

export const SETTLE_REASONS: readonly SettleReason[] = ['completed', 'cancelled', 'member_left'];

/**
 * What an expedition targets: an activity (content ID, `ns:name`, listed in `area.activities`) in an area. Part of the
 * start request and **kernel-owned** like the duration (v0.3): the kernel passes it to `canStart`, `budget`,
 * `simulate` and estimates, so game configs must not duplicate it. Persist it with the expedition (resumption and
 * estimates need it again).
 */
export interface ActivityRef {
  readonly areaId: AreaId;
  /** Content ID (`ns:name`, e.g. `activity:scavenge`, `idle:hunt`) listed in the area's `activities`. */
  readonly activityId: string;
}

/** One unit of simulated progress (an encounter, an in-game hour…). */
export interface Segment<Event, SimState = unknown> {
  /** Position in the timeline; contiguous from 0 (or from `from.segment` for a resumed simulation). */
  readonly index: number;
  /** Share of the planned budget this segment consumes; a positive safe integer (usually 1). */
  readonly weight: number;
  /** Game events, opaque to the kernel. Must be JSON data. */
  readonly events: readonly Event[];
  /** Ledger changes this segment produces (applied only at settlement, via `settle`). */
  readonly deltas: readonly LedgerDelta[];
  /**
   * Simulator state after this segment, needed to resume from the next segment (party revisions). Server-only: it
   * may encode RNG state, i.e. the future, so the kernel never exposes it in views.
   */
  readonly stateAfter?: SimState;
}

/** Result of `simulate`. Plain JSON data, persisted as-is with the seed and versions. */
export interface Timeline<Event, SimState = unknown> {
  readonly segments: readonly Segment<Event, SimState>[];
  readonly outcome: Outcome;
}

/**
 * Input of `canStart`, for checks beyond the engine's own (area exists, activity listed and registered, area completed
 * by every actor, config parsed — see `checkStart`). `canStart` runs before `escrow` and `budget` (v0.3), so it can
 * refuse what those cannot handle.
 *
 * `durationMin`, `paceBp`, `areaId` and `activityId` are **kernel-owned**: they come from the start request, are passed
 * here and to `budget`/`simulate`, and game configs must not duplicate them.
 */
export interface StartContext<Config, Snapshot, Game = unknown> {
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  readonly durationMin: number;
  /** Pace multiplier in basis points (10 000 = ×1). */
  readonly paceBp: number;
  /** The requested area (v0.3). Always set when called through `checkStart`; may be absent in direct unit-test calls. */
  readonly areaId?: AreaId;
  /** The requested activity (v0.3). Always set when called through `checkStart`; may be absent in direct calls. */
  readonly activityId?: string;
  /** World and target area. Always set when called through `checkStart`; absent in direct unit-test calls. */
  readonly world?: World;
  readonly area?: Area;
  /**
   * One requirement evaluation context per actor, aligned with `actors`, plus the game's predicate registry, so a
   * simulator can evaluate requirements (e.g. "has a tool") with `@engine/world`'s `evaluateRequirement`. Set by
   * `checkStart`.
   */
  readonly evalContexts?: readonly EvalContext<Game>[];
  readonly predicates?: PredicateRegistry<Game>;
}

/**
 * Result of `canStart`. `code` is a stable machine-readable reason; `reasons` optionally carries requirement reason
 * keys (`requires.*`) for "locked because…" UI.
 */
export type StartCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message?: string; readonly reasons?: readonly string[] };

/** Resume point for re-simulation: start at `segment` from the `stateAfter` of segment `segment - 1`. */
export interface ResumeFrom<SimState> {
  readonly segment: number;
  readonly state: SimState;
}

export interface SimulateInput<Config, Snapshot, SimState = unknown> {
  readonly config: Config;
  /** Frozen actor snapshots (generic participants: a hero, a group of survivors, a drone…). */
  readonly actors: readonly Snapshot[];
  readonly seed: Seed;
  /**
   * Planned total weight available to the returned segments (Σ weight ≤ budget). For a resumed simulation this is
   * the *remaining* budget (`full budget − Σ weight of the kept prefix`).
   */
  readonly budget: number;
  readonly from?: ResumeFrom<SimState>;
  /**
   * The expedition's target (v0.3, kernel-owned: the start request's `areaId`/`activityId`). Callers that know it
   * (start, resumption, estimates, contract fixtures) pass it; a simulator that needs it throws when it is absent.
   */
  readonly areaId?: AreaId;
  readonly activityId?: string;
}

/**
 * A game's expedition simulator. Every method except `canStart`'s data access must be pure and deterministic
 * (ADR-0004): same inputs ⇒ same output, no clock, no `Math.random`, no floats in game math, no I/O, no shared
 * mutable state between calls.
 *
 * Persisted expeditions record `KERNEL_VERSION` plus this simulator's `id` and `version`; a behaviour change of the
 * simulator requires bumping `version` (in-flight expeditions keep their stored timeline).
 */
export interface ExpeditionSimulator<Config, Snapshot, Event, SimState = unknown, Report = unknown, Game = unknown> {
  /** Stable plugin id matching {@link SIMULATOR_ID_PATTERN}, e.g. `rpg.hunt`, `survival.scavenge`. */
  readonly id: string;
  /** Plugin behaviour version, stored with every expedition. */
  readonly version: string;
  /**
   * Validates untrusted input and returns a typed config; throws on invalid input. Games may implement it with Zod
   * (`schema.parse`); the kernel has no schema-library dependency.
   */
  parseConfig(input: unknown): Config;
  /**
   * Game-specific start checks beyond the engine's own (see {@link StartContext}). Should refuse (not throw); a throw
   * is turned into `start.simulatorError` by `checkStart`.
   */
  canStart(ctx: StartContext<Config, Snapshot, Game>): StartCheck;
  /**
   * What is moved into the engine `escrow` container at start, per actor (e.g. supplies, consumables). Each delta
   * must be `{ actorId, asset, qty > 0, from: <source container ≠ 'escrow'>, to: 'escrow' }`, with at most one source
   * container per (actor, asset). Segments consume escrow with `from: 'escrow'` deltas; at settlement the kernel
   * returns `escrowed − consumed` to the source container automatically (`settleWithEscrow`), so `settle` never deals
   * with leftovers. Omitted = nothing is escrowed. Pure and deterministic.
   */
  escrow?(config: Config, actors: readonly Snapshot[]): LedgerDelta[];
  /**
   * Planned total segment weight for a duration (with unit weights: the number of segments). Positive safe int.
   * `target` (v0.3) is the start request's area/activity; always passed by `checkStart`.
   */
  budget(config: Config, durationMin: number, paceBp: number, target?: ActivityRef): number;
  /** Pure and deterministic. */
  simulate(input: SimulateInput<Config, Snapshot, SimState>): Timeline<Event, SimState>;
  /**
   * Ledger deltas to apply when settling segments `0..cutoff` (inclusive; `-1` = none) for `reason`. Must only
   * depend on its arguments. Simulators without special rules can use `defaultSettle`. Escrow returns are added by
   * the kernel (`settleWithEscrow`); `settle` must never consume more from `escrow` than was escrowed, and a custom
   * settle never grants more than `defaultSettle` would (see the contract checker).
   */
  settle(timeline: Timeline<Event, SimState>, cutoff: number, reason: SettleReason): LedgerDelta[];
  /** Report data (summary, failure log…) for segments `0..cutoff`. */
  summarize(timeline: Timeline<Event, SimState>, cutoff: number): Report;
}
