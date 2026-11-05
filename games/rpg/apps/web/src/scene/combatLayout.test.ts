import { describe, expect, it } from 'vitest';

import { HERO_SLOT, MAX_ENEMY_SPRITES, enemySlots } from './combatLayout.ts';

describe('enemy layout', () => {
  it('gives each count 1..4 exactly that many slots, deterministically', () => {
    for (const count of [1, 2, 3, 4]) {
      expect(enemySlots(count)).toHaveLength(count);
      expect(enemySlots(count)).toEqual(enemySlots(count));
    }
  });

  it('keeps every slot right of the hero, sized sensibly, and never on top of a sibling', () => {
    for (const count of [1, 2, 3, 4]) {
      const slots = enemySlots(count);
      for (const slot of slots) {
        expect(slot.x).toBeGreaterThan(HERO_SLOT.x + 20);
        expect(slot.bottom).toBeGreaterThanOrEqual(0);
        expect(slot.size).toBeGreaterThan(0);
        expect(slot.size).toBeLessThanOrEqual(HERO_SLOT.size + 10);
      }
      expect(new Set(slots.map((slot) => `${slot.x}:${slot.bottom}`)).size).toBe(count);
    }
  });

  it('puts the back row behind the front row and shrinks sprites as the group grows', () => {
    const four = enemySlots(4);
    const front = four.filter((slot) => slot.bottom < 10);
    const back = four.filter((slot) => slot.bottom >= 10);
    expect(front).toHaveLength(2);
    expect(back).toHaveLength(2);
    expect(Math.max(...back.map((slot) => slot.layer))).toBeLessThan(Math.min(...front.map((slot) => slot.layer)));
    expect(enemySlots(1)[0]?.size).toBeGreaterThan(enemySlots(2)[0]?.size ?? 0);
    expect(enemySlots(2)[0]?.size).toBeGreaterThan(enemySlots(4)[0]?.size ?? 0);
  });

  it('clamps to the supported range', () => {
    expect(enemySlots(0)).toEqual([]);
    expect(enemySlots(-3)).toEqual([]);
    expect(enemySlots(9)).toHaveLength(MAX_ENEMY_SPRITES);
    expect(enemySlots(2.9)).toHaveLength(2);
  });
});
