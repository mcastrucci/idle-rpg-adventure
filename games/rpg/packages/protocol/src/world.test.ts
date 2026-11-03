import { describe, expect, it } from 'vitest';

import { parseWorldViewDto } from './world.ts';

const valid = {
  hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
  areas: [{ id: 'area:region_1', label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
    completion: { discovered: 0, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false,
      bosses: [{ label: 'Mandatory boss', defeated: false }] } },
    danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: false, activities: [] },
    actions: { enterLive: true, startIdle: false } }],
  routes: [],
};
const validArea = valid.areas[0];
if (!validArea) throw new Error('valid world fixture must contain an area');

describe('world view protocol', () => {
  it('parses a bounded, filtered world view', () => {
    expect(parseWorldViewDto(valid)).toMatchObject(valid);
  });

  it.each([
    { ...valid, areas: [{ ...validArea, position: { x: 1_000_001, y: 0 } }] },
    { ...valid, areas: [{ ...validArea, completion: { ...validArea.completion, discovered: 1_000_001 } }] },
    { ...valid, areas: [{ ...validArea, danger: { status: 'known', minLevel: 0, maxLevel: 5 } }] },
    { ...valid, hub: { ...valid.hub, position: { x: Number.POSITIVE_INFINITY, y: 0 } } },
    { ...valid, extra: 'raw-content' },
    { ...valid, areas: Array.from({ length: 513 }, () => validArea) },
  ])('rejects invalid bounds or unexpected content', (input) => {
    expect(() => parseWorldViewDto(input)).toThrow();
  });
});
