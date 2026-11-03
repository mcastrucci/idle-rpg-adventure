import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import plugin from '@rpg/content-plugin';

export const LOCKED_FIXTURE = 'area:locked_fixture';
export const HIDDEN_FIXTURE = 'area:hidden_fixture';

/** Build a private graph by adding authored source files, then compiling the full content directory normally. */
export async function compileWorldViewFixture(directory: string): Promise<ContentBundle> {
  const source = fileURLToPath(new URL('../../../../content', import.meta.url));
  const content = join(directory, 'content');
  await cp(source, content, { recursive: true });
  await mkdir(join(content, 'world', 'areas'), { recursive: true });
  await mkdir(join(content, 'world', 'locations', 'locked_fixture'), { recursive: true });
  await mkdir(join(content, 'world', 'locations', 'hidden_fixture'), { recursive: true });

  const locked = {
    id: LOCKED_FIXTURE, kind: 'explorable', nameKey: 'area.locked_fixture.name', difficulty: 1, recommendedLevel: [1, 3],
    mapPosition: { x: 400, y: 100 }, startLocation: 'loc:locked_fixture.entry', locations: ['loc:locked_fixture.entry'],
    revealedBy: { game: 'levelAtLeast', level: 1 },
  };
  const hidden = {
    id: HIDDEN_FIXTURE, kind: 'explorable', nameKey: 'area.hidden_fixture.private_name', difficulty: 1, recommendedLevel: [2, 4],
    mapPosition: { x: 600, y: 100 }, startLocation: 'loc:hidden_fixture.entry', locations: ['loc:hidden_fixture.entry'],
  };
  const location = (id: string, key: string) => ({ id, nameKey: key, tags: [], exits: [], resources: [], hotspots: [] });
  await writeFile(join(content, 'world', 'areas', 'locked_fixture.json'), JSON.stringify(locked));
  await writeFile(join(content, 'world', 'areas', 'hidden_fixture.json'), JSON.stringify(hidden));
  await writeFile(join(content, 'world', 'locations', 'locked_fixture', 'entry.json'),
    JSON.stringify(location('loc:locked_fixture.entry', 'loc.locked_fixture.entry.name')));
  await writeFile(join(content, 'world', 'locations', 'hidden_fixture', 'entry.json'),
    JSON.stringify(location('loc:hidden_fixture.entry', 'loc.hidden_fixture.entry.name')));

  await writeFile(join(content, 'world', 'routes', 'sanctuary_to_locked_fixture.json'), JSON.stringify(
    { id: 'route:sanctuary_to_locked_fixture', from: 'area:sanctuary', to: LOCKED_FIXTURE, travel: { mode: 'instant' },
      requires: { game: 'levelAtLeast', level: 99 } }));
  await writeFile(join(content, 'world', 'routes', 'locked_to_hidden_fixture.json'), JSON.stringify(
    { id: 'route:locked_to_hidden_fixture', from: LOCKED_FIXTURE, to: HIDDEN_FIXTURE, travel: { mode: 'instant' } }));
  await writeFile(join(content, 'world', 'routes', 'sanctuary_to_region_1.json'), JSON.stringify(
    { id: 'route:sanctuary_to_region_1', from: 'area:sanctuary', to: 'area:region_1', travel: { mode: 'instant' },
      requires: { areaCompleted: 'area:test_grove' } }));

  const compiled = compileContentDirectory(content, plugin);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.bundle;
}
