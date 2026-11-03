import { describe, expect, it } from 'vitest';

import { runBalanceLive } from '../../scripts/balance-live.ts';

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
});
