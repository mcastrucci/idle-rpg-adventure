import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEATH_XP_LOSS_BP,
  applyXpLoss,
  levelForXp,
  totalXpAtLevelStart,
  totalXpFromLevelProgress,
  xpProgress,
} from './xp.ts';

// Level starts: L1 0, L2 100, L3 350, L4 800, L5 1500, L6 (cap) 2500.
const curve = { xpToNext: [100, 250, 450, 700, 1000] };

describe('levelForXp', () => {
  it.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [349, 2],
    [350, 3],
    [799, 3],
    [800, 4],
    [1499, 4],
    [1500, 5],
    [2499, 5],
    [2500, 6],
    [999_999, 6],
  ])('%i XP → level %i', (xp, level) => {
    expect(levelForXp(xp, curve)).toBe(level);
  });

  it('agrees with totalXpAtLevelStart at every boundary', () => {
    for (let level = 1; level <= 6; level++) {
      const start = totalXpAtLevelStart(level, curve);
      expect(levelForXp(start, curve)).toBe(level);
      if (start > 0) expect(levelForXp(start - 1, curve)).toBe(level - 1);
    }
  });

  it('rejects negative and fractional XP', () => {
    expect(() => levelForXp(-1, curve)).toThrow(/totalXp/);
    expect(() => levelForXp(1.5, curve)).toThrow(/totalXp/);
  });
});

describe('xpProgress', () => {
  it('reports progress inside a level', () => {
    expect(xpProgress(400, curve)).toEqual({
      level: 3,
      totalXp: 400,
      xpIntoLevel: 50,
      xpToNext: 450,
      progressBp: 1111,
      isMaxLevel: false,
    });
    expect(xpProgress(0, curve)).toMatchObject({ level: 1, xpIntoLevel: 0, xpToNext: 100, progressBp: 0 });
  });

  it('reports the cap with overflow kept', () => {
    expect(xpProgress(2600, curve)).toEqual({
      level: 6,
      totalXp: 2600,
      xpIntoLevel: 100,
      xpToNext: null,
      progressBp: 10_000,
      isMaxLevel: true,
    });
  });

  it('round-trips with the stored (level, xp within level) pair', () => {
    for (const total of [0, 1, 99, 100, 777, 1500, 2499, 2500, 3100]) {
      const p = xpProgress(total, curve);
      expect(totalXpFromLevelProgress(p.level, p.xpIntoLevel, curve)).toBe(total);
    }
    expect(() => totalXpFromLevelProgress(2, 250, curve)).toThrow(/next level/);
    expect(() => totalXpFromLevelProgress(7, 0, curve)).toThrow(/level/);
  });
});

describe('applyXpLoss (rewards-and-persistence §4, provisional 10% of next-level XP)', () => {
  it.each([
    // [totalXp, lossBp, totalAfter, xpLost, levelBefore, levelAfter]
    [400, DEFAULT_DEATH_XP_LOSS_BP, 355, 45, 3, 3], // 10% of 450
    [120, DEFAULT_DEATH_XP_LOSS_BP, 95, 25, 2, 1], // de-levels
    [10, DEFAULT_DEATH_XP_LOSS_BP, 0, 10, 1, 1], // never below level 1 / 0 XP
    [0, DEFAULT_DEATH_XP_LOSS_BP, 0, 0, 1, 1],
    [2550, DEFAULT_DEATH_XP_LOSS_BP, 2450, 100, 6, 5], // cap uses the last entry (1000)
    [3000, DEFAULT_DEATH_XP_LOSS_BP, 2900, 100, 6, 6],
    [360, 10_000, 0, 360, 3, 1], // drops two levels
    [400, 0, 400, 0, 3, 3],
    [355, 3_333, 206, 149, 3, 2], // ⌊450 × 3333 / 10000⌋ = ⌊149.985⌋ = 149 (floored)
  ])('%i XP, %i bp → %i XP', (totalXp, lossBp, after, lost, levelBefore, level) => {
    expect(applyXpLoss(totalXp, lossBp, curve)).toEqual({
      totalXp: after,
      xpLost: lost,
      levelBefore,
      level,
      levelsLost: levelBefore - level,
    });
  });

  it('rejects out-of-range loss', () => {
    expect(() => applyXpLoss(100, -1, curve)).toThrow(/lossBp/);
    expect(() => applyXpLoss(100, 10_001, curve)).toThrow(/lossBp/);
  });
});
