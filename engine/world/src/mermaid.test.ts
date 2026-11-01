import { describe, expect, it } from 'vitest';

import { areaToMermaid, worldToMermaid } from './mermaid.ts';
import type { Area } from './schemas.ts';
import { R1, rpgWorld, survivalWorld } from './testing/fixtures.ts';

describe('mermaid export', () => {
  it('renders the world map with hubs, gated routes and timed travel', () => {
    expect(worldToMermaid(rpgWorld())).toBe(
      [
        'graph LR',
        '  area_sanctuary(("area:sanctuary<br/>hub"))',
        '  area_region_1["area:region_1<br/>explorable"]',
        '  area_region_2["area:region_2<br/>explorable"]',
        '  area_sanctuary -- "route:sanctuary_to_region_1" --> area_region_1',
        '  area_sanctuary -- "route:sanctuary_to_region_2<br/>requires areaCompleted:area:region_1" --> area_region_2',
        '',
      ].join('\n'),
    );
    expect(worldToMermaid(survivalWorld())).toContain('route:shelter_to_market<br/>timed 15min');
  });

  it('renders an area graph with start, secret locations and dotted secret exits', () => {
    const world = rpgWorld();
    const out = areaToMermaid(world.areas.find((a) => a.id === R1) as Area, world.locations);
    expect(out).toContain('  loc_region_1_c0(("loc:region_1.c0<br/>ordinary"))');
    expect(out).toContain('  loc_region_1_hidden_grotto["loc:region_1.hidden_grotto<br/>secret"]:::secret');
    expect(out).toContain('  loc_region_1_c5 -. "exit:region_1.c5_secret" .-> loc_region_1_hidden_grotto');
    expect(out).toContain('  loc_region_1_c0 -- "exit:region_1.c0_fwd" --> loc_region_1_c1');
  });
});
