/**
 * XP helpers over the content XP curve (`XpCurve` from `@rpg/rpg-schema`; combat-engine §4: curves are tables).
 *
 * The helpers work on **total XP** (XP earned since level 1). `characters` stores `(level, xp within level)`
 * (data-model §2); convert with {@link totalXpFromLevelProgress} and {@link xpProgress}.
 *
 * Curve semantics (#129): `xpToNext[i]` is the XP needed from level `i + 1` to `i + 2`. With a `tailGrowthBp` the
 * curve is **open-ended**: past the table, `xpToNext(L) = ⌊xpToNext(L - 1) × tailGrowthBp / 10000⌋`, so there is no
 * maximum level. Without `tailGrowthBp` the curve is capped at `xpToNext.length + 1` (the pre-#129 shape, retained for
 * persisted `rpg-idle@2.0.0` expedition snapshots); XP beyond a cap is kept but grants no level.
 *
 * Overflow: every threshold is a safe integer. The **terminal level** ({@link terminalLevel}) is the last level whose
 * "next" threshold would still be a safe integer; it behaves like a cap (`xpToNext` is `null`, XP beyond it is kept in
 * `xpIntoLevel`). It is a deterministic bound, not a design limit: with the authored table and ×1.25 growth it lies far
 * beyond the level any player can reach (level 130+, trillions of XP).
 */
import type { XpCurveLike } from '@rpg/rpg-schema';

import { BP_SCALE, assertInt, mulBp, mulDivFloor } from './int-math.ts';

/**
 * LEGACY death XP penalty (rewards-and-persistence §4, pre-#129): 10% of the XP required for the next level. Only used
 * by the retained `rpg-idle@2.0.0` settlement policy through {@link applyXpLoss}; new code uses
 * {@link applyDeathXpLoss}.
 */
export const DEFAULT_DEATH_XP_LOSS_BP = 1_000;

/**
 * Tail growth of the authored curve at the time of #129 (`content/progression/xp-curve.json` `tailGrowthBp`, pinned to
 * the file by a test). Content stays authoritative; this constant is only the fallback for persisted data that predates
 * the stored tail (old expedition snapshots, effects emitted by an older node) so they can still be converted.
 */
export const DEFAULT_XP_TAIL_GROWTH_BP = 12_500;

/** Death XP loss at level 1, the floor after many levels, and the per-level reduction (all basis points; #129). */
export const DEATH_XP_LOSS_BASE_BP = 1_000;
export const DEATH_XP_LOSS_MIN_BP = 200;
export const DEATH_XP_LOSS_STEP_BP = 20;

