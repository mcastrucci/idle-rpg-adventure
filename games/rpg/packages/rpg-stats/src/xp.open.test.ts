/**
 * Open-ended XP curve and the level-scaled death XP penalty (#129; owner decisions recorded in open decisions #2 and #8).
 * `xp.test.ts` keeps covering the capped (pre-#129) curve shape and the frozen legacy `applyXpLoss`.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEATH_XP_LOSS_BP,
  DEFAULT_XP_TAIL_GROWTH_BP,
  applyDeathXpLoss,
  applyXpLoss,
  deathXpLossBp,
  levelForXp,
  terminalLevel,
  totalXpAtLevelStart,
  totalXpFromLevelProgress,
  xpProgress,
  xpToNextAtLevel,
} from './xp.ts';

// The CAPPED (pre-#129) curve. Level starts: L1 0, L2 100, L3 350, L4 800, L5 1500, L6 (cap) 2500.
const capped = { xpToNext: [100, 250, 450, 700, 1000] };
// The authored open curve: the same table plus x1.25 per level beyond it.
const open = { xpToNext: [100, 250, 450, 700, 1000], tailGrowthBp: 12_500 };
// Level starts of `open`: L6 2500, L7 3750, L8 5312, L9 7264, L10 9704, L11 12754, L12 16566.

describe('open-ended curve', () => {
  it('matches the authored content file', () => {
    const file = JSON.parse(readFileSync(new URL('../../../content/progression/xp-curve.json', import.meta.url), 'utf8')) as
      { xpToNext: number[]; tailGrowthBp: number };
    expect({ xpToNext: file.xpToNext, tailGrowthBp: file.tailGrowthBp }).toEqual(open);
    expect(DEFAULT_XP_TAIL_GROWTH_BP).toBe(file.tailGrowthBp);
  });

  it('keeps the authored table and grows the tail by floor(prev x 12500 / 10000)', () => {
    const needs = Array.from({ length: 12 }, (_, i) => xpToNextAtLevel(i + 1, open));
    expect(needs.slice(0, 5)).toEqual([100, 250, 450, 700, 1000]);
    expect(needs.slice(5, 9)).toEqual([1250, 1562, 1952, 2440]); // L6->L7 1250, L7->L8 1562, L8->L9 1952
    expect(needs.slice(9)).toEqual([3050, 3812, 4765]);
  });

  it('has no level cap: level 6 -> 7 -> 8 -> 9 and beyond', () => {
    expect(xpProgress(2500, open)).toEqual({ level: 6, totalXp: 2500, xpIntoLevel: 0, xpToNext: 1250, progressBp: 0, isMaxLevel: false });
    expect(levelForXp(3749, open)).toBe(6);
    expect(levelForXp(3750, open)).toBe(7);
    expect(levelForXp(5311, open)).toBe(7);
    expect(levelForXp(5312, open)).toBe(8);
    expect(levelForXp(7264, open)).toBe(9);
    expect(totalXpAtLevelStart(9, open)).toBe(7264);
    expect(xpProgress(4000, open)).toMatchObject({ level: 7, xpIntoLevel: 250, xpToNext: 1562, progressBp: 1600, isMaxLevel: false });
  });

  it('is identical to the capped curve below level 6 (existing characters keep level and XP)', () => {
    for (let total = 0; total < 2500; total += 7) {
      expect(xpProgress(total, open)).toEqual(xpProgress(total, capped));
    }
    for (let level = 1; level <= 5; level++) {
      for (const into of [0, 1, 99]) {
        if (into >= (xpToNextAtLevel(level, open) as number)) continue;
        const total = totalXpFromLevelProgress(level, into, capped);
        expect(totalXpFromLevelProgress(level, into, open)).toBe(total);
        const p = xpProgress(total, open);
        expect([p.level, p.xpIntoLevel]).toEqual([level, into]);
      }
    }
    // A level-6 character below the first tail requirement keeps its (6, xp) pair too.
    expect(totalXpFromLevelProgress(6, 1000, open)).toBe(3500);
    expect(xpProgress(3500, open)).toMatchObject({ level: 6, xpIntoLevel: 1000 });
  });

  it('round-trips (level, xp within level) and boundaries at high levels', () => {
    const top = terminalLevel(open);
    expect(top).toBeGreaterThan(100);
    for (const level of [1, 6, 7, 8, 20, 50, 100, top - 1, top]) {
      const need = xpToNextAtLevel(level, open);
      for (const into of need === null ? [0, 5] : [0, 1, need - 1]) {
        const total = totalXpFromLevelProgress(level, into, open);
        const p = xpProgress(total, open);
        expect([p.level, p.xpIntoLevel, p.totalXp]).toEqual([level, into, total]);
        expect(levelForXp(total, open)).toBe(level);
      }
    }
    for (let level = 2; level <= top; level++) {
      const start = totalXpAtLevelStart(level, open);
      expect(levelForXp(start, open)).toBe(level);
      expect(levelForXp(start - 1, open)).toBe(level - 1);
    }
  });

  it('rejects a stored pair that reaches the next level (also past level 6)', () => {
    expect(() => totalXpFromLevelProgress(6, 1250, open)).toThrow(/next level/);
    expect(() => totalXpFromLevelProgress(7, 1562, open)).toThrow(/next level/);
    expect(totalXpFromLevelProgress(7, 1561, open)).toBe(3750 + 1561);
  });

  it('is deterministic', () => {
    const run = (curve: typeof open) => JSON.stringify([xpProgress(123_456_789, curve), applyDeathXpLoss(123_456_789, curve), terminalLevel(curve)]);
    expect(run(open)).toBe(run({ ...open }));
  });

  describe('overflow (safe-integer bound)', () => {
    it('stops at a terminal level whose next threshold would not be a safe integer', () => {
      const top = terminalLevel(open);
      const start = totalXpAtLevelStart(top, open);
      expect(Number.isSafeInteger(start)).toBe(true);
      expect(xpToNextAtLevel(top, open)).toBeNull();
      const nextRequirement = (BigInt(xpToNextAtLevel(top - 1, open) as number) * 12_500n) / 10_000n;
      expect(BigInt(start) + nextRequirement > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(() => totalXpAtLevelStart(top + 1, open)).toThrow(/level must be in/);
      expect(() => xpToNextAtLevel(top + 1, open)).toThrow(/level must be in/);
    });

    it('treats the terminal level like a cap: the largest safe total XP is a valid, deterministic level', () => {
      const top = terminalLevel(open);
      const p = xpProgress(Number.MAX_SAFE_INTEGER, open);
      expect(p).toMatchObject({ level: top, xpToNext: null, progressBp: 10_000, isMaxLevel: true });
      expect(p.xpIntoLevel).toBe(Number.MAX_SAFE_INTEGER - totalXpAtLevelStart(top, open));
      expect(totalXpFromLevelProgress(top, p.xpIntoLevel, open)).toBe(Number.MAX_SAFE_INTEGER);
      // Overflowing sums throw instead of silently losing precision.
      expect(() => totalXpFromLevelProgress(top, Number.MAX_SAFE_INTEGER, open)).toThrow(/safe integer/);
      expect(() => levelForXp(Number.MAX_SAFE_INTEGER + 1, open)).toThrow(/safe integer/);
    });

    it('applies the death loss at the terminal level without losing precision', () => {
      const top = terminalLevel(open);
      const loss = applyDeathXpLoss(Number.MAX_SAFE_INTEGER, open);
      const lost = Number((BigInt(Number.MAX_SAFE_INTEGER) * 200n) / 10_000n);
      expect(loss.levelBefore).toBe(top);
      expect(loss.lossBp).toBe(200);
      expect(loss.totalXp).toBe(Math.max(Number.MAX_SAFE_INTEGER - lost, totalXpAtLevelStart(top - 1, open)));
      expect(loss.xpLost).toBe(Number.MAX_SAFE_INTEGER - loss.totalXp);
    });

    it('handles huge authored entries and an overflowing tail product', () => {
      const big = 4_503_599_627_370_000;
      const doubling = { xpToNext: [big], tailGrowthBp: 20_000 };
      expect(terminalLevel(doubling)).toBe(2); // level 3 would start beyond MAX_SAFE_INTEGER
      expect(xpToNextAtLevel(1, doubling)).toBe(big);
      expect(xpToNextAtLevel(2, doubling)).toBeNull();
      expect(terminalLevel({ xpToNext: [4_000_000_000_000_000], tailGrowthBp: 100_000 })).toBe(2); // 4e15 x 10 > 2^53
    });

    it('rejects a tail that does not grow', () => {
      expect(() => terminalLevel({ xpToNext: [1000], tailGrowthBp: 10_000 })).toThrow(/does not grow/);
    });
  });
});

describe('deathXpLossBp', () => {
  it.each([
    [1, 1000],
    [2, 980],
    [6, 900],
    [11, 800],
    [26, 500],
    [40, 220],
    [41, 200],
    [42, 200],
    [100, 200],
    [10_000, 200],
    [Number.MAX_SAFE_INTEGER, 200],
  ])('level %i -> %i bp', (level, bp) => {
    expect(deathXpLossBp(level)).toBe(bp);
  });

  it('matches the owner formula max(200, 1000 - 20 x (L - 1)) for every level up to 200', () => {
    for (let level = 1; level <= 200; level++) expect(deathXpLossBp(level)).toBe(Math.max(200, 1000 - 20 * (level - 1)));
  });

  it('rejects invalid levels', () => {
    expect(() => deathXpLossBp(0)).toThrow(/level/);
    expect(() => deathXpLossBp(1.5)).toThrow(/level/);
  });
});

describe('applyDeathXpLoss (level-scaled share of total XP, one-level cap)', () => {
  it('L1 loses 10% of total XP, floored, and never goes below 0', () => {
    expect(applyDeathXpLoss(99, open)).toEqual({ totalXp: 90, xpLost: 9, lossBp: 1000, levelBefore: 1, level: 1, levelsLost: 0 });
    expect(applyDeathXpLoss(9, open)).toEqual({ totalXp: 9, xpLost: 0, lossBp: 1000, levelBefore: 1, level: 1, levelsLost: 0 }); // floor(0.9)
    expect(applyDeathXpLoss(0, open)).toEqual({ totalXp: 0, xpLost: 0, lossBp: 1000, levelBefore: 1, level: 1, levelsLost: 0 });
  });

  it('L2 loses 9.8% and can de-level to level 1 (the floor is the start of level 1 = 0)', () => {
    expect(applyDeathXpLoss(100, open)).toEqual({ totalXp: 91, xpLost: 9, lossBp: 980, levelBefore: 2, level: 1, levelsLost: 1 });
    expect(applyDeathXpLoss(349, open)).toMatchObject({ totalXp: 349 - 34, xpLost: 34, lossBp: 980, level: 2, levelsLost: 0 });
  });

  it('L11 loses 8% of its total XP', () => {
    expect(totalXpAtLevelStart(11, open)).toBe(12_754);
    expect(totalXpAtLevelStart(10, open)).toBe(9_704);
    const total = 12_754 + 100; // floor(12854 x 800 / 10000) = floor(1028.32) = 1028
    expect(applyDeathXpLoss(total, open)).toEqual({ totalXp: 11_826, xpLost: 1028, lossBp: 800, levelBefore: 11, level: 10, levelsLost: 1 });
  });

  it('L41 and L100 use the 2% floor rate', () => {
    for (const level of [41, 100]) {
      const total = totalXpAtLevelStart(level, open) + 12_345;
      const r = applyDeathXpLoss(total, open);
      expect(r.levelBefore).toBe(level);
      expect(r.lossBp).toBe(200);
      expect(r.xpLost).toBe(Number((BigInt(total) * 200n) / 10_000n));
      expect(r.totalXp).toBe(total - r.xpLost);
      expect(r.level).toBeGreaterThanOrEqual(level - 1);
    }
  });

  it('one-level cap: total XP never falls below the start of level L - 1', () => {
    // Level 7 start = 3750; L7 rate = 880 bp: floor(3750 x 0.088) = 330 -> 3420 (level 6 starts at 2500).
    expect(applyDeathXpLoss(3750, open)).toEqual({ totalXp: 3420, xpLost: 330, lossBp: 880, levelBefore: 7, level: 6, levelsLost: 1 });
    // Table where level 2 is only 1 XP below level 3: L3 with 1001 XP would lose floor(1001 x 9.6%) = 96 -> 905 (< 1000).
    const tight = { xpToNext: [1000, 1], tailGrowthBp: 20_000 }; // L2 starts at 1000, L3 at 1001
    expect(applyDeathXpLoss(1001, tight)).toEqual({ totalXp: 1000, xpLost: 1, lossBp: 960, levelBefore: 3, level: 2, levelsLost: 1 });
  });

  it('property: at most one level lost, never negative, share never exceeded', () => {
    for (let total = 0; total <= 40_000; total += 13) {
      const r = applyDeathXpLoss(total, open);
      expect(r.levelsLost).toBeLessThanOrEqual(1);
      expect(r.levelsLost).toBeGreaterThanOrEqual(0);
      expect(r.totalXp).toBeGreaterThanOrEqual(0);
      expect(r.xpLost).toBe(total - r.totalXp);
      expect(r.xpLost).toBeLessThanOrEqual(Math.floor((total * r.lossBp) / 10_000));
      expect(r.level).toBe(levelForXp(r.totalXp, open));
    }
  });

  it('is deterministic and independent of curve object identity', () => {
    const frozen = Object.freeze({ xpToNext: Object.freeze([...open.xpToNext]), tailGrowthBp: open.tailGrowthBp });
    expect(applyDeathXpLoss(5000, frozen)).toEqual(applyDeathXpLoss(5000, open));
  });

  it('rejects invalid XP', () => {
    expect(() => applyDeathXpLoss(-1, open)).toThrow(/totalXp/);
    expect(() => applyDeathXpLoss(1.5, open)).toThrow(/totalXp/);
  });
});

describe('legacy applyXpLoss on a capped curve is frozen (rpg-idle@2.0.0 policy)', () => {
  it('keeps the exact pre-#129 numbers, including the cap reference', () => {
    expect(applyXpLoss(2550, DEFAULT_DEATH_XP_LOSS_BP, capped)).toEqual({ totalXp: 2450, xpLost: 100, levelBefore: 6, level: 5, levelsLost: 1 });
    expect(applyXpLoss(400, DEFAULT_DEATH_XP_LOSS_BP, capped)).toEqual({ totalXp: 355, xpLost: 45, levelBefore: 3, level: 3, levelsLost: 0 });
    expect(applyXpLoss(120, DEFAULT_DEATH_XP_LOSS_BP, capped)).toEqual({ totalXp: 95, xpLost: 25, levelBefore: 2, level: 1, levelsLost: 1 });
    // At or above the old cap the reference stays the last table entry (1000) even though the content now has a tail.
    expect(applyXpLoss(8000, DEFAULT_DEATH_XP_LOSS_BP, capped)).toEqual({ totalXp: 7900, xpLost: 100, levelBefore: 6, level: 6, levelsLost: 0 });
  });
});
