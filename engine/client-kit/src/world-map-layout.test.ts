import { describe, expect, it } from 'vitest';

import { layoutWorldMap, MIN_MAP_SCALE, panMap, visibleWorldMapRoutes, zoomMapAt } from './world-map-layout.ts';
import type { WorldMapView } from './world-map-types.ts';

function view(areas: WorldMapView['areas'], hubPosition: WorldMapView['hub']['position'] = null): WorldMapView {
  return {
    hub: { id: 'hub', label: 'Hub', position: hubPosition },
    areas,
    routes: [],
  };
}

function area(id: string, position: WorldMapView['areas'][number]['position'] = null): WorldMapView['areas'][number] {
  return {
    id,
    label: id,
    visibility: 'known',
    position,
    lockedReasons: [],
    actions: { enter: true, startIdle: false },
  };
}

describe('layoutWorldMap', () => {
  it('fits compact authored coordinates while preserving their relative positions', () => {
    const layout = layoutWorldMap({
      ...view([area('meadow', { x: 0, y: 100 }), area('orchard', { x: 100, y: 0 })], { x: 0, y: 0 }),
      size: { width: 1000, height: 620 },
    });

    expect(layout.hub).toEqual({ x: 290, y: 100 });
    expect(layout.areas.get('meadow')).toEqual({ x: 290, y: 520 });
    expect(layout.areas.get('orchard')).toEqual({ x: 710, y: 100 });
  });

  it('places unpositioned areas deterministically without overlapping the hub', () => {
    const map = view([area('one'), area('two'), area('three'), area('four')]);
    const first = layoutWorldMap(map);
    const second = layoutWorldMap(map);
    const points = [...first.areas.values()];
    const minSeparation = (first.width * 44) / (360 * MIN_MAP_SCALE);

    expect([...first.areas]).toEqual([...second.areas]);
    for (const [index, point] of points.entries()) {
      expect(Math.hypot(point.x - first.hub.x, point.y - first.hub.y)).toBeGreaterThanOrEqual(minSeparation);
      for (const other of points.slice(index + 1)) {
        expect(Math.hypot(point.x - other.x, point.y - other.y)).toBeGreaterThanOrEqual(minSeparation);
      }
    }
  });

  it('uses the view coordinate size for generated positions', () => {
    const layout = layoutWorldMap({ ...view([area('one')]), size: { width: 800, height: 500 } });

    expect(layout.width).toBe(800);
    expect(layout.height).toBe(500);
    expect(layout.hub).toEqual({ x: 400, y: 250 });
  });

  it('suppresses routes whose endpoints are absent from the visible projection', () => {
    const projected = {
      ...view([area('known')]),
      routes: [
        { id: 'visible-route', from: 'hub', to: 'known' },
        { id: 'hidden-route', from: 'known', to: 'hidden-area' },
      ],
    };

    expect(visibleWorldMapRoutes(projected).map((route) => route.id)).toEqual(['visible-route']);
  });

  it('keeps the map point under the zoom anchor fixed and clamps scale', () => {
    const initial = { scale: 1, x: 10, y: -20 };
    const anchor = { x: 240, y: 160 };
    const zoomed = zoomMapAt(initial, anchor, 4);
    const mapPointBefore = { x: (anchor.x - initial.x) / initial.scale, y: (anchor.y - initial.y) / initial.scale };
    const mapPointAfter = { x: (anchor.x - zoomed.x) / zoomed.scale, y: (anchor.y - zoomed.y) / zoomed.scale };

    expect(zoomed.scale).toBe(2.6);
    expect(mapPointAfter).toEqual(mapPointBefore);
  });

  it('pans without changing zoom', () => {
    expect(panMap({ scale: 1.4, x: 2, y: 3 }, -12, 8)).toEqual({ scale: 1.4, x: -10, y: 11 });
  });
});
