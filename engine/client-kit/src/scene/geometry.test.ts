import { describe, expect, it } from 'vitest';

import { MIN_TAP_RADIUS, clampResolution, coverFit, hitRegion } from './geometry.ts';

describe('scene geometry', () => {
  it('covers and centres the scene', () => {
    expect(coverFit({ width: 400, height: 200 }, { width: 200, height: 200 })).toEqual({ scale: 1, offsetX: -100, offsetY: 0 });
    expect(coverFit({ width: 400, height: 200 }, { width: 400, height: 400 })).toEqual({ scale: 2, offsetX: -200, offsetY: 0 });
    expect(coverFit({ width: 0, height: 0 }, { width: 10, height: 10 }).scale).toBe(1);
  });

  describe('framing', () => {
    // A 3:4 portrait scene (300x400) in a 4:3 band (300x225): scale 1, 225 of 400 px visible (56%).
    const art = { width: 300, height: 400 };
    const band = { width: 300, height: 225 };

    it('defaults to the centre, same as no framing', () => {
      expect(coverFit(art, band, {})).toEqual(coverFit(art, band));
      expect(coverFit(art, band).offsetY).toBeCloseTo(-87.5);
      expect(coverFit(art, band).offsetX).toBe(0);
    });

    it('keeps the focal point at the centre of the viewport', () => {
      const fit = coverFit(art, band, { focalY: 0.45 });
      expect(fit.offsetY + 0.45 * 400 * fit.scale).toBeCloseTo(225 / 2);
    });

    it('never leaves an empty edge, however extreme the focal point', () => {
      expect(coverFit(art, band, { focalY: 0 }).offsetY).toBe(0);
      expect(coverFit(art, band, { focalY: 1 }).offsetY).toBeCloseTo(225 - 400);
      expect(coverFit(art, band, { focalY: Number.NaN }).offsetY).toBeCloseTo(-87.5);
      expect(coverFit(art, band, { focalY: -3 }).offsetY).toBe(0);
    });

    it('keeps the visible window out of the quiet bands when it fits between them', () => {
      const quiet = { quietTop: 0.12, quietBottom: 0.18 };
      const top = coverFit(art, band, { focalY: 0, ...quiet });
      expect(-top.offsetY / 400).toBeCloseTo(0.12); // window starts at the end of the top band
      const bottom = coverFit(art, band, { focalY: 1, ...quiet });
      expect((-bottom.offsetY + 225) / 400).toBeCloseTo(0.82); // and ends at the start of the bottom band
      expect(coverFit(art, band, { focalY: 0.5, ...quiet }).offsetY).toBeCloseTo(-87.5);
    });

    it('ignores the quiet bands when the window is taller than what is left', () => {
      const tall = { width: 300, height: 350 }; // 350 of 400 visible, band is 280
      const fit = coverFit(art, tall, { focalY: 0, quietTop: 0.12, quietBottom: 0.18 });
      expect(fit.offsetY).toBe(0);
    });

    it('frames the horizontal axis of a wide scene', () => {
      const wide = { width: 400, height: 200 };
      expect(coverFit(wide, { width: 200, height: 200 }, { focalX: 0 }).offsetX).toBe(0);
      expect(coverFit(wide, { width: 200, height: 200 }, { focalX: 0.75 }).offsetX).toBe(-200);
    });

    it('feeds hit-testing, so taps follow the framed crop', () => {
      const fit = coverFit(art, band, { focalY: 0, quietTop: 0.12 });
      const region = { id: 'door', x: 150, y: 100, radius: 10, enabled: true };
      // Scene y=100 sits at 100 - 48 = 52 css px under the 12% band.
      expect(hitRegion([region], fit, 150, 52)?.id).toBe('door');
      expect(hitRegion([region], fit, 150, 100)).toBeNull();
    });
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
