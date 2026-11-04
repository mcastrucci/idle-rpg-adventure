/** Explicit, retained settlement contracts. Add a new entry for every released behavior; never replace an old tuple. */
import type { ExpeditionSimulator } from '@engine/expedition-kernel';
import type { LedgerDelta } from '@engine/economy';
import type { Timeline } from '@engine/expedition-kernel';
import { rpgProgressV2, rpgProgressV2_1, settleIdleV2, summarizeIdleV2 } from '@rpg/rpg-sim';
import type { RpgIdleConfig, RpgIdleEvent, RpgIdleReport, RpgIdleState, RpgActorSnapshot, RpgIdleTuning, RpgProgress, RpgProgressV2 } from '@rpg/rpg-sim';
import { XpCurveSchema } from '@rpg/rpg-schema';
import type { XpCurve } from '@rpg/rpg-schema';
import { DEFAULT_XP_TAIL_GROWTH_BP, applyDeathXpLoss, applyXpLoss } from '@rpg/rpg-stats';
import type { SettleReason } from '@engine/expedition-kernel';

import type { ExpeditionSnapshot } from './schema.ts';

type IdleSimulator = ExpeditionSimulator<RpgIdleConfig, RpgActorSnapshot, RpgIdleEvent, RpgIdleState, RpgIdleReport, unknown>;
const RPG_IDLE_TUNING: RpgIdleTuning = Object.freeze({ regenBetweenFightsBp: 1500, maxCombatTicks: 3000,
  deathBagLossBp: 5000, gatherSegmentsPerHour: 12, durationsMin: Object.freeze([15, 30, 60, 180]) });

/** Outcome of the death XP penalty for one hero (total XP is the authoritative quantity; level/xp are derived from it). */
export interface DeathXpLoss {
  readonly totalXp: number;
  readonly xpLost: number;
  /** The rate that was applied, in basis points (shown in the terminal report). */
  readonly lossBp: number;
}

/**
 * How a settlement contract treats XP. The curve and the penalty belong to the contract the expedition started under
 * (ADR-0005): a later rule change adds a new policy, it never alters an old one.
 */
export interface XpSettlementRules {
  /** The curve used to read and write the persisted `(level, xp)` pair, from the start snapshot only. */
  readonly curve: (snapshot: ExpeditionSnapshot) => XpCurve;
  /** The death penalty on `totalXp` (already including the XP earned on the expedition). */
  readonly deathLoss: (totalXp: number, curve: XpCurve, progress: RpgProgress) => DeathXpLoss;
}

export interface SettlementPolicy {
  readonly kernelVersion: string;
  readonly simulatorId: string;
  readonly simulatorVersion: string;
  readonly simulator: Pick<IdleSimulator, 'settle' | 'summarize'>;
  readonly progress: (timeline: Timeline<RpgIdleEvent, RpgIdleState>, cutoff: number, reason: SettleReason) => RpgProgress;
  readonly xp: XpSettlementRules;
}

/** Rebuilds only the stable kernel settlement contract; escrow comes from persisted start data verbatim. */
export function settlementSimulator(policy: SettlementPolicy, escrow: readonly LedgerDelta[]): IdleSimulator {
  return {
    id: policy.simulatorId, version: policy.simulatorVersion,
    parseConfig: input => input as RpgIdleConfig,
    canStart: () => ({ ok: true }),
    escrow: () => escrow.map(delta => ({ ...delta })),
    budget: () => 1,
    simulate: (): Timeline<RpgIdleEvent, RpgIdleState> => { throw new Error('settlement adapter cannot simulate'); },
    settle: (timeline, cutoff, reason) => policy.simulator.settle(timeline, cutoff, reason),
    summarize: (timeline, cutoff) => policy.simulator.summarize(timeline, cutoff),
  };
}

const settlement = Object.freeze({
  // Bag settlement and summaries are unchanged between rpg-idle@2.0.0 and 2.1.0.
  settle: (timeline, cutoff, reason) => settleIdleV2(RPG_IDLE_TUNING, timeline, cutoff, reason),
  summarize: (timeline, cutoff) => summarizeIdleV2(timeline, cutoff),
}) as Pick<IdleSimulator, 'settle' | 'summarize'>;

/**
 * rpg-idle@2.0.0 (frozen): the pre-#129 rules. The persisted curve was capped at the authored table; the penalty is 10%
 * of the XP required for the next level (`applyXpLoss` on the capped table, where the last entry is the reference at and
 * above the old cap), so in-flight expeditions settle exactly the loss they were started with.
 *
 * The persisted `(level, xp)` of the character, however, is read and written with the open-ended curve (the snapshot has
 * no tail: `DEFAULT_XP_TAIL_GROWTH_BP`). Only the representation differs from the capped era: total XP is identical, and
 * XP above the old cap now becomes levels instead of piling up inside level 6.
 */
const XP_RULES_2_0: XpSettlementRules = Object.freeze<XpSettlementRules>({
  curve: snapshot => XpCurveSchema.parse({ xpToNext: snapshot.xpCurve, tailGrowthBp: snapshot.xpTailGrowthBp ?? DEFAULT_XP_TAIL_GROWTH_BP }),
  deathLoss: (totalXp, curve, progress) => {
    const lossBp = (progress as RpgProgressV2).deathXpLossBp;
    const loss = applyXpLoss(totalXp, lossBp, { xpToNext: curve.xpToNext });
    return { totalXp: loss.totalXp, xpLost: loss.xpLost, lossBp };
  },
});

/** rpg-idle@2.1.0 (#129): open-ended curve persisted with the snapshot, level-scaled death penalty. */
const XP_RULES_2_1: XpSettlementRules = Object.freeze<XpSettlementRules>({
  curve: snapshot => {
    if (snapshot.xpTailGrowthBp === undefined) throw new Error('expedition snapshot has no XP tail growth');
    return XpCurveSchema.parse({ xpToNext: snapshot.xpCurve, tailGrowthBp: snapshot.xpTailGrowthBp });
  },
  deathLoss: (totalXp, curve) => {
    const { totalXp: after, xpLost, lossBp } = applyDeathXpLoss(totalXp, curve);
    return { totalXp: after, xpLost, lossBp };
  },
});

function policy(simulatorId: string, simulatorVersion: string, progress: SettlementPolicy['progress'], xp: XpSettlementRules): SettlementPolicy {
  return Object.freeze({ kernelVersion: '0.3.0', simulatorId, simulatorVersion, simulator: settlement, progress, xp });
}

const V2_0 = 'rpg-idle@2.0.0+rpg-sim@1.1.0';
const V2_1 = 'rpg-idle@2.1.0+rpg-sim@1.1.0';

// These versions are intentionally frozen in code and use no current content bundle or activity definitions.
const retained = [
  policy('rpg.hunt', V2_0, rpgProgressV2, XP_RULES_2_0), policy('rpg.gather', V2_0, rpgProgressV2, XP_RULES_2_0),
  policy('rpg.hunt', V2_1, rpgProgressV2_1, XP_RULES_2_1), policy('rpg.gather', V2_1, rpgProgressV2_1, XP_RULES_2_1),
];
export function findSettlementPolicy(registry: readonly SettlementPolicy[], kernelVersion: string, simulatorId: string, simulatorVersion: string): SettlementPolicy | undefined {
  return registry.find(entry => entry.kernelVersion === kernelVersion && entry.simulatorId === simulatorId && entry.simulatorVersion === simulatorVersion);
}
export const supportedSettlementPolicies = Object.freeze(retained);
