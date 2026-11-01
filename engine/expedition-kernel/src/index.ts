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
 */
export const KERNEL_VERSION = '0.2.0';

export { OUTCOMES, SETTLE_REASONS, SIMULATOR_ID_PATTERN } from './types.ts';
export type {
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
export { ActivityRegistry, checkStart, unregisteredActivities } from './start.ts';
export type { ActivityRef, AnyExpeditionSimulator, CheckStartInput, StartGate, StartRequest } from './start.ts';
export { estimate, estimateSeed, nearestRank } from './estimate.ts';
export type { AssetEstimate, EstimateInput, EstimateResult } from './estimate.ts';
export { checkSimulatorContract, settlementBoundViolations } from './contract.ts';
export type { ContractFixture, ContractOptions, ContractRule, ContractViolation, SettlementMode } from './contract.ts';
export { stableStringify } from './stable-stringify.ts';
