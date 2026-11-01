/**
 * @engine/expedition-kernel (pure part): the `ExpeditionSimulator` plugin contract, timeline types, wall-clock
 * placement/reveal/cutoff helpers, Monte Carlo estimates and a reusable simulator contract checker (ADR-0019).
 */

/**
 * Version of the kernel's behaviour (placement rule, settle semantics, estimate seeding…). Persisted expeditions
 * record it together with the simulator's `id` and `version`; bump it on any behaviour change of this package.
 */
export const KERNEL_VERSION = '0.1.0';

export { OUTCOMES, SETTLE_REASONS } from './types.ts';
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
  timelineProblems,
  totalWeight,
} from './timeline.ts';
export { cancelCutoff, placeSegments, revealCutoff, revisionSeed, visibleView } from './placement.ts';
export type { PlacedSegment, PlacedTimeline, VisibleSegment, VisibleView } from './placement.ts';
export { estimate, estimateSeed, nearestRank } from './estimate.ts';
export type { AssetEstimate, EstimateInput, EstimateResult } from './estimate.ts';
export { checkSimulatorContract } from './contract.ts';
export type { ContractFixture, ContractOptions, ContractRule, ContractViolation } from './contract.ts';
export { stableStringify } from './stable-stringify.ts';
