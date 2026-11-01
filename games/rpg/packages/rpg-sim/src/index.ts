/**
 * @rpg/rpg-sim — server-only, deterministic RPG simulators (ADR-0003, ADR-0004): the step-based combat engine
 * (docs/spec/combat-engine.md) and the idle `ExpeditionSimulator`s `rpg.hunt` / `rpg.gather`, built on `runToEnd` and
 * `@engine/expedition-kernel` (docs/spec/idle-simulation.md).
 */
export const RPG_SIM_PACKAGE = '@rpg/rpg-sim';

export { ENGINE_VERSION } from './version.ts';
export {
  DEFAULT_COMBAT_TUNING,
  DEFAULT_MAX_TICKS,
  NO_INPUTS,
  createCombat,
  isFinished,
  runToEnd,
  step,
} from './combat/engine.ts';
export type { CombatPolicy, RunResult, StepResult } from './combat/engine.ts';
export { hashEvents } from './combat/hash.ts';
export type * from './combat/types.ts';
export * from './expedition/index.ts';
