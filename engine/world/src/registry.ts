/**
 * Registry of game-defined requirement predicates (docs/engine/overview.md §3, plugin point `PredicateRegistry`).
 */
import type { z } from 'zod';

import type { EvalContext } from './actor.ts';
import { GAME_PREDICATE_NAME_PATTERN } from './schemas.ts';

/** A game predicate: a Zod schema for its arguments and a pure evaluator. */
export interface GamePredicateDefinition<A, G = unknown> {
  /** Schema of the arguments, i.e. the requirement object without its `game` key. Prefer `z.strictObject`. */
  readonly args: z.ZodType<A>;
  /** Pure function of actor state; must not perform I/O. */
  evaluate(args: A, ctx: EvalContext<G>): boolean;
  /** Stable reason key when the predicate fails (default `requires.game.<name>`). */
  reason?(args: A): string;
}

export type ArgsValidation = { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly issues: readonly z.core.$ZodIssue[] };

export class PredicateRegistry<G = unknown> {
  readonly #defs = new Map<string, GamePredicateDefinition<unknown, G>>();

  /** Registers a predicate. Throws on invalid or duplicate names. */
  register<A>(name: string, definition: GamePredicateDefinition<A, G>): this {
    if (!GAME_PREDICATE_NAME_PATTERN.test(name)) throw new Error(`Invalid game predicate name "${name}"`);
    if (this.#defs.has(name)) throw new Error(`Game predicate "${name}" is already registered`);
    this.#defs.set(name, definition as GamePredicateDefinition<unknown, G>);
    return this;
  }

  has(name: string): boolean {
    return this.#defs.has(name);
  }

  names(): string[] {
    return [...this.#defs.keys()].sort();
  }

  get(name: string): GamePredicateDefinition<unknown, G> | undefined {
    return this.#defs.get(name);
  }

  /** Validates the arguments of a game predicate. Unknown predicates throw: check {@link has} first. */
  validateArgs(name: string, args: unknown): ArgsValidation {
    const def = this.#defs.get(name);
    if (!def) throw new Error(`Unknown game predicate "${name}"`);
    const parsed = def.args.safeParse(args);
    return parsed.success ? { ok: true, args: parsed.data } : { ok: false, issues: parsed.error.issues };
  }
}
