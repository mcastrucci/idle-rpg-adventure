import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NO_INPUTS, ENGINE_VERSION, runToEnd } from '@rpg/rpg-sim';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBalanceContent } from './content.ts';
import { formatBp, formatX100, percentile, ratioBp } from './math.ts';
import { attentiveLivePolicy } from './policies.ts';
import { renderCsv, renderJson, renderMarkdown } from './report.ts';
import { runBalance } from './run.ts';
import type { BalanceConfig } from './run.ts';
import { REGION_1_SCENARIO, THORNBLADE } from './scenario.ts';
import { HERO_ID, distinctGroups, heroBuild } from './simulate.ts';
import { evaluateTargets } from './targets.ts';
import { runCli } from './cli.ts';
import { SYNTHETIC_CONTENT, SYNTHETIC_SCENARIO } from './testing/synthetic.ts';

const TINY: BalanceConfig = {
  seedRoot: 24,
  runs: 3,
  hours: 1,
  levels: [1, 3],
  bossLevels: [4],
  hourLevels: [4],
  idleRegenBp: 1500,
  sections: ['cells', 'boss', 'hourly'],
};

describe('math helpers', () => {
  it('formats bp and hundredths with integer math', () => {
    expect(formatBp(9750)).toBe('97.50%');
    expect(formatBp(5)).toBe('0.05%');
    expect(formatX100(125)).toBe('1.25');
    expect(formatX100(-7)).toBe('-0.07');
    expect(ratioBp(1, 3)).toBe(3333);
    expect(ratioBp(1, 0)).toBe(0);
  });

  it('uses nearest-rank percentiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 10)).toBe(1);
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('synthetic scenario (known outcomes)', () => {
  const report = runBalance(SYNTHETIC_CONTENT, SYNTHETIC_SCENARIO, { ...TINY, runs: 5, hours: 2, levels: [1], bossLevels: [1], hourLevels: [1] });

  it('kills the 1-HP dummy on tick 1 every time and loses to the brute every time', () => {
    const easy = report.cells.find((c) => c.group.key === 'enemy:t_dummy×1');
    const hard = report.cells.find((c) => c.group.key === 'enemy:t_brute×1');
    expect(easy?.stats).toMatchObject({ runs: 5, wins: 5, deaths: 0, winBp: 10000, ttkP10: 1, ttkP50: 1, ttkP90: 1, hpLostBp: 0 });
    expect(hard?.stats).toMatchObject({ runs: 5, wins: 0, deaths: 5, winBp: 0, ttkP50: null, hpLostBp: 10000 });
    expect(report.boss.map((b) => [b.mode, b.stats.winBp, b.stats.deaths])).toEqual([
      ['auto', 0, 5],
      ['live', 0, 5],
    ]);
  });

  it('accumulates XP, gold and loot per hour and stops an hour at the first death', () => {
    const easy = report.hourly.find((h) => h.activity === 'idle:t_easy');
    const hard = report.hourly.find((h) => h.activity === 'idle:t_hard');
    // 10 fights × (7 XP, 2 gold, one trinket worth 3).
    expect(easy).toMatchObject({ xpPerHour: 70, enemyGoldPerHour: 20, vendorPerHour: 30, grossGoldPerHour: 50, deathsPerHourBp: 0, fightsPerHourX100: 1000 });
    expect(hard).toMatchObject({ xpPerHour: 0, deathsPerHourBp: 10000, fightsPerHourX100: 100 });
    // The live route skips brute-only groups, so it only ever meets the dummy: 4 fights × 7 XP.
    const live = report.hourly.find((h) => h.activity === 'live:route');
    expect(live).toMatchObject({ xpPerHour: 28, deathsPerHourBp: 0, fightsPerHourX100: 400 });
  });
});

describe('Region 1', () => {
  const content = loadBalanceContent();

  it('derives the distinct non-boss groups of the Region 1 tables', () => {
    const groups = distinctGroups(content, REGION_1_SCENARIO.cellTables);
    expect(groups.length).toBe(12);
    expect(groups.some((g) => g.members.some((m) => m.enemy === 'enemy:hollow_matriarch'))).toBe(false);
    expect(groups.map((g) => g.key)).toContain('enemy:glowcap_mite×1+enemy:thornback_boar×1');
  });

  it('is deterministic: the same inputs give an identical report, another seed root changes it', () => {
    const a = runBalance(content, REGION_1_SCENARIO, TINY);
    const b = runBalance(content, REGION_1_SCENARIO, TINY);
    expect(renderMarkdown(b)).toBe(renderMarkdown(a));
    expect(renderJson(b)).toBe(renderJson(a));
    const c = runBalance(content, REGION_1_SCENARIO, { ...TINY, seedRoot: 25 });
    expect(renderJson(c)).not.toBe(renderJson(a));
  });

  it('the attentive live script pre-empts the Matriarch telegraph with guard', () => {
    const build = heroBuild(THORNBLADE, 5, content);
    const setup = {
      heroes: [{ id: HERO_ID, build, skills: THORNBLADE.bossLoadout.skills, rules: THORNBLADE.bossLoadout.rules }],
      enemies: [{ id: 'enemy:m#1', enemy: 'enemy:hollow_matriarch' }],
      content: content.combat,
    };
    const crushes = (policy: Parameters<typeof runToEnd>[2]): number[] =>
      runToEnd(setup, 11, policy, 3000).events.flatMap((e) =>
        e.type === 'DamageDealt' && e.origin === 'skill:crushing_blow' && !e.periodic ? [e.amount] : [],
      );
    const live = runToEnd(setup, 11, attentiveLivePolicy({ heroId: HERO_ID, guard: 'skill:guard' }), 3000);
    const manualGuards = live.events.filter(
      (e) => e.type === 'ActionStarted' && e.actorId === HERO_ID && e.source === 'manual' && e.action.kind === 'skill' && e.action.skill === 'skill:guard',
    );
    expect(manualGuards.length).toBeGreaterThan(0);
    const liveHits = crushes(attentiveLivePolicy({ heroId: HERO_ID, guard: 'skill:guard' }));
    const autoHits = crushes(NO_INPUTS);
    // Every live crushing blow lands on a guarded hero: all hits are at most the smallest automation hit.
    expect(Math.max(...liveHits)).toBeLessThanOrEqual(Math.min(...autoHits));
    expect(Math.max(...autoHits)).toBeGreaterThan(Math.max(...liveHits));
  });
});

describe('report formatting', () => {
  const report = runBalance(SYNTHETIC_CONTENT, SYNTHETIC_SCENARIO, { ...TINY, runs: 2, hours: 1, levels: [1], bossLevels: [1], hourLevels: [1] });

  it('prints ENGINE_VERSION, contentHash, seed root and N in the Markdown header', () => {
    const md = renderMarkdown(report);
    expect(md).toContain(`| ENGINE_VERSION | ${ENGINE_VERSION} |`);
    expect(md).toContain('| contentHash | `synthetic` |');
    expect(md).toContain('| seed root | 24 |');
    expect(md).toContain('| N (fights per cell, attempts per boss row) | 2 |');
    expect(md).toContain('| t_dummy | 1 | tester | 1 | 100.00% | 1 / 1 / 1 | 0.00% | 0.00 | 0 | 0 |');
    expect(md).toContain('| t_brute | 1 | tester | 1 | 0.00% | – / – / – | 100.00% | 0.00 | 2 | 0 |');
    expect(md).toMatch(/PASS \d+ · WARN \d+ · N\/A \d+/);
  });

  it('emits CSV blocks and parseable JSON with the same header', () => {
    const csv = renderCsv(report);
    expect(csv.split('\n\n').map((b) => b.split('\n')[0])).toEqual(['# header', '# cells', '# boss', '# hourly', '# targets']);
    expect(csv).toContain(`ENGINE_VERSION,${ENGINE_VERSION}`);
    expect(csv).toContain('t_dummy,1,tester,1,2,2,0,0,10000,1,1,1,0,0');
    const json = JSON.parse(renderJson(report)) as { header: { engineVersion: string; seedRoot: number; runs: number }; targets: unknown[] };
    expect(json.header).toMatchObject({ engineVersion: ENGINE_VERSION, seedRoot: 24, runs: 2 });
    expect(Array.isArray(json.targets)).toBe(true);
  });

  it('turns targets into PASS/WARN/N/A rows only', () => {
    const checks = evaluateTargets(report);
    expect(checks.every((c) => ['PASS', 'WARN', 'N/A'].includes(c.status))).toBe(true);
    expect(checks.filter((c) => c.status === 'N/A').length).toBeGreaterThan(0);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'balance-sim-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await runCli(argv, { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) });
    return { code, out, err };
  }

  it('runs Region 1 end to end with a tiny N (smoke)', async () => {
    const args = ['--runs', '2', '--hours', '1', '--levels', '1,3', '--boss-levels', '4', '--hour-levels', '4'];
    const md = await cli(args);
    expect(md.code).toBe(0);
    expect(md.out).toContain(`| ENGINE_VERSION | ${ENGINE_VERSION} |`);
    expect(md.out).toMatch(/\| contentHash \| `[0-9a-f]{64}` \|/);
    for (const h of ['## Encounter groups', '## Mini-boss attempts', '## XP and gold per hour', '## Targets']) expect(md.out).toContain(h);
    const again = await cli(args);
    expect(again.out).toBe(md.out);
    const json = await cli([...args, '--format', 'json', '--sections', 'boss', '--out', 'r.json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')) as { cells: unknown[]; boss: unknown[] };
    expect(parsed.cells).toEqual([]);
    expect(parsed.boss.length).toBe(4);
  });

  it('rejects bad arguments with exit code 2 and prints help with 0', async () => {
    expect((await cli(['--format', 'xml'])).code).toBe(2);
    expect((await cli(['--levels', '3-1'])).code).toBe(2);
    expect((await cli(['--runs', 'many'])).code).toBe(2);
    expect((await cli(['--sections', 'cells,loot'])).code).toBe(2);
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: balance-sim');
  });

  it('exits 1 when the content root does not compile', async () => {
    const res = await cli(['--content', path.join(dir, 'missing')]);
    expect(res.code).toBe(1);
  });
});
