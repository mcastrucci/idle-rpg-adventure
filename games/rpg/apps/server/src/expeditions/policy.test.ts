import { describe, expect, it } from 'vitest';

import { findSettlementPolicy, supportedSettlementPolicies } from './policy.ts';

const V2_0 = 'rpg-idle@2.0.0+rpg-sim@1.1.0';
const V2_1 = 'rpg-idle@2.1.0+rpg-sim@1.1.0';
const table = [100, 250, 450, 700, 1000];
const legacySnapshot = { participants: [], xpCurve: table };
const currentSnapshot = { participants: [], xpCurve: table, xpTailGrowthBp: 12_500 };
const progress = { actors: [], died: true, applyDeathPenalty: true, deathXpLossBp: 1_000 };

function policyFor(version: string, id = 'rpg.hunt') {
  const found = findSettlementPolicy(supportedSettlementPolicies, '0.3.0', id, version);
  if (!found) throw new Error(`missing settlement policy ${version}`);
  return found;
}

describe('retained settlement policies (ADR-0005)', () => {
  it('keeps the 2.0.0 tuples and adds distinct 2.1.0 tuples for both simulators', () => {
    for (const id of ['rpg.hunt', 'rpg.gather']) {
      expect(policyFor(V2_0, id)).not.toBe(policyFor(V2_1, id));
    }
    expect(supportedSettlementPolicies).toHaveLength(4);
    expect(findSettlementPolicy(supportedSettlementPolicies, '0.3.0', 'rpg.hunt', 'rpg-idle@9.9.9+rpg-sim@1.1.0')).toBeUndefined();
  });

  describe('rpg-idle@2.0.0 (frozen pre-#129 rules)', () => {
    const { xp } = policyFor(V2_0);

    it('reads snapshots that have no tail, converting the persisted pair with the default tail', () => {
      expect(xp.curve(legacySnapshot)).toEqual({ xpToNext: table, tailGrowthBp: 12_500 });
      expect(xp.curve(currentSnapshot)).toEqual({ xpToNext: table, tailGrowthBp: 12_500 });
    });

    it('applies 10% of the next level requirement, with the last table entry as the reference at and above the old cap', () => {
      const curve = xp.curve(legacySnapshot);
      expect(xp.deathLoss(400, curve, progress)).toEqual({ totalXp: 355, xpLost: 45, lossBp: 1_000 }); // level 3: 10% of 450
      expect(xp.deathLoss(120, curve, progress)).toEqual({ totalXp: 95, xpLost: 25, lossBp: 1_000 }); // level 2: 10% of 250
      expect(xp.deathLoss(2_600, curve, progress)).toEqual({ totalXp: 2_500, xpLost: 100, lossBp: 1_000 }); // old cap: 10% of 1000
      // Above the old cap the tail does not change the old rule: the reference stays 1000 even at level 8.
      expect(xp.deathLoss(6_000, curve, progress)).toEqual({ totalXp: 5_900, xpLost: 100, lossBp: 1_000 });
    });
  });

  describe('rpg-idle@2.1.0 (#129)', () => {
    const { xp } = policyFor(V2_1);

    it('requires the tail in the snapshot, so settlement never depends on deployed content', () => {
      expect(xp.curve(currentSnapshot)).toEqual({ xpToNext: table, tailGrowthBp: 12_500 });
      expect(() => xp.curve(legacySnapshot)).toThrow(/no XP tail growth/);
      expect(() => xp.curve({ ...currentSnapshot, xpTailGrowthBp: 10_000 })).toThrow();
    });

    it('applies the level-scaled share with the one-level cap and reports the rate', () => {
      const curve = xp.curve(currentSnapshot);
      expect(xp.deathLoss(400, curve, progress)).toEqual({ totalXp: 400 - 38, xpLost: 38, lossBp: 960 }); // level 3: floor(400 x 9.6%)
      expect(xp.deathLoss(120, curve, progress)).toEqual({ totalXp: 109, xpLost: 11, lossBp: 980 }); // level 2: floor(11.76)
      expect(xp.deathLoss(2_600, curve, progress)).toEqual({ totalXp: 2_600 - 234, xpLost: 234, lossBp: 900 }); // level 6: 9%
      expect(xp.deathLoss(0, curve, progress)).toEqual({ totalXp: 0, xpLost: 0, lossBp: 1_000 });
    });
  });
});
