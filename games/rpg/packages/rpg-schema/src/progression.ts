/**
 * XP curve table (`content/progression/xp-curve.json`). Curves are precomputed tables, never formulas (combat-engine §4);
 * the actual numbers are open decision #2.
 */
import { z } from 'zod';

export const XpCurveSchema = z
  .strictObject({
    /**
     * `xpToNext[i]` = XP needed to go from level `i + 1` to `i + 2` (XP is counted within the level, data-model §2).
     * Strictly increasing; the level cap is `xpToNext.length + 1`.
     */
    xpToNext: z.array(z.int().positive()).min(1),
  })
  .superRefine((curve, ctx) => {
    curve.xpToNext.forEach((xp, i) => {
      const previous = curve.xpToNext[i - 1];
      if (previous !== undefined && xp <= previous) {
        ctx.addIssue({ code: 'custom', path: ['xpToNext', i], message: `must be greater than the previous threshold (${previous})` });
      }
    });
  });
export type XpCurve = z.output<typeof XpCurveSchema>;

/** Level cap implied by a curve. */
export function maxLevel(curve: XpCurve): number {
  return curve.xpToNext.length + 1;
}
