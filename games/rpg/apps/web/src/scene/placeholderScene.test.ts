import { describe, expect, it } from 'vitest';

import { SCENE_HEIGHT, SCENE_WIDTH, hashSeed, planScene, sceneForLocation, seededRandom } from './placeholderScene.ts';

describe('placeholder scene art', () => {
  it('is deterministic per location and differs between locations', () => {
    expect(planScene('location:old_well')).toEqual(planScene('location:old_well'));
    expect(planScene('location:old_well')).not.toEqual(planScene('location:glade'));
    const a = seededRandom(hashSeed('x'));
    const b = seededRandom(hashSeed('x'));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('describes a scene keyed by the location, with layers and no geometry yet', () => {
    const spec = sceneForLocation('location:old_well');
    expect(spec.id).toBe('location:old_well');
    expect(spec.background).toMatchObject({ width: SCENE_WIDTH, height: SCENE_HEIGHT });
    expect(spec.layers.map((layer) => layer.id)).toEqual(['foreground']);
    expect(spec.regions).toEqual([]);
  });

  it('keeps every drawn point inside the scene', () => {
    const plan = planScene('location:old_well');
    expect(plan.sun.x).toBeGreaterThan(0);
    expect(plan.sun.x).toBeLessThan(SCENE_WIDTH);
    for (const star of plan.stars) expect(star.y).toBeLessThan(SCENE_HEIGHT);
  });
});
