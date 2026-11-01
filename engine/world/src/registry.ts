/**
 * Registry of game-defined requirement predicates (docs/engine/overview.md §3, plugin point `PredicateRegistry`).
 *
 * Predicate arguments are validated by an {@link ArgsParser}: any [Standard Schema v1](https://standardschema.dev)
 * object (Zod ≥ 3.24 / 4, Valibot, ArkType… — so games are not locked to `@engine/world`'s own Zod version) or a plain
 * parse function `(input: unknown) => A` that throws on invalid input.
 */
import type { EvalContext } from './actor.ts';
import { GAME_PREDICATE_NAME_PATTERN } from './schemas.ts';

/**
 * Minimal structural copy of the Standard Schema v1 interface (the spec is designed to be copied rather than imported;
 * see https://standardschema.dev). Only what the registry uses is declared.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** Result of a Standard Schema `validate` call. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string;
        readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
      }[];
    };

/** Plain parse function: returns the typed arguments or throws on invalid input. */
export type ArgsParseFunction<A> = (input: unknown) => A;

/** How a predicate validates its arguments: a Standard Schema (e.g. any Zod schema) or a parse function. */
export type ArgsParser<A> = StandardSchemaV1<unknown, A> | ArgsParseFunction<A>;

/** A game predicate: an argument parser and a pure evaluator. */
export interface GamePredicateDefinition<A, G = unknown> {
  /**
   * Validates the arguments, i.e. the requirement object without its `game` key: a Standard Schema (Zod schemas
   * qualify; prefer `z.strictObject`) or a parse function that throws on invalid input. Must be synchronous and pure.
   */
  readonly args: ArgsParser<A>;
  /** Pure function of actor state; must not perform I/O. */
  evaluate(args: A, ctx: EvalContext<G>): boolean;
  /** Stable reason key when the predicate fails (default `requires.game.<name>`). */
  reason?(args: A): string;
}

/** One argument validation problem (library-independent). `path` is relative to the argument object. */
export interface ArgsIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type ArgsValidation = { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly issues: readonly ArgsIssue[] };

function isStandardSchema(parser: unknown): parser is StandardSchemaV1<unknown, unknown> {
  if ((typeof parser !== 'object' && typeof parser !== 'function') || parser === null) return false;
  const std = (parser as { '~standard'?: unknown })['~standard'];
  return typeof std === 'object' && std !== null && typeof (std as { validate?: unknown }).validate === 'function';
}

/**
 * Runs an {@link ArgsParser} on `input`. Standard Schemas are preferred when an object is both (Zod schemas are
 * objects with `~standard`); asynchronous validation is rejected (requirements are evaluated synchronously).
 */
export function parseArgs<A>(parser: ArgsParser<A>, input: unknown): { ok: true; args: A } | { ok: false; issues: ArgsIssue[] } {
  if (isStandardSchema(parser)) {
    const result = parser['~standard'].validate(input);
    if (result instanceof Promise) {
      result.catch(() => undefined); // never leave a rejected promise unhandled
      return { ok: false, issues: [{ message: 'asynchronous argument validation is not supported', path: [] }] };
    }
    if (result.issues !== undefined) {
      return {
        ok: false,
        issues: result.issues.map((issue) => ({
          message: issue.message,
          path: (issue.path ?? []).map((seg) => (typeof seg === 'object' && seg !== null ? seg.key : seg)),
        })),
      };
    }
    return { ok: true, args: result.value };
  }
  if (typeof parser === 'function') {
    try {
      return { ok: true, args: parser(input) };
    } catch (e) {
      return { ok: false, issues: [{ message: e instanceof Error ? e.message : String(e), path: [] }] };
    }
  }
  return { ok: false, issues: [{ message: 'predicate args parser is neither a Standard Schema nor a function', path: [] }] };
}

export class PredicateRegistry<G = unknown> {
  readonly #defs = new Map<string, GamePredicateDefinition<unknown, G>>();

  /** Registers a predicate. Throws on invalid or duplicate names, or when `args` is not a supported parser. */
  register<A>(name: string, definition: GamePredicateDefinition<A, G>): this {
    if (!GAME_PREDICATE_NAME_PATTERN.test(name)) throw new Error(`Invalid game predicate name "${name}"`);
    if (this.#defs.has(name)) throw new Error(`Game predicate "${name}" is already registered`);
    if (!isStandardSchema(definition.args) && typeof definition.args !== 'function') {
      throw new TypeError(`Game predicate "${name}": args must be a Standard Schema (e.g. a Zod schema) or a parse function`);
    }
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
    return parseArgs(def.args, args);
  }
}
