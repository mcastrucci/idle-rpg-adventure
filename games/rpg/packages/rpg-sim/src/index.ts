/**
 * @rpg/rpg-sim — server-only, deterministic RPG simulators (ADR-0003, ADR-0004). Currently the step-based combat
 * engine (docs/spec/combat-engine.md); the idle `ExpeditionSimulator` builds on `runToEnd` later (M6).
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
