import type { Area, Location } from '@engine/world';

/** Content snapshot pinned to the live instance which generated a progress effect. */
export interface RpgCompletionSnapshot {
  readonly area: Area;
  readonly locations: readonly Location[];
}
