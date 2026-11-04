import { describe, expect, it } from 'vitest';

import { parseExpeditionResultReportDto } from './expedition-report.ts';

const available = {
  availability: 'available', effectiveDurationMs: 300_000, outcome: 'failed', enemiesDefeated: 2,
  xp: { earned: 12, penaltyLost: 4, net: 8, beforeTotal: 50, afterTotal: 58 },
  gold: { earned: 5, lost: 2, secured: 3 },
  loot: [{ item: 'item:hide', earned: 3, lost: 1, secured: 2 }],
  consumables: [{ item: 'item:potion', used: 1, returned: 2 }], events: ['Defeated enemy:boar.'],
  finalState: { hp: 0, maxHp: 24, xpTotal: 58 },
  death: { causes: [{ key: 'idle.death.no_consumables' }], suggestions: ['Consider bringing healing consumables.'] },
} as const;

describe('expedition result report protocol', () => {
  it('parses and freezes the safe report projection', () => {
    const parsed = parseExpeditionResultReportDto(available);
    expect(parsed).toMatchObject(available);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.loot)).toBe(true);
    expect(Object.isFrozen(parsed.death?.causes)).toBe(true);
  });

  it('preserves null unknown values separately from known empty lists', () => {
    const unavailable = parseExpeditionResultReportDto({
      availability: 'legacy_unavailable', effectiveDurationMs: null, outcome: 'cancelled', enemiesDefeated: null,
      xp: { earned: null, penaltyLost: null, net: null, beforeTotal: null, afterTotal: null },
      gold: { earned: null, lost: null, secured: null }, loot: null, consumables: null, events: null,
      finalState: { hp: null, maxHp: null, xpTotal: null }, death: null,
    });
    expect(unavailable.loot).toBeNull();
    expect(parseExpeditionResultReportDto({ ...available, loot: [], consumables: [], events: [], death: null }).loot).toEqual([]);
  });

  it('rejects internal fields and oversized event arrays', () => {
    expect(() => parseExpeditionResultReportDto({ ...available, seed: 'private' })).toThrow('invalid expedition report');
    expect(() => parseExpeditionResultReportDto({ ...available, events: Array(51).fill('event') })).toThrow('invalid expedition report');
    expect(() => parseExpeditionResultReportDto({ ...available, xp: { ...available.xp, penaltyLost: -1 } })).toThrow('invalid expedition report XP');
  });

  it('parses additive i18n code fields and stays compatible with servers that omit them', () => {
    const withCodes = {
      ...available,
      eventCodes: [{ code: 'idle.event.kill', params: { enemy: 'enemy:boar' } }],
      death: { ...available.death, suggestionCodes: [{ code: 'idle.suggestion.bring_healing' }] },
    };
    const parsed = parseExpeditionResultReportDto(withCodes);
    expect(parsed.eventCodes).toEqual([{ code: 'idle.event.kill', params: { enemy: 'enemy:boar' } }]);
    expect(parsed.death?.suggestionCodes).toEqual([{ code: 'idle.suggestion.bring_healing' }]);
    expect(Object.isFrozen(parsed.eventCodes)).toBe(true);
    expect(parseExpeditionResultReportDto(available).eventCodes).toBeUndefined();
    expect(parseExpeditionResultReportDto({ ...available, events: null, eventCodes: null }).eventCodes).toBeNull();
  });

  it('rejects malformed, misaligned or oversized code fields', () => {
    const bad = (eventCodes: unknown) => () => parseExpeditionResultReportDto({ ...available, eventCodes });
    expect(bad([{ code: 'Not A Code' }])).toThrow('invalid expedition report codes');
    expect(bad([{ code: 'idle.event.kill', params: { enemy: { nested: 1 } } }])).toThrow('invalid expedition report codes');
    expect(bad([{ code: 'idle.event.kill', extra: true }])).toThrow('invalid expedition report');
    expect(bad([{ code: 'idle.event.death' }, { code: 'idle.event.death' }])).toThrow('invalid expedition report codes');
    expect(() => parseExpeditionResultReportDto({ ...available, death: { ...available.death, suggestionCodes: [] } })).toThrow('invalid expedition report codes');
  });
});
