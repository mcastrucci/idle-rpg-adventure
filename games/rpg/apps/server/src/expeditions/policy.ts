/** Explicit, retained settlement contracts. Add a new entry for every released behavior; never replace an old tuple. */
import type { ExpeditionSimulator } from '@engine/expedition-kernel';
import type { LedgerDelta } from '@engine/economy';
import type { Timeline } from '@engine/expedition-kernel';
import { rpgProgressV2, settleIdleV2, summarizeIdleV2 } from '@rpg/rpg-sim';
import type { RpgIdleConfig, RpgIdleEvent, RpgIdleReport, RpgIdleState, RpgActorSnapshot, RpgIdleTuning } from '@rpg/rpg-sim';

type IdleSimulator = ExpeditionSimulator<RpgIdleConfig, RpgActorSnapshot, RpgIdleEvent, RpgIdleState, RpgIdleReport, unknown>;
const RPG_IDLE_2_0_TUNING: RpgIdleTuning = Object.freeze({ regenBetweenFightsBp: 1500, maxCombatTicks: 3000,
  deathBagLossBp: 5000, gatherSegmentsPerHour: 12, durationsMin: Object.freeze([15, 30, 60, 180]) });
export interface SettlementPolicy {
  readonly kernelVersion: string;
  readonly simulatorId: string;
  readonly simulatorVersion: string;
  readonly simulator: Pick<IdleSimulator, 'settle' | 'summarize'>;
  readonly progress: typeof rpgProgressV2;
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

function policy(simulatorId: string): SettlementPolicy {
  return Object.freeze({ kernelVersion: '0.3.0', simulatorId, simulatorVersion: 'rpg-idle@2.0.0+rpg-sim@1.1.0',
    simulator: Object.freeze({
      settle: (timeline, cutoff, reason) => settleIdleV2(RPG_IDLE_2_0_TUNING, timeline, cutoff, reason),
      summarize: (timeline, cutoff) => summarizeIdleV2(timeline, cutoff),
    }) as Pick<IdleSimulator, 'settle' | 'summarize'>,
    progress: rpgProgressV2 });
}

// This version is intentionally frozen in code and uses no current content bundle or activity definitions.
const retained = [policy('rpg.hunt'), policy('rpg.gather')];
export function findSettlementPolicy(registry: readonly SettlementPolicy[], kernelVersion: string, simulatorId: string, simulatorVersion: string): SettlementPolicy | undefined {
  return registry.find(entry => entry.kernelVersion === kernelVersion && entry.simulatorId === simulatorId && entry.simulatorVersion === simulatorVersion);
}
export const supportedSettlementPolicies = Object.freeze(retained);
