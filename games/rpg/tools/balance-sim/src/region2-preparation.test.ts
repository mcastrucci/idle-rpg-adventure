import { describe, expect, it } from 'vitest';

import { loadBalanceContent } from './content.ts';
import { renderRegion2PreparationMarkdown, runRegion2Preparation } from './region2.ts';
import { runCli } from './cli.ts';

describe('current Region 2 preparation measurement', () => {
  const content = loadBalanceContent();

  it('uses same-level production starter snapshots and separates gear from supplies', () => {
    const report = runRegion2Preparation(content, 24, 2);
    const inputs = Object.fromEntries(report.cohortInputs.map((input) => [input.cohort.key, input]));

    expect(report.level).toBe(4);
    expect(report.xpRequiredForLevel).toBe(800);
    expect(report.attributes).toEqual({ STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 });
    expect(report.cohortInputs.map((input) => input.cohort.key)).toEqual(['fresh', 'gear-only', 'supplies-only', 'prepared']);
    expect(inputs.fresh?.gear).toEqual(inputs['supplies-only']?.gear);
    expect(inputs['gear-only']?.gear).toEqual(inputs.prepared?.gear);
    expect(inputs.fresh?.inventory).toEqual(inputs['gear-only']?.inventory);
    expect(inputs['supplies-only']?.inventory).toEqual(inputs.prepared?.inventory);
    expect(inputs['gear-only']?.gear).toContain('item:sapforged_blade');
    expect(inputs['gear-only']?.gear).toContain('item:heartwood_buckler');
    expect(inputs['gear-only']?.gear).toContain('item:lantern_lens');
    expect(report.statsByCohort.fresh?.attributes).toEqual(report.attributes);
    expect(report.statsByCohort.prepared?.attributes).toEqual(report.attributes);
    expect(report.statsByCohort.prepared?.power).toBeGreaterThan(report.statsByCohort.fresh?.power ?? 0);
    expect(report.statsByCohort.prepared?.maxHp).toBeGreaterThan(report.statsByCohort.fresh?.maxHp ?? 0);
    expect(report.rows.filter((row) => row.group === 'warden')).toHaveLength(4);
    expect(report.rows.every((row) => row.stats.runs === 2)).toBe(true);
    expect(inputs.fresh?.commonRules).toHaveLength(6);
    expect(inputs.fresh?.commonRules).toEqual(inputs.prepared?.commonRules);
  });

  it('reproduces report bytes for the same paired seeds', () => {
    const first = renderRegion2PreparationMarkdown(runRegion2Preparation(content, 24, 3));
    const second = renderRegion2PreparationMarkdown(runRegion2Preparation(content, 24, 3));
    expect(second).toBe(first);
    expect(first).toContain('fresh-struggles / prepared-succeeds');
    expect(first).toContain('not the server’s five-rule default automation');
  });

  it('computes the level threshold from the compiled XP curve', () => {
    const curve = content.progression;
    if (curve === undefined) throw new Error('compiled content has no progression curve');
    const changedCurve = { ...content, progression: { ...curve, xpToNext: [110, ...curve.xpToNext.slice(1)] } };
    expect(runRegion2Preparation(content, 24, 1).xpRequiredForLevel).toBe(800);
    expect(runRegion2Preparation(changedCurve, 24, 1).xpRequiredForLevel).toBe(810);
  });

  it('keeps the preparation report behind an explicit CLI scenario', async () => {
    let output = '';
    const code = await runCli(['--scenario', 'region-2-preparation', '--runs', '1', '--seed', '24'], {
      cwd: process.cwd(),
      stdout: (text) => { output = text; },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(output).toContain('# Region 2 current preparation measurement');
    expect(output).toContain('region-2-preparation');
  });
});
