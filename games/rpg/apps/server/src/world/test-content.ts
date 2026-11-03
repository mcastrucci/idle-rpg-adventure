import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import plugin from '@rpg/content-plugin';

export const LOCKED_FIXTURE = 'area:locked_fixture';
export const HIDDEN_FIXTURE = 'area:hidden_fixture';
export const SECOND_LIVE_AREA = 'area:live_fixture_two';
export const SECOND_LIVE_START = 'loc:live_fixture_two.entry';
export const NONSTARTABLE_FIXTURE = 'area:nonstartable_fixture';

/** Build a private graph by adding authored source files, then compiling the full content directory normally. */
export async function compileWorldViewFixture(directory: string, options: { readonly gateRegionOne?: boolean } = {}): Promise<ContentBundle> {
  const source = fileURLToPath(new URL('../../../../content', import.meta.url));
  const content = join(directory, 'content');
  await cp(source, content, { recursive: true });
  await mkdir(join(content, 'world', 'areas'), { recursive: true });
  await mkdir(join(content, 'world', 'locations', 'locked_fixture'), { recursive: true });
  await mkdir(join(content, 'world', 'locations', 'hidden_fixture'), { recursive: true });
  await mkdir(join(content, 'world', 'locations', 'live_fixture_two'), { recursive: true });

  const locked = {
    id: LOCKED_FIXTURE, kind: 'explorable', nameKey: 'area.locked_fixture.name', difficulty: 1, recommendedLevel: [1, 3],
    mapPosition: { x: 400, y: 100 }, startLocation: 'loc:locked_fixture.entry', locations: ['loc:locked_fixture.entry'],
    revealedBy: { game: 'levelAtLeast', level: 1 },
  };
  const hidden = {
    id: HIDDEN_FIXTURE, kind: 'explorable', nameKey: 'area.hidden_fixture.private_name', difficulty: 1, recommendedLevel: [2, 4],
    mapPosition: { x: 600, y: 100 }, startLocation: 'loc:hidden_fixture.entry', locations: ['loc:hidden_fixture.entry'],
  };
  const secondLiveArea = {
    id: SECOND_LIVE_AREA, kind: 'explorable', nameKey: 'area.live_fixture_two.name', difficulty: 1, recommendedLevel: [1, 3],
    mapPosition: { x: 250, y: 100 }, startLocation: SECOND_LIVE_START, locations: [SECOND_LIVE_START],
    revealedBy: { game: 'levelAtLeast', level: 1 },
  };
  const nonstartable = {
    id: NONSTARTABLE_FIXTURE, kind: 'explorable', nameKey: 'area.nonstartable_fixture.name', difficulty: 1,
    recommendedLevel: [1, 2], mapPosition: { x: 800, y: 100 }, locations: [],
  };
  const location = (id: string, key: string) => ({ id, nameKey: key, tags: [], exits: [], resources: [], hotspots: [] });
  await writeFile(join(content, 'world', 'areas', 'locked_fixture.json'), JSON.stringify(locked));
  await writeFile(join(content, 'world', 'areas', 'hidden_fixture.json'), JSON.stringify(hidden));
  await writeFile(join(content, 'world', 'locations', 'locked_fixture', 'entry.json'),
    JSON.stringify(location('loc:locked_fixture.entry', 'loc.locked_fixture.entry.name')));
  await writeFile(join(content, 'world', 'locations', 'hidden_fixture', 'entry.json'),
    JSON.stringify(location('loc:hidden_fixture.entry', 'loc.hidden_fixture.entry.name')));
  await writeFile(join(content, 'world', 'areas', 'live_fixture_two.json'), JSON.stringify(secondLiveArea));
  await writeFile(join(content, 'world', 'locations', 'live_fixture_two', 'entry.json'),
    JSON.stringify(location(SECOND_LIVE_START, 'loc.live_fixture_two.entry.name')));
  await writeFile(join(content, 'world', 'areas', 'nonstartable_fixture.json'), JSON.stringify(nonstartable));

  await writeFile(join(content, 'world', 'routes', 'sanctuary_to_locked_fixture.json'), JSON.stringify(
    { id: 'route:sanctuary_to_locked_fixture', from: 'area:sanctuary', to: LOCKED_FIXTURE, travel: { mode: 'instant' },
      requires: { game: 'levelAtLeast', level: 99 } }));
  await writeFile(join(content, 'world', 'routes', 'locked_to_hidden_fixture.json'), JSON.stringify(
    { id: 'route:locked_to_hidden_fixture', from: LOCKED_FIXTURE, to: HIDDEN_FIXTURE, travel: { mode: 'instant' } }));
  if (options.gateRegionOne) await writeFile(join(content, 'world', 'routes', 'sanctuary_to_region_1.json'), JSON.stringify(
    { id: 'route:sanctuary_to_region_1', from: 'area:sanctuary', to: 'area:region_1', travel: { mode: 'instant' },
      requires: { areaCompleted: 'area:test_grove' } }));
  await writeFile(join(content, 'world', 'routes', 'region_1_to_live_fixture_two.json'), JSON.stringify(
    { id: 'route:region_1_to_live_fixture_two', from: 'area:region_1', to: SECOND_LIVE_AREA, travel: { mode: 'instant' },
      requires: { areaCompleted: 'area:region_1' } }));
  await writeFile(join(content, 'world', 'routes', 'sanctuary_to_nonstartable_fixture.json'), JSON.stringify(
    { id: 'route:sanctuary_to_nonstartable_fixture', from: 'area:sanctuary', to: NONSTARTABLE_FIXTURE, travel: { mode: 'instant' } }));

  const compiled = compileContentDirectory(content, plugin);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.bundle;
}
