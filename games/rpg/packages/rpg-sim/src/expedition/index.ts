/**
 * RPG idle expedition simulators (`rpg.hunt`, `rpg.gather`) on `@engine/expedition-kernel` v0.2 (#76).
 */
export { IDLE_KINDS, MAX_IDLE_CONSUMABLE_QTY, idleKindOf, parseRpgIdleConfig } from './config.ts';
export type { IdleKind } from './config.ts';
export { consumableOf, isHealingConsumable, rpgIdleContentFromBundle } from './content.ts';
export type { ContentBundleLike, RpgIdleContent } from './content.ts';
export { ESCROW, GOLD, GOLD_CURRENCY, INVENTORY, isGrant, mergeDeltas, stack } from './deltas.ts';
export { rollLoot } from './loot.ts';
export type { LootDrop, LootRoll } from './loot.ts';
export { applyBagLoss, bagTotals, coversDeath, rpgProgress, settleIdle, summarizeIdle } from './settle.ts';
export { DEFAULT_RPG_IDLE_TUNING, deathCauses, idleBudget, maxHpOf, segmentsPerHour, simulateIdle } from './simulate.ts';
export type { RpgIdleTuning } from './simulate.ts';
export {
  RPG_GATHER_SIMULATOR_ID,
  RPG_HUNT_SIMULATOR_ID,
  RPG_IDLE_SIMULATOR_VERSION,
  RPG_IDLE_VERSION,
  createRpgActivityRegistry,
  createRpgIdleSimulator,
  createRpgIdleSimulators,
} from './simulator.ts';
export type { RpgExpeditionSimulator, RpgIdleOptions, RpgIdleSimulators } from './simulator.ts';
export type * from './types.ts';
