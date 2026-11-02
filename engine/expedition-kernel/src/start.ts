/**
 * Area/activity gating at expedition start (docs/engine/expedition-kernel.md §2.1): which simulator an area's
 * activity runs, and the engine's own start checks before the simulator's `canStart`.
 */

import type { LedgerDelta } from '@engine/economy';
import { NAMESPACED_ID_PATTERN, evaluateCompletion } from '@engine/world';
import type { EvalContext, PredicateRegistry, World } from '@engine/world';

import { escrowProblems } from './escrow.ts';
import { SIMULATOR_ID_PATTERN } from './types.ts';
import type { ActivityRef, ExpeditionSimulator, StartCheck } from './types.ts';

export type { ActivityRef } from './types.ts';

/** A simulator of any game, as stored in an {@link ActivityRegistry}. */
export type AnyExpeditionSimulator = ExpeditionSimulator<unknown, unknown, unknown, unknown, unknown, unknown>;

/**
 * Start request (the client command carries this plus the raw game config). `areaId`, `activityId`, `durationMin` and
 * `paceBp` are **kernel-owned** (gating, placement, budget, simulation); game configs must not duplicate them.
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
  /**
   * The **raw**, untrusted game config of the start command (v0.3). `checkStart` parses it with
   * `simulator.parseConfig` before anything else uses it and returns the parsed config on success. (An already parsed
   * config works too: the contract checker requires `parseConfig` to round-trip.)
   */
  readonly rawConfig: unknown;
  readonly actors: readonly Snapshot[];
  /** One evaluation context per actor, aligned with `actors` (completion is per actor). */
  readonly evalContexts: readonly EvalContext<Game>[];
  readonly predicates: PredicateRegistry<Game>;
}

/** {@link checkStart} result: on success, the parsed config, the planned budget and the validated escrow to apply. */
export type StartGate<Config = unknown> =
  | { readonly ok: true; readonly config: Config; readonly budget: number; readonly escrow: readonly LedgerDelta[] }
  | Extract<StartCheck, { ok: false }>;

/** Stable failure codes of {@link checkStart}, in gate order (a simulator refusal keeps its own code). */
export const START_CODES = [
  'start.unknownArea',
  'start.activityNotInArea',
  'start.unknownActivity',
  'start.simulatorMismatch',
  'start.invalidDuration',
  'start.noActors',
  'start.contextMismatch',
  'start.areaNotCompleted',
  'start.invalidConfig',
  'start.simulatorError',
  'start.invalidEscrow',
  'start.invalidBudget',
] as const;
export type StartCode = (typeof START_CODES)[number];

type StartFailure = Extract<StartCheck, { ok: false }>;

function fail(code: StartCode, message?: string, reasons?: readonly string[]): StartFailure {
  return { ok: false, code, ...(message === undefined ? {} : { message }), ...(reasons === undefined ? {} : { reasons }) };
}

/** Runs `fn`; a throw becomes `{ threw: message }`. */
function guarded<T>(fn: () => T): { readonly value: T } | { readonly threw: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

function isStartCheck(v: unknown): v is StartCheck {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r['ok'] === true || (r['ok'] === false && typeof r['code'] === 'string' && r['code'] !== '');
}

/**
 * The engine's start checks, in order (first failure wins; codes are stable, see {@link START_CODES}):
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
 * 7. `start.invalidConfig` — `simulator.parseConfig(rawConfig)` threw (v0.3: the config is parsed before anything
 *    uses it);
 * 8. `simulator.canStart` with the parsed config, the request's area/activity/duration/pace, the world, the area, the
 *    eval contexts and the predicate registry; its refusal is returned as-is; a throw or a malformed result is
 *    `start.simulatorError`;
 * 9. `start.invalidEscrow` — `simulator.escrow` threw or returned malformed deltas;
 * 10. `start.invalidBudget` — `simulator.budget(config, durationMin, paceBp, { areaId, activityId })` threw or is not a
 *    positive safe integer.
 *
 * Never throws because of the simulator (v0.3): every simulator call is guarded and mapped to a `start.*` code whose
 * `message` carries the error. Pure: it reads only its input. Locks, activity CAS and the ledger are the caller's job.
 */
export function checkStart<Config, Snapshot, Game>(input: CheckStartInput<Config, Snapshot, Game>): StartGate<Config> {
  const { world, request, simulator, actors, evalContexts, predicates } = input;
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

  const parsed = guarded(() => simulator.parseConfig(input.rawConfig));
  if ('threw' in parsed) return fail('start.invalidConfig', parsed.threw);
  const config = parsed.value;

  const target: ActivityRef = { areaId: request.areaId, activityId: request.activityId };
  const check = guarded(() =>
    simulator.canStart({
      config,
      actors,
      durationMin: request.durationMin,
      paceBp: request.paceBp,
      areaId: target.areaId,
      activityId: target.activityId,
      world,
      area,
      evalContexts,
      predicates,
    }),
  );
  if ('threw' in check) return fail('start.simulatorError', `canStart threw: ${check.threw}`);
  if (!isStartCheck(check.value)) return fail('start.simulatorError', 'canStart returned a malformed result');
  if (!check.value.ok) return check.value;

  const escrow = guarded(() => (simulator.escrow === undefined ? [] : simulator.escrow(config, actors)));
  if ('threw' in escrow) return fail('start.invalidEscrow', `escrow threw: ${escrow.threw}`);
  const escrowIssues = escrowProblems(escrow.value);
  if (escrowIssues.length > 0) return fail('start.invalidEscrow', escrowIssues.join('; '));

  const budget = guarded(() => simulator.budget(config, request.durationMin, request.paceBp, target));
  if ('threw' in budget) return fail('start.invalidBudget', `budget threw: ${budget.threw}`);
  if (!Number.isSafeInteger(budget.value) || budget.value <= 0) {
    return fail('start.invalidBudget', `budget ${String(budget.value)} is not a positive safe integer`);
  }
  return { ok: true, config, budget: budget.value, escrow: escrow.value };
}
