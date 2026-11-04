/**
 * RPG idle expedition simulators (`rpg.hunt`, `rpg.gather`) on `@engine/expedition-kernel` v0.3 (#76, #77).
 */
export { IDLE_KINDS, MAX_IDLE_CONSUMABLE_QTY, idleActivityFor, idleKindOf, parseRpgIdleConfig } from './config.ts';
export type { IdleKind } from './config.ts';
export { consumableOf, isHealingConsumable, rpgIdleContentFromBundle } from './content.ts';
export type { ContentBundleLike, RpgIdleContent } from './content.ts';
export { ESCROW, GOLD, GOLD_CURRENCY, INVENTORY, isGrant, itemAsset, mergeDeltas, stack } from './deltas.ts';
export { rollLoot } from './loot.ts';
export type { LootDrop, LootRoll } from './loot.ts';
export { applyBagLoss, bagTotals, coversDeath, rpgIdleMetrics, rpgProgress, settleIdle, summarizeIdle } from './settle.ts';
/** Retained behavior for persisted RPG idle simulator version 2.0.0. Never edit; append a new version module instead. */
export { applyBagLossV2, coversDeathV2, rpgIdleMetricsV2, rpgProgressV2, settleIdleV2, summarizeIdleV2 } from './settlement-v2.ts';
/** Retained behavior for persisted RPG idle simulator version 2.1.0 (#129; bag/summary/metrics are those of 2.0.0). */
export { rpgProgressV2_1 } from './settlement-v2-1.ts';
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
