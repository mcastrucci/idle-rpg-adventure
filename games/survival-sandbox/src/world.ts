/**
 * The sandbox world: shelter hub + two city districts (content/world.json), validated by `@engine/world`, plus the
 * game's requirement predicates registered through the engine's `PredicateRegistry` plugin point.
 */
import { PredicateRegistry, createActorWorldState, validateWorld } from '@engine/world';
import type { ActorWorldStateInit, AreaId, EvalContext, World } from '@engine/world';

import worldContent from '../content/world.json' with { type: 'json' };

/** Game-specific evaluation context: what the survivors carry back at the shelter. */
export interface SurvivalGameContext {
  readonly tools: ReadonlySet<string>;
}

export const SHELTER: AreaId = 'area:shelter';
export const OLD_MARKET: AreaId = 'area:old_market';
export const RAIL_YARD: AreaId = 'area:rail_yard';
export const DISTRICTS: readonly AreaId[] = [OLD_MARKET, RAIL_YARD];

/** Tool content IDs, e.g. `tool:bolt_cutters`. */
export const TOOL_ID = /^tool:[a-z0-9_]+$/;

/**
 * Arguments of `hasTool`, parsed by a plain function: `@engine/world` accepts a parse function (or any Standard
 * Schema), so the game's predicates need no Zod at all.
 */
export function parseHasToolArgs(input: unknown): { readonly tool: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('hasTool args must be an object');
  const keys = Object.keys(input);
  const tool = (input as { tool?: unknown }).tool;
  if (keys.length !== 1 || typeof tool !== 'string' || !TOOL_ID.test(tool)) throw new TypeError('hasTool expects exactly { tool: "tool:<name>" }');
  return { tool };
}

/** Registry with the survival predicates (`hasTool`). A fresh instance per call: registries are mutable. */
export function survivalRegistry(): PredicateRegistry<SurvivalGameContext> {
  return new PredicateRegistry<SurvivalGameContext>().register('hasTool', {
    args: parseHasToolArgs,
    evaluate: ({ tool }, ctx) => ctx.game.tools.has(tool),
    reason: ({ tool }) => `requires.game.hasTool:${tool}`,
  });
}

/** Raw world content (JSON data, ADR-0008). */
export function worldInput(): unknown {
  return structuredClone(worldContent);
}

/** Parses and validates the world content; throws with every validation error if it is invalid. */
export function loadWorld(registry: PredicateRegistry<SurvivalGameContext> = survivalRegistry()): World {
  const result = validateWorld(worldInput(), registry);
  if (!result.ok) {
    throw new Error(`invalid survival world:\n${result.errors.map((e) => `  ${e.code} at ${e.path.join('.')}: ${e.message}`).join('\n')}`);
  }
  return result.world;
}

/** Builds an evaluation context from plain data. */
export function survivalContext(init: ActorWorldStateInit = {}, tools: readonly string[] = []): EvalContext<SurvivalGameContext> {
  return { actor: createActorWorldState(init), game: { tools: new Set(tools) } };
}
