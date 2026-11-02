/**
 * Contract fixtures over the compiled Region 1 content: one per outcome family (provisional balance; the outcome mix
 * per seed is asserted in the tests, not assumed).
 */
import type { ContractFixture } from '@engine/expedition-kernel';

import { createRpgIdleSimulators } from '../simulator.ts';
import type { RpgActorSnapshot, RpgIdleConfig } from '../types.ts';
import { GATHER, HUNT, REGION_1, bulwark, idleConfig, region1, thornblade } from './region1.ts';

export const SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => i + 1);

/** A contract fixture with its kernel-owned target (`areaId`/`activityId`, passed to every `simulate` call). */
export type IdleFixture = ContractFixture<RpgIdleConfig, RpgActorSnapshot> & {
  readonly name: string;
  readonly kind: 'hunt' | 'gather';
  readonly areaId: typeof REGION_1;
  readonly activityId: string;
};

const target = (activityId: string) => ({ areaId: REGION_1, activityId }) as const;

export function sims() {
  return createRpgIdleSimulators(region1().content);
}

export function idleFixtures(): IdleFixture[] {
  return [
    // Mostly completed: a level-4 Bulwark with potions in its own region.
    { name: 'bulwark L4 hunt 30 min, 3 potions', kind: 'hunt', config: idleConfig(3), actors: [bulwark(4)], budget: 15, seeds: SEEDS, ...target(HUNT) },
    // Mostly failed: an under-levelled Thornblade without potions.
    { name: 'thornblade L1 hunt 30 min, no potions', kind: 'hunt', config: idleConfig(0), actors: [thornblade(1)], budget: 15, seeds: SEEDS, ...target(HUNT) },
    // Mostly retreated: a level-1 Bulwark that retreats below 60 % HP once out of potions.
    {
      name: 'bulwark L1 hunt 30 min, 1 potion, retreat < 60 %',
      kind: 'hunt',
      config: idleConfig(1, { belowHpBp: 6000, onlyWhenNoHealing: true }),
      actors: [bulwark(1)],
      budget: 15,
      seeds: SEEDS,
      ...target(HUNT),
    },
    // Gathering: fewer fights, resource yields every segment.
    { name: 'bulwark L2 gather 60 min, 1 potion', kind: 'gather', config: idleConfig(1), actors: [bulwark(2)], budget: 10, seeds: SEEDS, ...target(GATHER) },
  ];
}
