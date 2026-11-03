import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createActorWorldState } from '@engine/world';
import { validateRpgBundle } from '../content.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { compileWorldViewFixture, HIDDEN_FIXTURE, LOCKED_FIXTURE } from './test-content.ts';
import { isRpgAreaAccessible } from './access.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('world view authored PostgreSQL fixture', () => {
  it('compiles its private areas, locations, and routes through the real content compiler', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'world-view-content-'));
    dirs.push(dir);
    const bundle = await compileWorldViewFixture(dir);
    expect(() => validateRpgBundle(bundle)).not.toThrow();
    expect(bundle.world.areas.find(area => area.id === LOCKED_FIXTURE)?.startLocation).toBe('loc:locked_fixture.entry');
    expect(bundle.world.areas.find(area => area.id === HIDDEN_FIXTURE)?.locations).toEqual(['loc:hidden_fixture.entry']);
    expect(bundle.world.routes.some(route => route.id === 'route:locked_to_hidden_fixture')).toBe(true);
    expect(bundle.world.routes.find(route => route.id === 'route:sanctuary_to_region_1')?.requires)
      .toEqual({ areaCompleted: 'area:test_grove' });
    const state = (completedAreas: readonly `area:${string}`[]) => ({ actor: createActorWorldState({ completedAreas }),
      game: { level: 1, defeatedEnemies: new Set<string>() } });
    expect(isRpgAreaAccessible(bundle, state([]), 'area:region_1')).toBe(false);
    expect(isRpgAreaAccessible(bundle, state(['area:test_grove']), 'area:region_1')).toBe(true);
  });
});
