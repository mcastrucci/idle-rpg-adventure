import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NO_INPUTS, ENGINE_VERSION, runToEnd } from '@rpg/rpg-sim';
import { AutomationRulesSchema, ItemSchema } from '@rpg/rpg-schema';
import { afterAll, describe, expect, it } from 'vitest';

import { loadBalanceContent } from './content.ts';
import { formatBp, formatX100, percentile, ratioBp } from './math.ts';
import { attentiveLivePolicy } from './policies.ts';
import { renderCsv, renderJson, renderMarkdown } from './report.ts';
import { runBalance } from './run.ts';
import type { BalanceConfig } from './run.ts';
import { BULWARK, REGION_1_SCENARIO, THORNBLADE } from './scenario.ts';
import { HERO_ID, distinctGroups, fight, heroBuild, toGroup } from './simulate.ts';
import { renderRegion2Markdown, runRegion2Balance, validateCohortGear } from './region2.ts';
import { evaluateTargets } from './targets.ts';
import { runCli } from './cli.ts';
import { SYNTHETIC_BUILD, SYNTHETIC_CONTENT, SYNTHETIC_SCENARIO } from './testing/synthetic.ts';

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

describe('Region 2 measurement cohorts', () => {
  const content = loadBalanceContent();

  it('compares paired L4/L5 cohorts and reports same-seed output deterministically', () => {
    const a = runRegion2Balance(content, 24, 2, ['cells', 'boss']);
    const b = runRegion2Balance(content, 24, 2, ['cells', 'boss']);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.cohortInputs.map((x) => x.cohort.key)).toContain('l5-farmed-no-healing');
    expect(a.cohortInputs.map((x) => x.cohort.key)).toContain('l5-farmed-no-tonic');
    expect(a.boss.some((r) => r.mode === 'auto')).toBe(true);
    expect(a.boss.some((r) => r.mode === 'live')).toBe(true);
  });

  it('uses only the specified obtainable gear and rejects gear above cohort level', () => {
    const gear = { ...BULWARK, gearByLevel: () => ['item:rusty_sword', 'item:padded_vest', 'item:wooden_buckler'] };
    validateCohortGear(content, gear, 4);
    const rustySword = content.combat.items['item:rusty_sword'];
    if (rustySword === undefined) throw new Error('missing R1 starter sword in compiled content');
    const overLevelContent = {
      ...content,
      combat: {
        ...content.combat,
        items: {
          ...content.combat.items,
          'item:rusty_sword': { ...rustySword, levelRequired: 5 },
        },
      },
    };
    expect(() => validateCohortGear(overLevelContent, gear, 4)).toThrow(/above cohort level/);
  });

  it('passes a mixed inventory to shared combat and reports per-item consumption', () => {
    const tonic = ItemSchema.parse({
      id: 'item:t_tonic', kind: 'consumable', value: 1, stackable: true, maxStack: 20,
      use: [{ type: 'heal', coeffBp: 3000, to: 'self' }],
    });
    const mixedContent = { ...SYNTHETIC_CONTENT, combat: { ...SYNTHETIC_CONTENT.combat, items: { ...SYNTHETIC_CONTENT.combat.items, [tonic.id]: tonic } } };
    const testBuild = { ...SYNTHETIC_BUILD, loadout: { skills: ['skill:t_hit'], rules: AutomationRulesSchema.parse([{ when: {}, do: { useConsumable: tonic.id } }, { when: {}, do: { useSkill: 'skill:t_hit' } }]) } };
    const build = heroBuild(testBuild, 1, mixedContent);
    const result = fight({
      content: mixedContent,
      build,
      loadout: testBuild.loadout,
      group: toGroup({ enemies: [{ enemy: 'enemy:t_dummy', count: 1 }] }, mixedContent),
      potion: 'item:t_potion',
      potions: 0,
      inventory: [{ item: 'item:t_potion', qty: 2 }, { item: tonic.id, qty: 1 }],
      policy: NO_INPUTS,
      seed: 24,
    });
    expect(result.inventoryUsed?.[tonic.id]).toBe(1);
    expect(result.inventoryUsed?.['item:t_potion']).toBe(0);
  });

  it('measures R2 consumable policies and Warden guard/DoT counter-effects in real event traces', () => {
    const report = runRegion2Balance(content, 24, 1, ['boss']);
    const bulwarkInput = report.cohortInputs.find((x) => x.cohort.key === 'fresh-l4' && x.build === 'bulwark');
    const input = report.cohortInputs.find((x) => x.cohort.key === 'fresh-l4' && x.build === 'thornblade');
    if (bulwarkInput === undefined) throw new Error('missing fresh Bulwark cohort input');
    if (input === undefined) throw new Error('missing fresh Thornblade cohort input');
    expect(bulwarkInput.bossRules).toHaveLength(6);
    expect(bulwarkInput.bossRules.some((r) => 'useSkill' in r.do && r.do.useSkill === 'skill:guard')).toBe(true);
    expect(bulwarkInput.bossRules.some((r) => 'useSkill' in r.do && r.do.useSkill === 'skill:mend' && r.when.selfHpBelowBp === 5500)).toBe(true);
    expect(bulwarkInput.bossRules.some((r) => 'useSkill' in r.do && r.do.useSkill === 'skill:shield_bash')).toBe(false);
    expect(input.commonRules).toHaveLength(6);
    expect(input.bossRules).toHaveLength(6);
    expect(input.bossRules.some((r) => 'useConsumable' in r.do && r.do.useConsumable === 'item:sap_tonic')).toBe(true);
    expect(input.bossRules.some((r) => 'useConsumable' in r.do && r.do.useConsumable === 'item:healing_potion')).toBe(true);
    const build = heroBuild(THORNBLADE, 4, content);
    const supplies = [{ item: 'item:minor_healing_potion', qty: 4 }, { item: 'item:sap_tonic', qty: 2 }];
    const setup = {
      heroes: [{ id: HERO_ID, build, skills: input.bossSkills, rules: input.bossRules, consumables: supplies }],
      enemies: [{ id: 'enemy:warden#1', enemy: 'enemy:region_2.resonant_warden' }],
      content: content.combat,
    };
    const livePolicy = attentiveLivePolicy({ heroId: HERO_ID, guard: 'skill:guard', cleanse: 'skill:second_wind' });
    const auto = runToEnd(setup, 24, NO_INPUTS, 3000);
    const live = runToEnd(setup, 24, livePolicy, 3000);
    const signalHit = (events: typeof auto.events) => events.find((e) => e.type === 'DamageDealt' && e.origin === 'skill:region_2.signal_pulse' && e.targetId === HERO_ID);
    const guardedPulse = signalHit(auto.events);
    const livePulse = signalHit(live.events);
    expect(guardedPulse).toBeDefined();
    expect(livePulse).toBeDefined();
    const liveGuards = live.events.filter((e) => e.type === 'ActionStarted' && e.actorId === HERO_ID && e.source === 'manual' && e.action.kind === 'skill' && e.action.skill === 'skill:guard');
    expect(liveGuards.length).toBeGreaterThan(0);

    const appliedDots = auto.events.filter((e) => e.type === 'EffectApplied' && e.effect === 'dot' && e.origin === 'skill:bramble_lash' && e.targetId === HERO_ID);
    const cleansedDots = auto.events.filter((e) => e.type === 'EffectExpired' && e.effect === 'dot' && e.reason === 'cleansed' && e.targetId === HERO_ID);
    const tonicUses = auto.events.filter((e) => e.type === 'ConsumableUsed' && e.item === 'item:sap_tonic');
    expect(appliedDots.length).toBeGreaterThan(0);
    expect(cleansedDots.length).toBeGreaterThan(0);
    expect(tonicUses.length).toBeGreaterThan(0);

    const liveCleanse = live.events.filter((e) => e.type === 'ActionStarted' && e.actorId === HERO_ID && e.source === 'manual' && e.action.kind === 'skill' && e.action.skill === 'skill:second_wind');
    const liveTonics = live.events.filter((e) => e.type === 'ConsumableUsed' && e.item === 'item:sap_tonic');
    const liveCleansedDots = live.events.filter((e) => e.type === 'EffectExpired' && e.effect === 'dot' && e.reason === 'cleansed' && e.targetId === HERO_ID);
    expect(liveCleanse.length).toBeGreaterThan(0);
    expect(liveCleansedDots.length).toBeGreaterThan(0);
    expect(liveTonics).toHaveLength(0);

    // Diagnostic counterfactual: guard's actual resistance effect reduces the same pulse in the same seed.
    const heroTemplate = setup.heroes[0];
    if (heroTemplate === undefined) throw new Error('missing R2 trace hero setup');
    const unguardedSetup = { ...setup, heroes: [{ ...heroTemplate, rules: input.bossRules.filter((r) => !('useSkill' in r.do && r.do.useSkill === 'skill:guard')) }] };
    const unguarded = runToEnd(unguardedSetup, 24, NO_INPUTS, 3000);
    const unguardedPulse = signalHit(unguarded.events);
    expect(unguardedPulse).toBeDefined();
    if (guardedPulse?.type !== 'DamageDealt' || livePulse?.type !== 'DamageDealt' || unguardedPulse?.type !== 'DamageDealt') {
      throw new Error('expected Warden signal pulse damage in all traces');
    }
    expect(guardedPulse.amount).toBeLessThan(unguardedPulse.amount);
    expect(livePulse.amount).toBeLessThan(unguardedPulse.amount);
  });

  it('reports per-win item use as undefined when an R2 boss cohort has no wins', () => {
    const warden = content.combat.enemies['enemy:region_2.resonant_warden'];
    if (warden === undefined) throw new Error('missing compiled Region 2 Warden');
    const lethalContent = {
      ...content,
      combat: {
        ...content.combat,
        enemies: { ...content.combat.enemies, [warden.id]: { ...warden, stats: { ...warden.stats, power: 1000 } } },
      },
    };
    const report = runRegion2Balance(lethalContent, 24, 1, ['boss']);
    const row = report.boss.find((r) => r.cohort === 'fresh-l4' && r.build === 'bulwark' && r.mode === 'auto');
    if (row === undefined) throw new Error('missing fresh Bulwark boss row');
    expect(row.stats.wins).toBe(0);
    expect(row.stats.usedPerTrial['item:minor_healing_potion']).toBe(0);
    expect(row.stats.usedPerWin['item:minor_healing_potion']).toBeNull();
    expect(row.stats.usedPerWin['item:sap_tonic']).toBeNull();
    expect(renderRegion2Markdown(report)).toContain('item:minor_healing_potion: —');
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

  it('keeps the R1 default and supports explicit Region 2 cohort runs', async () => {
    expect((await cli(['--scenario', 'region-2', '--runs', '1', '--sections', 'cells'])).out).toContain('Region 2 balance measurements');
    expect((await cli(['--scenario', 'region-2', '--runs', '1', '--sections', 'cells', '--levels', '4'])).code).toBe(2);
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
