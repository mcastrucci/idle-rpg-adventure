/**
 * Pure requirement evaluation (world-model §3). Failures carry stable reason keys for "locked because…" UI, e.g.
 * `requires.areaCompleted:area:north`.
 */
import { hasDiscovered, type EvalContext } from './actor.ts';
import { parseArgs, type PredicateRegistry } from './registry.ts';
import { isGameRequirement, type GameRequirement, type Requirement } from './schemas.ts';

export interface RequirementResult {
  readonly ok: boolean;
  /** Stable reason keys of the failing leaves (empty when `ok`). */
  readonly reasons: readonly string[];
}

const OK: RequirementResult = { ok: true, reasons: [] };

/** Splits a game requirement into its predicate name and argument object. */
export function gameArgs(req: GameRequirement): { name: string; args: Record<string, unknown> } {
  const { game, ...args } = req;
  return { name: game, args };
}

/**
 * Canonical, stable description of a requirement (used for `not` reasons and Mermaid labels).
 * Game predicates are described by name only; their arguments are game data.
 */
export function describeRequirement(req: Requirement): string {
  if (isGameRequirement(req)) return `game.${req.game}`;
  if ('all' in req) return `all(${req.all.map(describeRequirement).join(', ')})`;
  if ('any' in req) return `any(${req.any.map(describeRequirement).join(', ')})`;
  if ('not' in req) return `not(${describeRequirement(req.not)})`;
  if ('discovered' in req) return `discovered:${req.discovered}`;
  if ('areaCompleted' in req) return `areaCompleted:${req.areaCompleted}`;
  if ('flag' in req) return `flag:${req.flag}`;
  return `hasItem:${req.hasItem.item}:${req.hasItem.qty}`;
}

/** Evaluates `req` against `ctx`. Unknown game predicates or invalid arguments fail closed. */
export function evaluateRequirement<G>(
  req: Requirement,
  ctx: EvalContext<G>,
  registry: PredicateRegistry<G>,
): RequirementResult {
  if (isGameRequirement(req)) {
    const { name, args } = gameArgs(req);
    const def = registry.get(name);
    if (!def) return fail(`requires.unknownPredicate:${name}`);
    const parsed = parseArgs(def.args, args);
    if (!parsed.ok) return fail(`requires.invalidArgs:${name}`);
    if (def.evaluate(parsed.args, ctx)) return OK;
    return fail(def.reason?.(parsed.args) ?? `requires.game.${name}`);
  }
  if ('all' in req) {
    const reasons = req.all.flatMap((child) => evaluateRequirement(child, ctx, registry).reasons);
    return reasons.length === 0 ? OK : { ok: false, reasons: dedupe(reasons) };
  }
  if ('any' in req) {
    const results = req.any.map((child) => evaluateRequirement(child, ctx, registry));
    if (results.some((r) => r.ok)) return OK;
    return { ok: false, reasons: dedupe(results.flatMap((r) => r.reasons)) };
  }
  if ('not' in req) {
    return evaluateRequirement(req.not, ctx, registry).ok ? fail(`requires.not:${describeRequirement(req.not)}`) : OK;
  }
  const { actor } = ctx;
  if ('discovered' in req) {
    return hasDiscovered(actor, req.discovered) ? OK : fail(`requires.discovered:${req.discovered}`);
  }
  if ('areaCompleted' in req) {
    return actor.completedAreas.has(req.areaCompleted) ? OK : fail(`requires.areaCompleted:${req.areaCompleted}`);
  }
  if ('flag' in req) {
    return actor.flags.has(req.flag) ? OK : fail(`requires.flag:${req.flag}`);
  }
  const { item, qty } = req.hasItem;
  return actor.itemQty(item) >= qty ? OK : fail(`requires.hasItem:${item}:${qty}`);
}

/** Evaluates an optional requirement; absent means satisfied. */
export function evaluateOptional<G>(
  req: Requirement | undefined,
  ctx: EvalContext<G>,
  registry: PredicateRegistry<G>,
): RequirementResult {
  return req === undefined ? OK : evaluateRequirement(req, ctx, registry);
}

/** Visits every node of a requirement tree, depth first, with its path relative to the root. */
export function walkRequirement(
  req: Requirement,
  visit: (node: Requirement, path: readonly (string | number)[]) => void,
  path: readonly (string | number)[] = [],
): void {
  visit(req, path);
  if (isGameRequirement(req)) return;
  if ('all' in req) req.all.forEach((child, i) => walkRequirement(child, visit, [...path, 'all', i]));
  else if ('any' in req) req.any.forEach((child, i) => walkRequirement(child, visit, [...path, 'any', i]));
  else if ('not' in req) walkRequirement(req.not, visit, [...path, 'not']);
}

function fail(reason: string): RequirementResult {
  return { ok: false, reasons: [reason] };
}

function dedupe(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}
