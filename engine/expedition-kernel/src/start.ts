/**
 * Area/activity gating at expedition start (docs/engine/expedition-kernel.md §2.1): which simulator an area's
 * activity runs, and the engine's own start checks before the simulator's `canStart`.
 */

import type { LedgerDelta } from '@engine/economy';
import { NAMESPACED_ID_PATTERN, evaluateCompletion } from '@engine/world';
import type { AreaId, EvalContext, PredicateRegistry, World } from '@engine/world';

import { escrowProblems } from './escrow.ts';
import { SIMULATOR_ID_PATTERN } from './types.ts';
import type { ExpeditionSimulator, StartCheck } from './types.ts';

/** A simulator of any game, as stored in an {@link ActivityRegistry}. */
export type AnyExpeditionSimulator = ExpeditionSimulator<unknown, unknown, unknown, unknown, unknown, unknown>;

/** What a start command targets: an activity (content ID listed in `area.activities`) in an area. */
export interface ActivityRef {
  readonly areaId: AreaId;
  /** Content ID (`ns:name`, e.g. `activity:scavenge`, `idle:hunt`) listed in the area's `activities`. */
  readonly activityId: string;
}

/**
 * Start request (the client command carries this plus the raw game config). `durationMin` and `paceBp` are
 * **kernel-owned** (placement, budget); game configs must not duplicate them.
 */
export interface StartRequest extends ActivityRef {
  readonly durationMin: number;
  /** Pace multiplier in basis points (10 000 = ×1). */
  readonly paceBp: number;
}

/**
 * Maps activity IDs (content, `ns:name`) to the simulators (code, `<game>.<name>`) that run them. Several activities
 * may share one simulator. Registries are mutable; build one per game at startup.
 */
export class ActivityRegistry {
  readonly #byActivity = new Map<string, AnyExpeditionSimulator>();

