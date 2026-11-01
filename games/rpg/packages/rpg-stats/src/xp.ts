/**
 * XP helpers over the content XP curve (`XpCurve` from `@rpg/rpg-schema`; combat-engine §4: curves are tables).
 *
 * The helpers work on **total XP** (XP earned since level 1). `characters` stores `(level, xp within level)`
 * (data-model §2); convert with {@link totalXpFromLevelProgress} and {@link xpProgress}.
 *
 * Curve semantics: `xpToNext[i]` is the XP needed from level `i + 1` to `i + 2`; the level cap is
 * `xpToNext.length + 1`. XP beyond the cap is kept (it is not discarded) but grants no level.
 */
import { maxLevel } from '@rpg/rpg-schema';
import type { XpCurve } from '@rpg/rpg-schema';

import { BP_SCALE, assertInt, mulBp, mulDivFloor } from './int-math.ts';

/**
 * Provisional death XP penalty: 10% of the XP required for the next level
 * (rewards-and-persistence §4, open decision #8).
 */
export const DEFAULT_DEATH_XP_LOSS_BP = 1_000;

export interface XpProgress {
  readonly level: number;
  readonly totalXp: number;
  /** XP earned inside the current level (≥ 0; at the cap this includes any overflow). */
  readonly xpIntoLevel: number;
  /** XP needed to reach the next level, or `null` at the level cap. */
  readonly xpToNext: number | null;
  /** `xpIntoLevel / xpToNext` in basis points, floored; 10000 at the cap. */
  readonly progressBp: number;
  readonly isMaxLevel: boolean;
}

export interface XpLossResult {
  readonly totalXp: number;
  /** XP actually removed (≤ requested penalty; total XP never goes below 0). */
  readonly xpLost: number;
  readonly levelBefore: number;
  readonly level: number;
  readonly levelsLost: number;
}

/** Total XP at which `level` starts (0 for level 1). */
export function totalXpAtLevelStart(level: number, curve: XpCurve): number {
  assertLevel(level, curve);
  let total = 0;
  for (let i = 0; i < level - 1; i++) total += requirement(curve, i);
  return total;
}

/** Level reached with `totalXp` (1..cap). */
export function levelForXp(totalXp: number, curve: XpCurve): number {
  assertTotalXp(totalXp);
  let level = 1;
  let threshold = 0;
  for (let i = 0; i < curve.xpToNext.length; i++) {
    threshold += requirement(curve, i);
    if (totalXp < threshold) break;
    level++;
  }
  return level;
}

export function xpProgress(totalXp: number, curve: XpCurve): XpProgress {
  const level = levelForXp(totalXp, curve);
  const xpIntoLevel = totalXp - totalXpAtLevelStart(level, curve);
  const isMaxLevel = level === maxLevel(curve);
  if (isMaxLevel) return { level, totalXp, xpIntoLevel, xpToNext: null, progressBp: 10_000, isMaxLevel };
  const xpToNext = requirement(curve, level - 1);
  const progressBp = mulDivFloor(xpIntoLevel, BP_SCALE, xpToNext);
  return { level, totalXp, xpIntoLevel, xpToNext, progressBp, isMaxLevel };
}

/**
 * Converts the stored `(level, xp within level)` pair to total XP. `xpIntoLevel` must be below the level's
 * requirement (except at the cap).
 */
export function totalXpFromLevelProgress(level: number, xpIntoLevel: number, curve: XpCurve): number {
  assertTotalXp(xpIntoLevel, 'xpIntoLevel');
  const start = totalXpAtLevelStart(level, curve);
  if (level < maxLevel(curve) && xpIntoLevel >= requirement(curve, level - 1)) {
    throw new RangeError(`xpIntoLevel ${xpIntoLevel} reaches the next level (${requirement(curve, level - 1)})`);
  }
  return start + xpIntoLevel;
}

/**
 * Death XP penalty (rewards-and-persistence §4): lose `lossBp` of the XP required for the next level (floored).
 * May drop levels; never below level 1 / 0 total XP. At the level cap the last curve entry is the reference.
 */
export function applyXpLoss(totalXp: number, lossBp: number, curve: XpCurve): XpLossResult {
  assertInt(lossBp, 'lossBp');
  if (lossBp < 0 || lossBp > 10_000) throw new RangeError(`lossBp must be in [0, 10000], got ${lossBp}`);
  const levelBefore = levelForXp(totalXp, curve);
  const reference = requirement(curve, Math.min(levelBefore - 1, curve.xpToNext.length - 1));
  const xpLost = Math.min(totalXp, mulBp(reference, lossBp));
  const after = totalXp - xpLost;
  const level = levelForXp(after, curve);
  return { totalXp: after, xpLost, levelBefore, level, levelsLost: levelBefore - level };
}

function requirement(curve: XpCurve, index: number): number {
  const xp = curve.xpToNext[index];
  if (xp === undefined) throw new RangeError(`xp curve has no entry ${index}`);
  assertInt(xp, `xpToNext[${index}]`);
  if (xp <= 0) throw new RangeError(`xpToNext[${index}] must be > 0`);
  return xp;
}

function assertLevel(level: number, curve: XpCurve): void {
  assertInt(level, 'level');
  if (level < 1 || level > maxLevel(curve)) {
    throw new RangeError(`level must be in [1, ${maxLevel(curve)}], got ${level}`);
  }
}

function assertTotalXp(xp: number, name = 'totalXp'): void {
  assertInt(xp, name);
  if (xp < 0) throw new RangeError(`${name} must be >= 0, got ${xp}`);
}
