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

  it('accepts XP beyond 32 bits (open-ended curve, #129) but keeps gold and counters 32-bit bounded', () => {
    const big = 5_000_000_000;
    const parsed = parseExpeditionResultReportDto({ ...available, xp: { earned: 12, penaltyLost: big, net: -big + 12, beforeTotal: big * 2, afterTotal: big },
      finalState: { hp: 0, maxHp: 24, xpTotal: big } });
    expect(parsed.xp).toEqual({ earned: 12, penaltyLost: big, net: -big + 12, beforeTotal: big * 2, afterTotal: big });
    expect(() => parseExpeditionResultReportDto({ ...available, xp: { ...available.xp, afterTotal: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
    expect(() => parseExpeditionResultReportDto({ ...available, gold: { earned: big, lost: 0, secured: 0 } })).toThrow();
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
});