  /** Registers `simulator` for `activityId`. Throws on malformed IDs, an empty version or a duplicate activity. */
  register<C, S, E, St, R, G>(activityId: string, simulator: ExpeditionSimulator<C, S, E, St, R, G>): this {
    if (!NAMESPACED_ID_PATTERN.test(activityId)) throw new Error(`Invalid activity ID "${activityId}" (expected "ns:name")`);
    if (!SIMULATOR_ID_PATTERN.test(simulator.id)) throw new Error(`Invalid simulator ID "${simulator.id}" (expected "game.name")`);
    if (typeof simulator.version !== 'string' || simulator.version === '') throw new Error(`Simulator "${simulator.id}" has no version`);
    if (this.#byActivity.has(activityId)) throw new Error(`Activity "${activityId}" is already registered`);
    this.#byActivity.set(activityId, simulator as AnyExpeditionSimulator);
    return this;
  }

  has(activityId: string): boolean {
    return this.#byActivity.has(activityId);
  }

  get(activityId: string): AnyExpeditionSimulator | undefined {
    return this.#byActivity.get(activityId);
  }

  /** Registered activity IDs, sorted. */
  activityIds(): string[] {
    return [...this.#byActivity.keys()].sort();
  }
}

/** Activities listed by areas of `world` that have no simulator in `registry` (for content/startup checks). */
export function unregisteredActivities(world: World, registry: ActivityRegistry): ActivityRef[] {
  const out: ActivityRef[] = [];
  for (const area of world.areas) {
    for (const activityId of area.activities ?? []) if (!registry.has(activityId)) out.push({ areaId: area.id, activityId });
  }
  return out;
}

export interface CheckStartInput<Config, Snapshot, Game> {
  readonly world: World;
  readonly request: StartRequest;
  readonly activities: ActivityRegistry;
  /** The simulator the caller resolved for `request.activityId` (typed); must be the registered one. */
  readonly simulator: ExpeditionSimulator<Config, Snapshot, unknown, unknown, unknown, Game>;
  /** Parsed config (`simulator.parseConfig(raw)`). */
  readonly config: Config;
  readonly actors: readonly Snapshot[];
  /** One evaluation context per actor, aligned with `actors` (completion is per actor). */
  readonly evalContexts: readonly EvalContext<Game>[];
  readonly predicates: PredicateRegistry<Game>;
}

/** {@link checkStart} result: on success, the planned budget and the validated escrow to apply. */
export type StartGate =
  | { readonly ok: true; readonly budget: number; readonly escrow: readonly LedgerDelta[] }
  | Extract<StartCheck, { ok: false }>;

function fail(code: string, message?: string, reasons?: readonly string[]): StartGate {
  return { ok: false, code, ...(message === undefined ? {} : { message }), ...(reasons === undefined ? {} : { reasons }) };
}

/**
 * The engine's start checks, in order (first failure wins; codes are stable):
 *
 * 1. `start.unknownArea` — `request.areaId` is not an area of `world`;
 * 2. `start.activityNotInArea` — `request.activityId` is not listed in `area.activities`;
 * 3. `start.unknownActivity` — no simulator registered for the activity; `start.simulatorMismatch` — the given
 *    simulator is not the registered one (compared by `id` and `version`);
 * 4. `start.invalidDuration` — `durationMin` / `paceBp` are not positive safe integers;
 * 5. `start.noActors` / `start.contextMismatch` — no actors, or not exactly one eval context per actor;
 * 6. `start.areaNotCompleted` — some actor has not completed the area (`@engine/world` `evaluateCompletion`; areas
 *    without a completion rule need none). `reasons` lists `completion.discoveries:<areaId>` when too few pool locations
 *    are discovered, then the failing `required` reason keys; `message` names the actor indices;
 * 7. `start.invalidEscrow` — `simulator.escrow` returned malformed deltas; `start.invalidBudget` — `simulator.budget`
 *    is not a positive safe integer;
 * 8. `simulator.canStart` with the world, the area, the eval contexts and the predicate registry.
 *
 * Pure: it reads only its input. Locks, activity CAS and the ledger are the caller's (server-kit) job.
 */
export function checkStart<Config, Snapshot, Game>(input: CheckStartInput<Config, Snapshot, Game>): StartGate {
  const { world, request, simulator, config, actors, evalContexts, predicates } = input;
  const area = world.areas.find((a) => a.id === request.areaId);
  if (area === undefined) return fail('start.unknownArea', `unknown area ${request.areaId}`);
  if (!(area.activities ?? []).includes(request.activityId)) {
    return fail('start.activityNotInArea', `${request.activityId} is not an activity of ${area.id}`);
  }
  const registered = input.activities.get(request.activityId);
  if (registered === undefined) return fail('start.unknownActivity', `no simulator registered for ${request.activityId}`);
  if (registered.id !== simulator.id || registered.version !== simulator.version) {
    return fail('start.simulatorMismatch', `${request.activityId} runs ${registered.id}@${registered.version}, not ${simulator.id}@${simulator.version}`);
  }
  for (const [name, v] of [['durationMin', request.durationMin], ['paceBp', request.paceBp]] as const) {
    if (!Number.isSafeInteger(v) || v <= 0) return fail('start.invalidDuration', `${name} must be a positive safe integer`);
  }
  if (actors.length === 0) return fail('start.noActors');
  if (evalContexts.length !== actors.length) {
    return fail('start.contextMismatch', `${evalContexts.length} eval contexts for ${actors.length} actors`);
  }

  const missing: number[] = [];
  const reasons: string[] = [];
  evalContexts.forEach((ctx, i) => {
    const status = evaluateCompletion(area, world.locations, ctx, predicates);
    if (status.hasRule && !status.completed) {
      missing.push(i);
      if (status.discoveredInPool < status.requiredCount) reasons.push(`completion.discoveries:${area.id}`);
      reasons.push(...status.requiredReasons);
    }
  });
  if (missing.length > 0) {
    return fail('start.areaNotCompleted', `actors ${missing.join(', ')} have not completed ${area.id}`, [...new Set(reasons)]);
  }

  const escrow = simulator.escrow === undefined ? [] : simulator.escrow(config, actors);
  const escrowIssues = escrowProblems(escrow);
  if (escrowIssues.length > 0) return fail('start.invalidEscrow', escrowIssues.join('; '));
  const budget = simulator.budget(config, request.durationMin, request.paceBp);
  if (!Number.isSafeInteger(budget) || budget <= 0) return fail('start.invalidBudget', `budget ${String(budget)} is not a positive safe integer`);

  const check = simulator.canStart({
    config,
    actors,
    durationMin: request.durationMin,
    paceBp: request.paceBp,
    world,
    area,
    evalContexts,
    predicates,
  });
  return check.ok ? { ok: true, budget, escrow } : check;
}
