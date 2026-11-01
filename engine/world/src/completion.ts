/**
 * Generic area completion (ADR-0018): `|discovered ∩ pool| ≥ requiredCount` and the `required` requirement holds.
 * Games configure it per area (e.g. a discovery threshold plus a game objective).
 */
import { discoveredIn, type EvalContext } from './actor.ts';
import type { PredicateRegistry } from './registry.ts';
import { evaluateOptional } from './requirements.ts';
import { BP_SCALE, type Area, type CompletionRule, type Location, type LocationId } from './schemas.ts';

export interface CompletionStatus {
  /** Whether the area has a completion rule at all. */
  readonly hasRule: boolean;
  /** Recorded completion (permanent) or the rule currently satisfied. */
  readonly completed: boolean;
  /** Completion already recorded for the actor (`completed_at` set). */
  readonly recorded: boolean;
  /** Discovered locations that belong to the current pool. */
  readonly discoveredInPool: number;
  /** Discoveries needed (frozen baseline when present). */
  readonly requiredCount: number;
  /** Pool size (frozen baseline when present). */
  readonly poolSize: number;
  /** Whether `rule.required` holds (true when absent). */
  readonly requiredMet: boolean;
  /** Reason keys of the failing `required` requirement. */
  readonly requiredReasons: readonly string[];
}

/** `ceil(poolSize * thresholdBp / 10000)` in integer arithmetic. */
export function requiredCountFor(poolSize: number, thresholdBp: number): number {
  const scaled = poolSize * thresholdBp;
  const remainder = scaled % BP_SCALE;
  return (scaled - remainder) / BP_SCALE + (remainder > 0 ? 1 : 0);
}

/** IDs of the area's locations carrying the pool tag, in area order. */
export function poolLocations(area: Area, rule: CompletionRule, locations: readonly Location[]): LocationId[] {
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  return area.locations.filter((id) => byId.get(id)?.tags.includes(rule.pool.tag) ?? false);
}

/** Pool size and required count, honouring the frozen baseline. */
export function completionBaseline(
  rule: CompletionRule,
  livePoolSize: number,
): { poolSize: number; requiredCount: number } {
  if (rule.frozen) return { poolSize: rule.frozen.poolSize, requiredCount: rule.frozen.requiredCount };
  return { poolSize: livePoolSize, requiredCount: requiredCountFor(livePoolSize, rule.thresholdBp) };
}

/**
 * Evaluates the completion of `area` for the actor in `ctx`. `locations` may be the whole world's locations or just the
 * area's; only those listed by `area.locations` are considered.
 */
export function evaluateCompletion<G>(
  area: Area,
  locations: readonly Location[],
  ctx: EvalContext<G>,
  registry: PredicateRegistry<G>,
): CompletionStatus {
  const recorded = ctx.actor.completedAreas.has(area.id);
  const rule = area.completion;
  if (!rule) {
    return {
      hasRule: false,
      completed: recorded,
      recorded,
      discoveredInPool: 0,
      requiredCount: 0,
      poolSize: 0,
      requiredMet: true,
      requiredReasons: [],
    };
  }
  const pool = poolLocations(area, rule, locations);
  const discovered = discoveredIn(ctx.actor, area.id);
  const discoveredInPool = pool.filter((id) => discovered.has(id)).length;
  const { poolSize, requiredCount } = completionBaseline(rule, pool.length);
  const required = evaluateOptional(rule.required, ctx, registry);
  return {
    hasRule: true,
    completed: recorded || (discoveredInPool >= requiredCount && required.ok),
    recorded,
    discoveredInPool,
    requiredCount,
    poolSize,
    requiredMet: required.ok,
    requiredReasons: required.reasons,
  };
}
