/**
 * Deterministic placement of combat sprites inside the scene band. Pure data: the same combatant count always yields
 * the same slots, so a replayed or reconnected fight looks identical and the layout can be unit tested.
 *
 * Units: `x` is the sprite's horizontal centre and `bottom` its base, both in percent of the band; `size` is the sprite
 * edge in container-min units (1 = 1% of the band's smaller side), so a sprite stays square and in proportion when the
 * band is a 360x290 phone portrait or a short 320x190 one.
 */
export interface SpriteSlot {
  readonly x: number;
  readonly bottom: number;
  readonly size: number;
  /** Paint order: the back row sits under the front row. */
  readonly layer: number;
}

/** The controlled hero stands on the left, facing the enemies on the right. */
export const HERO_SLOT: SpriteSlot = { x: 19, bottom: 1, size: 50, layer: 3 };

/** Most enemy sprites the band draws; a larger group still lists every enemy in the DOM party/enemy frames. */
export const MAX_ENEMY_SPRITES = 4;

const ENEMY_SLOTS: readonly (readonly SpriteSlot[])[] = [
  [],
  [{ x: 68, bottom: 1, size: 60, layer: 2 }],
  [{ x: 57, bottom: 1, size: 46, layer: 2 }, { x: 83, bottom: 1, size: 46, layer: 2 }],
  [{ x: 55, bottom: 1, size: 42, layer: 2 }, { x: 83, bottom: 1, size: 42, layer: 2 }, { x: 69, bottom: 20, size: 36, layer: 1 }],
  [{ x: 58, bottom: 1, size: 40, layer: 2 }, { x: 85, bottom: 1, size: 40, layer: 2 },
    { x: 45, bottom: 20, size: 34, layer: 1 }, { x: 72, bottom: 20, size: 34, layer: 1 }],
];

/** Slots for `count` enemies in server order (clamped to 1..MAX_ENEMY_SPRITES). The first enemy is the frontmost-left. */
export function enemySlots(count: number): readonly SpriteSlot[] {
  const n = Math.max(0, Math.min(MAX_ENEMY_SPRITES, Math.trunc(count)));
  return ENEMY_SLOTS[n] ?? [];
}