export interface XpProgress {
  readonly level: number;
  readonly totalXp: number;
  /** XP earned inside the current level (≥ 0; at the terminal level this includes any overflow). */
  readonly xpIntoLevel: number;
  /** XP needed to reach the next level, or `null` at the terminal level / cap. */
  readonly xpToNext: number | null;
  /** `xpIntoLevel / xpToNext` in basis points, floored; 10000 at the terminal level. */
  readonly progressBp: number;
  /** True only at the {@link terminalLevel} (never for a practical player on an open curve). */
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

export interface DeathXpLossResult extends XpLossResult {
  /** The level-scaled loss rate used: {@link deathXpLossBp} of `levelBefore`. */
  readonly lossBp: number;
}

/**
 * `starts[i]` = total XP at which level `i + 1` starts. Its length is the terminal level: the table stops at the
 * curve's cap (capped curves) or when the next threshold would leave the safe-integer range.
 */
function levelStarts(curve: XpCurveLike): readonly number[] {
  const cached = startsCache.get(curve);
  if (cached !== undefined && cached.table === curve.xpToNext && cached.length === curve.xpToNext.length && cached.tail === curve.tailGrowthBp) {
    return cached.starts;
  }
  const starts = computeLevelStarts(curve);
  startsCache.set(curve, { table: curve.xpToNext, length: curve.xpToNext.length, tail: curve.tailGrowthBp, starts });
  return starts;
}

/** Curves are treated as immutable values; the derived thresholds are memoized per curve object. */
const startsCache = new WeakMap<XpCurveLike, { table: readonly number[]; length: number; tail: number | undefined; starts: readonly number[] }>();

function computeLevelStarts(curve: XpCurveLike): number[] {
  const starts = [0];
  let previous = 0;
  for (let i = 0; ; i++) {
    let need: number;
    if (i < curve.xpToNext.length) {
      need = requirement(curve, i);
    } else if (curve.tailGrowthBp === undefined) {
      break; // capped curve
    } else {
      assertInt(curve.tailGrowthBp, 'tailGrowthBp');
      try {
        need = mulBp(previous, curve.tailGrowthBp);
      } catch {
        break; // the product itself leaves the safe-integer range
      }
      if (need <= previous) throw new RangeError(`tailGrowthBp ${curve.tailGrowthBp} does not grow the requirement ${previous}`);
    }
    const next = (starts[i] as number) + need;
    if (!Number.isSafeInteger(next)) break;
    starts.push(next);
    previous = need;
  }
  return starts;
}

/** Last representable level: the level cap of a capped curve, or the safe-integer bound of an open one. */
export function terminalLevel(curve: XpCurveLike): number {
  return levelStarts(curve).length;
}

/** XP needed from `level` to `level + 1`, or `null` at the {@link terminalLevel}. */
export function xpToNextAtLevel(level: number, curve: XpCurveLike): number | null {
  const starts = levelStarts(curve);
  assertLevel(level, starts);
  return level === starts.length ? null : (starts[level] as number) - (starts[level - 1] as number);
}

/** Total XP at which `level` starts (0 for level 1). */
export function totalXpAtLevelStart(level: number, curve: XpCurveLike): number {
  const starts = levelStarts(curve);
  assertLevel(level, starts);
  return starts[level - 1] as number;
}

/** Level reached with `totalXp` (1..terminal level). */
export function levelForXp(totalXp: number, curve: XpCurveLike): number {
  assertTotalXp(totalXp);
  return levelIn(levelStarts(curve), totalXp);
}

export function xpProgress(totalXp: number, curve: XpCurveLike): XpProgress {
  assertTotalXp(totalXp);
  const starts = levelStarts(curve);
  const level = levelIn(starts, totalXp);
  const xpIntoLevel = totalXp - (starts[level - 1] as number);
  if (level === starts.length) return { level, totalXp, xpIntoLevel, xpToNext: null, progressBp: 10_000, isMaxLevel: true };
  const xpToNext = (starts[level] as number) - (starts[level - 1] as number);
  const progressBp = mulDivFloor(xpIntoLevel, BP_SCALE, xpToNext);
  return { level, totalXp, xpIntoLevel, xpToNext, progressBp, isMaxLevel: false };
}

/**
 * Converts the stored `(level, xp within level)` pair to total XP. `xpIntoLevel` must be below the level's requirement
 * (except at the terminal level, where overflow is kept).
 */
export function totalXpFromLevelProgress(level: number, xpIntoLevel: number, curve: XpCurveLike): number {
  assertTotalXp(xpIntoLevel, 'xpIntoLevel');
  const starts = levelStarts(curve);
  assertLevel(level, starts);
  const start = starts[level - 1] as number;
  if (level < starts.length) {
    const need = (starts[level] as number) - start;
    if (xpIntoLevel >= need) throw new RangeError(`xpIntoLevel ${xpIntoLevel} reaches the next level (${need})`);
  }
  const total = start + xpIntoLevel;
  if (!Number.isSafeInteger(total)) throw new RangeError(`total XP ${start} + ${xpIntoLevel} is not a safe integer`);
  return total;
}

/**
 * LEGACY death XP penalty (pre-#129, frozen for the retained `rpg-idle@2.0.0` settlement policy; do not change):
 * lose `lossBp` of the XP required for the next level (floored). May drop levels; never below level 1 / 0 total XP. At
 * the level cap the last table entry is the reference. Callers must pass the **capped** table curve (`{ xpToNext }`).
 * New code uses {@link applyDeathXpLoss}.
 */
export function applyXpLoss(totalXp: number, lossBp: number, curve: XpCurveLike): XpLossResult {
  assertInt(lossBp, 'lossBp');
  if (lossBp < 0 || lossBp > 10_000) throw new RangeError(`lossBp must be in [0, 10000], got ${lossBp}`);
  const levelBefore = levelForXp(totalXp, curve);
  const reference = requirement(curve, Math.min(levelBefore - 1, curve.xpToNext.length - 1));
  const xpLost = Math.min(totalXp, mulBp(reference, lossBp));
  const after = totalXp - xpLost;
  const level = levelForXp(after, curve);
  return { totalXp: after, xpLost, levelBefore, level, levelsLost: levelBefore - level };
}

/** Death XP loss rate of a hero at `level`: `max(200, 1000 - 20 × (level - 1))` basis points (10% down to 2%). */
export function deathXpLossBp(level: number): number {
  assertInt(level, 'level');
  if (level < 1) throw new RangeError(`level must be >= 1, got ${level}`);
  const steps = Math.min(level - 1, (DEATH_XP_LOSS_BASE_BP - DEATH_XP_LOSS_MIN_BP) / DEATH_XP_LOSS_STEP_BP);
  return DEATH_XP_LOSS_BASE_BP - DEATH_XP_LOSS_STEP_BP * steps;
}

/**
 * Death XP penalty (#129; open decision #8, provisional owner values), used by live death and by idle settlement from
 * `rpg-idle@2.1.0`. With `L` the level before the loss:
 * `xpLost = ⌊totalXp × deathXpLossBp(L) / 10000⌋`, but total XP never falls below the XP at which level `L - 1` starts
 * (so a death costs at most one level) and never below 0 (level 1).
 */
export function applyDeathXpLoss(totalXp: number, curve: XpCurveLike): DeathXpLossResult {
  assertTotalXp(totalXp);
  const starts = levelStarts(curve);
  const levelBefore = levelIn(starts, totalXp);
  const lossBp = deathXpLossBp(levelBefore);
  const floorTotal = levelBefore > 1 ? (starts[levelBefore - 2] as number) : 0;
  const after = Math.max(totalXp - mulBp(totalXp, lossBp), floorTotal);
  const level = levelIn(starts, after);
  return { totalXp: after, xpLost: totalXp - after, lossBp, levelBefore, level, levelsLost: levelBefore - level };
}

function levelIn(starts: readonly number[], totalXp: number): number {
  let level = 1;
  while (level < starts.length && totalXp >= (starts[level] as number)) level++;
  return level;
}

function requirement(curve: XpCurveLike, index: number): number {
  const xp = curve.xpToNext[index];
  if (xp === undefined) throw new RangeError(`xp curve has no entry ${index}`);
  assertInt(xp, `xpToNext[${index}]`);
  if (xp <= 0) throw new RangeError(`xpToNext[${index}] must be > 0`);
  return xp;
}

function assertLevel(level: number, starts: readonly number[]): void {
  assertInt(level, 'level');
  if (level < 1 || level > starts.length) {
    throw new RangeError(`level must be in [1, ${starts.length}], got ${level}`);
  }
}

function assertTotalXp(xp: number, name = 'totalXp'): void {
  assertInt(xp, name);
  if (xp < 0) throw new RangeError(`${name} must be >= 0, got ${xp}`);
}
