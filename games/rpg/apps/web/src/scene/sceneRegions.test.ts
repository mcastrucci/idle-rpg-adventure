import { describe, expect, it } from 'vitest';
import type { LiveSceneDto } from '@rpg/protocol';

import { parseSceneRegionId, sceneRegionId, sceneRegions } from './sceneRegions.ts';

const scene: LiveSceneDto = { width: 543, height: 724, regions: [
  { id: 'exit:a', kind: 'exit', x: 100, y: 200, r: 30 }, { id: 'rune', kind: 'hotspot', x: 10, y: 20, r: 5 }, { id: 'exit:orphan', kind: 'exit', x: 1, y: 1, r: 1 }] };

describe('sceneRegions', () => {
  it('scales the Tiled pixel space onto the art, per axis, and prefixes the kind', () => {
    const regions = sceneRegions(scene, { width: 1086, height: 1448 }, (kind, id) => (id === 'exit:orphan' ? undefined : kind === 'exit'));
    expect(regions).toEqual([
      { id: 'exit:exit:a', x: 200, y: 400, radius: 60, enabled: true },
      { id: 'hotspot:rune', x: 20, y: 40, radius: 10, enabled: false },
    ]);
  });
  it('is the identity when the map and the art have the same size, and empty without geometry', () => {
    expect(sceneRegions({ width: 10, height: 10, regions: [{ id: 'x', kind: 'exit', x: 3, y: 4, r: 2 }] }, { width: 10, height: 10 }, () => true))
      .toEqual([{ id: 'exit:x', x: 3, y: 4, radius: 2, enabled: true }]);
    expect(sceneRegions(undefined, { width: 10, height: 10 }, () => true)).toEqual([]);
  });
  it('round-trips and rejects foreign region IDs', () => {
    expect(parseSceneRegionId(sceneRegionId('exit', 'exit:a:b'))).toEqual({ kind: 'exit', id: 'exit:a:b' });
    expect(parseSceneRegionId('other:x')).toBeNull();
    expect(parseSceneRegionId('exit')).toBeNull();
  });
});
