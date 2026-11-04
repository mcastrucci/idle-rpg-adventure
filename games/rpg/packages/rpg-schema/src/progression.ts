/**
 * XP curve (`content/progression/xp-curve.json`). The authored part is a precomputed table (combat-engine §4); levels
 * beyond the table follow an integer growth rule (`tailGrowthBp`), so there is no maximum level (#129, owner decision
 * recorded in open decisions #2). Everything stays integer math.
 */
import { z } from 'zod';

/** Authored `xpToNext` table: strictly increasing positive integers. */
function refineIncreasing(xpToNext: readonly number[], ctx: z.RefinementCtx): void {
  xpToNext.forEach((xp, i) => {
    const previous = xpToNext[i - 1];
    if (previous !== undefined && xp <= previous) {
      ctx.addIssue({ code: 'custom', path: ['xpToNext', i], message: `must be greater than the previous threshold (${previous})` });
    }
  });
}

/**
 * A curve with only the authored table and no tail: the level cap is `xpToNext.length + 1` and XP beyond it is kept
 * inside the last level. This is the pre-#129 shape; it is retained for expedition snapshots persisted by
 * `rpg-idle@2.0.0` (the content schema {@link XpCurveSchema} always has a tail).
 */
export const CappedXpCurveSchema = z
  .strictObject({
    /**
     * `xpToNext[i]` = XP needed to go from level `i + 1` to `i + 2` (XP is counted within the level, data-model §2).
     * Strictly increasing.
     */
    xpToNext: z.array(z.int().positive()).min(1),
  })
  .superRefine((curve, ctx) => refineIncreasing(curve.xpToNext, ctx));
export type CappedXpCurve = z.output<typeof CappedXpCurveSchema>;

/** Smallest / largest accepted tail growth: ×1.0001 .. ×10 per level. */
export const MIN_TAIL_GROWTH_BP = 10_001;
export const MAX_TAIL_GROWTH_BP = 100_000;

export const XpCurveSchema = z
  .strictObject({
    /** Authored table, see {@link CappedXpCurveSchema}. */
    xpToNext: z.array(z.int().positive()).min(1),
    /**
     * Growth of the requirement beyond the table, in basis points: for a level `L` past the table,
     * `xpToNext(L) = ⌊xpToNext(L - 1) × tailGrowthBp / 10000⌋`. Must make the first tail step strictly larger than the
     * last table entry so the whole curve stays strictly increasing.
     */
    tailGrowthBp: z.int().min(MIN_TAIL_GROWTH_BP).max(MAX_TAIL_GROWTH_BP),
  })
  .superRefine((curve, ctx) => {
    refineIncreasing(curve.xpToNext, ctx);
    const last = curve.xpToNext[curve.xpToNext.length - 1];
    const inRange = Number.isInteger(curve.tailGrowthBp) && curve.tailGrowthBp >= MIN_TAIL_GROWTH_BP && curve.tailGrowthBp <= MAX_TAIL_GROWTH_BP;
    if (inRange && last !== undefined && Math.floor((last * curve.tailGrowthBp) / 10_000) <= last) {
      ctx.addIssue({ code: 'custom', path: ['tailGrowthBp'], message: `must grow the last table entry (${last}) by at least 1 XP` });
    }
  });
export type XpCurve = z.output<typeof XpCurveSchema>;

/**
 * Shape accepted by the XP helpers of `@rpg/rpg-stats`: a table plus an optional tail. Without `tailGrowthBp` the
 * curve is capped at `xpToNext.length + 1` (legacy behaviour).
 */
export interface XpCurveLike {
  readonly xpToNext: readonly number[];
  readonly tailGrowthBp?: number | undefined;
}

/**
 * Level cap implied by a curve, or `null` when the curve is open-ended. (Open curves are still bounded by the safe
 * integer range; `@rpg/rpg-stats` `terminalLevel` reports that bound.)
 */
export function maxLevel(curve: XpCurveLike): number | null {
  return curve.tailGrowthBp === undefined ? curve.xpToNext.length + 1 : null;
}
