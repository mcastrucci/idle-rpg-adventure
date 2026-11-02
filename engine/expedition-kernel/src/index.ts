/**
 * @engine/expedition-kernel (pure part): the `ExpeditionSimulator` plugin contract, timeline types, wall-clock
 * placement/reveal/cutoff helpers, escrow bookkeeping, area/activity start gating, Monte Carlo estimates and a reusable
 * simulator contract checker (ADR-0019).
 */

/**
 * Version of the kernel's behaviour (placement rule, settle semantics, estimate seeding…). Persisted expeditions
 * record it together with the simulator's `id` and `version`; bump it on any behaviour change of this package.
 *
 * 0.2.0: escrow in the simulator contract with automatic returns (`settleWithEscrow`), area/activity gating
 * (`ActivityRegistry`, `checkStart`), per-reason settlement modes and the default bound in the contract checker,
 * `timelineHash`, `segmentSeed`/`segmentStreams`, simulator ID pattern.
 *
 * 0.3.0: cancel-after-end guard (`resolveSettlement`, `canCancel`, `settleAt`, contract rule `cancel-after-end`);
 * kernel-owned activity target (`areaId`/`activityId` in `StartContext`, `SimulateInput`, `budget`, estimates and
 * contract fixtures); `checkStart` parses the raw config first, runs `canStart` before `escrow`/`budget` and maps
 * simulator throws to `start.*` codes; `unique_mint` assets (`@engine/economy`) cannot be escrowed; `estimate` takes
 * game metrics.
 */
export const KERNEL_VERSION = '0.3.0';

export { OUTCOMES, SETTLE_REASONS, SIMULATOR_ID_PATTERN } from './types.ts';
export type {
  ActivityRef,
  ExpeditionSimulator,
  Outcome,
  ResumeFrom,
  Segment,
  SettleReason,
  SimulateInput,
  StartCheck,
  StartContext,
  Timeline,
} from './types.ts';
export {
  assertCutoff,
  assertTimeline,
  defaultSettle,
  spliceTimeline,
  timelineHash,
  timelineProblems,
  totalWeight,
} from './timeline.ts';
export {
  cancelCutoff,
  placeSegments,
  revealCutoff,
  revisionSeed,
  segmentSeed,
  segmentStreams,
  visibleView,
} from './placement.ts';
export type { PlacedSegment, PlacedTimeline, VisibleSegment, VisibleView } from './placement.ts';
export {
  ESCROW_CONTAINER,
  assertEscrow,
  escrowProblems,
  escrowReturns,
  settleWithEscrow,
  simulatorEscrow,
} from './escrow.ts';
export type { Settlement } from './escrow.ts';
export { ActivityRegistry, START_CODES, checkStart, unregisteredActivities } from './start.ts';
export type { AnyExpeditionSimulator, CheckStartInput, StartCode, StartGate, StartRequest } from './start.ts';
export { SETTLEMENT_REQUESTS, SETTLE_NOT_ENDED, canCancel, resolveSettlement, settleAt } from './settlement.ts';
export type { SettleAtResult, SettlementRequest, SettlementResolution } from './settlement.ts';
export { estimate, estimateSeed, nearestRank } from './estimate.ts';
export type {
  AssetEstimate,
  EstimateInput,
  EstimateMetrics,
  EstimateOptions,
  EstimateResult,
  MetricEstimate,
  Percentiles,
} from './estimate.ts';
export { checkSimulatorContract, settlementBoundViolations } from './contract.ts';
export type { ContractFixture, ContractOptions, ContractRule, ContractViolation, SettlementMode } from './contract.ts';
export { stableStringify } from './stable-stringify.ts';
