import { describe, expect, it } from 'vitest';

import { renderBalanceLiveStarterKitComparison, resolveLiveStarterKit, runBalanceLive, runBalanceLiveStarterKitComparison } from '../../scripts/balance-live.ts';

const report = runBalanceLive({ runs: 1 });

describe('bounded production live balance trace', () => {
  it('uses the finite authored route, actual rolled groups, and returns with the accumulated run bag', () => {
    const run = report.diagnostic;
    expect(run.status).toBe('returned');
    expect(run.ticks).toBeGreaterThan(0);
    expect(run.xpGranted).toBeGreaterThan(0);
    expect(run.bagDisposition).toBe('recovered_on_return');
    expect(run.location).toBe('loc:region_1.portal_clearing');
    const commands = run.trace.filter(step => step.kind === 'command').map(step => step.command as { type: string; groupId?: string });
    const engaged = commands.filter(command => command.type === 'engage').map(command => command.groupId)
      .filter((groupId): groupId is string => groupId !== undefined);
    expect(engaged).toHaveLength(8);
    expect(engaged.filter(id => id.startsWith('loc:region_1.overgrown_causeway/'))).toHaveLength(2);
    expect(new Set(engaged).size).toBe(8);
    expect(commands.filter(command => command.type === 'returnToSanctuary')).toHaveLength(1);
    expect(commands.at(-1)).toEqual({ type: 'returnToSanctuary' });
    expect(report.rows).toHaveLength(6);
    expect(report.rows.every(row => row.returned + row.dead + row.censored === report.runsPerCell)).toBe(true);
    expect(report.rows.some(row => row.dead > 0)).toBe(true);
    expect(report.rows.every(row => row.rates.every(rate => Number.isFinite(rate.xpPerHour)))).toBe(true);
  });

  it('uses only the finite provisioned potion supply and records its real consumption', () => {
    const supplied = report.rows.filter(row => row.carriedPotions === 5);
    expect(supplied).toHaveLength(3);
    expect(supplied.some(row => row.meanPotionsUsed > 0)).toBe(true);
    expect(supplied.every(row => row.meanPotionsUsed <= 5)).toBe(true);
  });

  it('resolves production kit slots and rejects a missing or incorrectly slotted item', () => {
    const comparison = runBalanceLiveStarterKitComparison({ runs: 1 });
    expect(comparison.equipment.map(({ id, slot }) => [id, slot])).toEqual([
      ['item:rusty_sword', 'weapon'], ['item:padded_vest', 'chest'], ['item:wooden_buckler', 'offhand'],
    ]);
    expect(comparison.equipment.every(item => Object.keys(item.stats).length > 0)).toBe(true);
    expect(() => resolveLiveStarterKit([])).toThrow(/starter kit item item:rusty_sword/);
    expect(() => resolveLiveStarterKit([
      { id: 'item:rusty_sword', kind: 'equipment', slot: 'chest', value: 0, stats: {}, stackable: false },
    ])).toThrow(/not in slot weapon/);
  });

  it('reports deterministic paired live rows with matching routes, rules, levels and provisions', () => {
    const first = runBalanceLiveStarterKitComparison({ runs: 1 });
    const second = runBalanceLiveStarterKitComparison({ runs: 1 });
    expect(renderBalanceLiveStarterKitComparison(first)).toBe(renderBalanceLiveStarterKitComparison(second));
    expect(first.rows).toHaveLength(6);
    expect(first.rows.every(row => row.naked.level === row.starterKit.level &&
      row.naked.carriedPotions === row.starterKit.carriedPotions &&
      row.naked.returned + row.naked.dead + row.naked.censored === 1 &&
      row.starterKit.returned + row.starterKit.dead + row.starterKit.censored === 1)).toBe(true);
    const noSupplyL1 = first.rows.find(row => row.level === 1 && row.carriedPotions === 0);
    expect(noSupplyL1?.starterKit.meanCombatTicks).not.toBe(noSupplyL1?.naked.meanCombatTicks);
    expect(runBalanceLive({ runs: 1 }).rows).toHaveLength(6);
  });
});
