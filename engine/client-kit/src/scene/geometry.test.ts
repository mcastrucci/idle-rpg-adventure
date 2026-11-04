import { describe, expect, it } from 'vitest';

import { MIN_TAP_RADIUS, clampResolution, coverFit, hitRegion } from './geometry.ts';

describe('scene geometry', () => {
  it('covers and centres the scene', () => {
    expect(coverFit({ width: 400, height: 200 }, { width: 200, height: 200 })).toEqual({ scale: 1, offsetX: -100, offsetY: 0 });
    expect(coverFit({ width: 400, height: 200 }, { width: 400, height: 400 })).toEqual({ scale: 2, offsetX: -200, offsetY: 0 });
    expect(coverFit({ width: 0, height: 0 }, { width: 10, height: 10 }).scale).toBe(1);
  });

  it('caps the device pixel ratio', () => {
    expect(clampResolution(3, 2)).toBe(2);
    expect(clampResolution(1.5, 2)).toBe(1.5);
    expect(clampResolution(0.75, 2)).toBe(1);
    expect(clampResolution(Number.NaN, 2)).toBe(1);
  });

  it('keeps small regions tappable and picks the nearest overlapping one', () => {
    const fit = { scale: 0.5, offsetX: 0, offsetY: 0 };
    const regions = [
      { id: 'small', x: 100, y: 100, radius: 4, enabled: true },
      { id: 'near', x: 110, y: 100, radius: 4, enabled: true },
    ];
    // Both are far below 22 css px on screen, yet both are tappable.
    expect(hitRegion(regions, fit, 50 + MIN_TAP_RADIUS - 2, 50)?.id).toBe('near');
    expect(hitRegion(regions, fit, 50, 50)?.id).toBe('small');
    expect(hitRegion(regions, fit, 200, 200)).toBeNull();
  });
});
