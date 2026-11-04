import { describe, expect, it } from 'vitest';
import { parseExpeditionResultReportDto } from '@rpg/protocol';

import { projectExpeditionResultReport } from './report.ts';

const actorId = 'actor-1';
const row = { actorId, status: 'completed' as const, startsAtMs: 1_000, endsAtMs: 6_000, settledAt: new Date(6_000), outcome: 'failed' as const };

describe('persisted expedition result projection', () => {
  it('projects XP beyond 32 bits (#129) unchanged', () => {
    const big = 4_000_000_000;
    const result = projectExpeditionResultReport({ ...row, outcome: 'completed' }, {
      version: 1, kind: 'settled', reason: 'completed', cutoff: 0, outcome: 'completed', endsAtMs: 6_000,
      summary: { kills: {}, consumablesUsed: {}, hp: [], deathLog: null }, segments: [{ events: [] }], revealedDeltas: [], settledDeltas: [],
      xp: [{ actorId, xpEarned: 30, xpPenaltyLost: 0, xpBefore: big, xpAfter: big + 30 }],
    });
    expect(result.xp).toEqual({ earned: 30, penaltyLost: 0, net: 30, beforeTotal: big, afterTotal: big + 30 });
    expect(result.finalState.xpTotal).toBe(big + 30);
  });

  it('reports actual secured bag totals and actual XP loss without replaying policy', () => {
    const result = projectExpeditionResultReport(row, {
      version: 1, kind: 'settled', reason: 'completed', cutoff: 0, outcome: 'failed', endsAtMs: 6_000,
      summary: { kills: { 'enemy:boar': 2 }, consumablesUsed: { 'item:potion': 1 },
        hp: [{ actorId, maxHp: 30, start: 10, lowest: 0, end: 0 }],
        deathLog: { actorId, encounter: 0, causes: [{ key: 'idle.death.no_consumables' }] } },
      segments: [{ events: [{ type: 'kill', enemy: 'enemy:boar' }, { type: 'death' }] }],
      revealedDeltas: [
        { actorId, asset: { kind: 'currency', currency: 'gold' }, container: null, qty: 10 },
        { actorId, asset: { kind: 'stack', item: 'item:hide' }, container: 'run_bag:expedition', qty: 5 },
        { actorId, asset: { kind: 'stack', item: 'item:potion' }, container: 'escrow:expedition', qty: -1 },
      ],
      settledDeltas: [
        { actorId, asset: { kind: 'currency', currency: 'gold' }, qty: 4 },
        { actorId, asset: { kind: 'stack', item: 'item:hide' }, qty: 2, to: 'inventory' },
        { actorId, asset: { kind: 'stack', item: 'item:potion' }, qty: 1, from: 'escrow' },
        { actorId, asset: { kind: 'stack', item: 'item:potion' }, qty: 2, from: 'escrow', to: 'inventory' },
      ],
      xp: [{ actorId, xpEarned: 20, xpPenaltyLost: 50, xpBefore: 40, xpAfter: 10 }],
    });
    expect(result).toMatchObject({ availability: 'available', effectiveDurationMs: 5_000, outcome: 'failed', enemiesDefeated: 2,
      xp: { earned: 20, penaltyLost: 50, net: -30, beforeTotal: 40, afterTotal: 10 },
      gold: { earned: 10, lost: 6, secured: 4 }, loot: [{ item: 'item:hide', earned: 5, lost: 3, secured: 2 }],
      consumables: [{ item: 'item:potion', used: 1, returned: 2 }], finalState: { hp: 0, maxHp: 30, xpTotal: 10 },
      death: { causes: [{ key: 'idle.death.no_consumables' }], suggestions: ['Consider bringing healing consumables.'] } });
    expect(result.events).toContain('Defeated enemy:boar.');
    expect(result.events).toContain('A character died in combat.');
    expect(JSON.stringify(result)).not.toContain('actor-1');
  });

  it('keeps unavailable recovery facts unknown while reporting recorded escrow returns', () => {
    const result = projectExpeditionResultReport({ ...row, status: 'cancelled', outcome: null }, {
      version: 1, kind: 'escrow_returned', reason: 'version_unavailable', recoveredAtMs: 8_000,
      settledDeltas: [{ actorId, asset: { kind: 'stack', item: 'item:potion' }, qty: 2, from: 'escrow', to: 'inventory' }],
      summary: null, segments: [], revealedDeltas: {}, xp: [], cutoff: null,
    });
    expect(result).toMatchObject({ availability: 'returned_escrow', effectiveDurationMs: null, outcome: 'version_unavailable',
      enemiesDefeated: null, xp: { earned: null, penaltyLost: null, net: null }, gold: { earned: null, lost: null, secured: null },
      loot: null, consumables: [{ item: 'item:potion', used: null, returned: 2 }], events: null,
      finalState: { hp: null, maxHp: null, xpTotal: null }, death: null });
  });

  it('does not rebuild legacy terminal data from end time or present arrays as known empty', () => {
    const result = projectExpeditionResultReport(row, null);
    expect(result).toMatchObject({ availability: 'legacy_unavailable', effectiveDurationMs: null, enemiesDefeated: null,
      loot: null, consumables: null, events: null, xp: { earned: null, penaltyLost: null }, gold: { earned: null, lost: null } });
  });

  it('keeps a 30-day-old escrow recovery readable without inventing a duration', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1_000;
    const result = projectExpeditionResultReport({ ...row, startsAtMs: 1 }, {
      version: 1, kind: 'escrow_returned', reason: 'version_unavailable', recoveredAtMs: thirtyDays + 1,
      settledDeltas: [{ actorId, asset: { kind: 'stack', item: 'item:potion' }, qty: 2, from: 'escrow', to: 'inventory' }],
      summary: null, segments: [], revealedDeltas: [], xp: [], cutoff: null,
    });
    expect(result).toMatchObject({ availability: 'returned_escrow', effectiveDurationMs: null,
      consumables: [{ item: 'item:potion', used: null, returned: 2 }] });
    expect(() => parseExpeditionResultReportDto(result)).not.toThrow();
  });

  it('does not interpret future report versions as version 1', () => {
    const result = projectExpeditionResultReport(row, {
      version: 99, kind: 'settled', endsAtMs: 6_000, summary: { kills: { 'enemy:boar': 7 } },
      segments: [], revealedDeltas: [{ actorId, asset: { kind: 'currency', currency: 'gold' }, container: null, qty: 99 }],
      settledDeltas: [], xp: [{ actorId, xpEarned: 99, xpPenaltyLost: 0 }], outcome: 'completed',
    });
    expect(result).toMatchObject({ availability: 'legacy_unavailable', effectiveDurationMs: null, enemiesDefeated: null,
      xp: { earned: null }, gold: { earned: null }, events: null });
  });

  it('does not turn partial or overflowing stored totals into known zero', () => {
    const partial = projectExpeditionResultReport(row, {
      version: 1, kind: 'settled', endsAtMs: 6_000, outcome: 'failed',
      summary: { kills: { 'enemy:boar': 2, 'enemy:missing': 'bad' }, consumablesUsed: { 'item:potion': 1 } },
      segments: [], revealedDeltas: [
        { actorId, asset: { kind: 'currency', currency: 'gold' }, container: null, qty: 10 },
        { actorId, asset: { kind: 'stack', item: 'item:hide' }, container: 'run_bag:x', qty: 'bad' },
      ], settledDeltas: [], xp: [],
    });
    expect(partial).toMatchObject({ enemiesDefeated: null, gold: { earned: null, lost: null, secured: 0 }, loot: null });
    expect(() => parseExpeditionResultReportDto(partial)).not.toThrow();

    const overflow = projectExpeditionResultReport(row, {
      version: 1, kind: 'settled', endsAtMs: 6_000, outcome: 'failed',
      summary: { kills: { a: 2_147_483_647, b: 1 }, consumablesUsed: {} }, segments: [],
      revealedDeltas: [
        { actorId, asset: { kind: 'currency', currency: 'gold' }, container: null, qty: 2_147_483_647 },
        { actorId, asset: { kind: 'currency', currency: 'gold' }, container: null, qty: 1 },
      ], settledDeltas: [], xp: [],
    });
    expect(overflow).toMatchObject({ enemiesDefeated: null, gold: { earned: null } });
    expect(() => parseExpeditionResultReportDto(overflow)).not.toThrow();
  });
});
