import type { XpCurve } from '@rpg/rpg-schema';
import { totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';
import type { XpProgress } from '@rpg/rpg-stats';

/**
 * GAP (no client content endpoint): mirror of `games/rpg/content/progression/xp-curve.json` (`progression:xp_curve`).
 * Display only; the server owns level and XP. A test pins it to the content file so drift fails CI. The curve is
 * open-ended since #129 (`tailGrowthBp`): there is no maximum level.
 */
export const XP_CURVE: XpCurve = { xpToNext: [100, 250, 450, 700, 1000], tailGrowthBp: 12_500 };

/**
 * Progress inside the current level for the header bar and the Character screen. The server stores
 * `(level, xp within level)` (data-model §2); this converts it with the shared rpg-stats helpers. Returns `null`
 * when the server's values do not fit the client's curve (stale mirror): callers then show raw XP only.
 */
export function levelProgress(level: number, xpWithinLevel: number, curve: XpCurve = XP_CURVE): XpProgress | null {
  try {
    const progress = xpProgress(totalXpFromLevelProgress(level, xpWithinLevel, curve), curve);
    return progress.level === level ? progress : null;
  } catch {
    return null;
  }
}
