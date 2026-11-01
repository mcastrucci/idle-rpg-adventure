/**
 * RPG requirement predicates for `@engine/world` (world-model §3): `{ "game": "defeated", "enemy": … }` and
 * `{ "game": "levelAtLeast", "level": … }`.
 */
import { PredicateRegistry } from '@engine/world';
import { z } from 'zod';

import { EnemyIdSchema } from './ids.ts';

/** Game state the RPG predicates read (`EvalContext.game`). The server builds it from character state. */
export interface RpgGameContext {
  readonly defeatedEnemies: ReadonlySet<string>;
  readonly level: number;
}

export const DefeatedArgsSchema = z.strictObject({ enemy: EnemyIdSchema });
export const LevelAtLeastArgsSchema = z.strictObject({ level: z.int().positive() });

/** Argument schemas of every RPG predicate, keyed by predicate name. */
export const RPG_PREDICATE_ARGS = {
  defeated: DefeatedArgsSchema,
  levelAtLeast: LevelAtLeastArgsSchema,
} as const;

export function createRpgPredicateRegistry(): PredicateRegistry<RpgGameContext> {
  return new PredicateRegistry<RpgGameContext>()
    .register('defeated', {
      args: DefeatedArgsSchema,
      evaluate: ({ enemy }, ctx) => ctx.game.defeatedEnemies.has(enemy),
      reason: ({ enemy }) => `requires.game.defeated:${enemy}`,
    })
    .register('levelAtLeast', {
      args: LevelAtLeastArgsSchema,
      evaluate: ({ level }, ctx) => ctx.game.level >= level,
      reason: ({ level }) => `requires.game.levelAtLeast:${level}`,
    });
}
