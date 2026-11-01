/**
 * Report renderers: Markdown (default), CSV (one block per section) and JSON. Output depends only on the report
 * data, so equal inputs give byte-identical text. Every format carries `ENGINE_VERSION`, `contentHash`, seed root and N.
 */
import { formatBp, formatX100 } from './math.ts';
import type { BalanceReport } from './run.ts';
import type { FightStats } from './simulate.ts';
import { evaluateTargets } from './targets.ts';
import type { TargetCheck } from './targets.ts';

export type ReportFormat = 'md' | 'csv' | 'json';
export const REPORT_FORMATS: readonly ReportFormat[] = ['md', 'csv', 'json'];

const dash = (v: number | null): string => (v === null ? '–' : String(v));
const ttk = (s: FightStats): string => `${dash(s.ttkP10)} / ${dash(s.ttkP50)} / ${dash(s.ttkP90)}`;
const levels = (l: readonly number[]): string => (l.length === 0 ? '–' : l.join(', '));

function mdTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const esc = (s: string): string => s.replaceAll('|', '\\|');
  return [
    `| ${head.map(esc).join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function headerRows(report: BalanceReport): [string, string][] {
  const h = report.header;
  const r = h.liveRoute;
  return [
    ['tool', h.tool],
    ['ENGINE_VERSION', h.engineVersion],
    ['contentHash', h.contentHash],
    ['scenario', h.scenario],
    ['seed root', String(h.seedRoot)],
    ['N (fights per cell, attempts per boss row)', String(h.runs)],
    ['hours per hourly row', String(h.hours)],
    ['cell levels', levels(h.levels)],
    ['boss levels', levels(h.bossLevels)],
    ['hourly levels', levels(h.hourLevels)],
    ['potions carried: cell / boss / idle hour / live hour', `${h.cellPotions} / ${h.bossPotions} / ${h.idlePotionsPerHour} / ${r.potionsPerHour}`],
    ['idle between-fight regen (provisional)', formatBp(h.idleRegenBp)],
    ['live route', `${r.name}: ${r.encountersPerHour} fights/h over ${r.tables.join(', ')}; skips groups made only of ${r.skipGroupsOnlyOf.join(', ')}; rest ${formatBp(r.restBetweenFightsBp)} between fights`],
  ];
}

const ASSUMPTIONS = [
  'All numbers are **provisional** measurements of the current content and engine, not balance decisions.',
  'Hero stats come from `@rpg/rpg-stats` defaults (not the paper model A3); builds, gear per level and rules are the provisional scenario in `games/rpg/tools/balance-sim/src/scenario.ts`.',
  'Cells: automation only (no manual input), hero starts at full HP with the cell potions; TTK percentiles are over wins only; HP lost is the mean net loss (a death counts as 100%).',
  'Boss "automation" = the build\'s boss rules only. Boss "attentive live" = same rules plus a script that queues `guard` at the last hero action before each predicted telegraphed hit and cleanses DoTs (Thornblade); manual inputs wait for the next ready tick (A8).',
  'Hourly rows chain fights with HP carry-over, regen between fights and a shared potion supply; an hour ends at the first death (or timeout), and a death keeps 50% of that hour\'s gold and loot. XP/h is gross (no death XP loss). Gold: enemy gold rolls; vendor value = item sell `value` of drops and idle resource yields.',
  'Idle encounter budget = `encountersPerHour` (pace multiplier 1); live route budget, route tables, skip rule, rest and potions are scenario assumptions.',
  'PASS/WARN tolerances for point targets are a tool convention; WARN never fails CI.',
];

function targetSummary(checks: readonly TargetCheck[]): string {
  const count = (s: TargetCheck['status']): number => checks.filter((c) => c.status === s).length;
  return `PASS ${count('PASS')} · WARN ${count('WARN')} · N/A ${count('N/A')}`;
}

export function renderMarkdown(report: BalanceReport, checks: readonly TargetCheck[] = evaluateTargets(report)): string {
  const out: string[] = [];
  out.push('# Balance report');
  out.push('');
  out.push(
    `> Provisional measurement at **${report.header.engineVersion}** / contentHash \`${report.header.contentHash.slice(0, 16)}…\`. Not a balance decision; balance is not a CI gate.`,
  );
  out.push('');
  out.push(mdTable(['Field', 'Value'], headerRows(report).map(([k, v]) => [k, k === 'contentHash' ? `\`${v}\`` : v])));
  out.push('');
  out.push('## Modelling assumptions');
  out.push('');
  for (const a of ASSUMPTIONS) out.push(`- ${a}`);
  out.push('');

  if (report.cells.length > 0) {
    out.push('## Encounter groups (automation, full HP)');
    out.push('');
    out.push(
      mdTable(
        ['Group', 'Grp lvl', 'Build', 'Hero L', 'Win', 'TTK p10 / p50 / p90', 'HP lost', 'Potions/fight', 'Deaths', 'Timeouts'],
        report.cells.map((c) => [
          c.group.label,
          String(c.group.level),
          c.build,
          String(c.level),
          formatBp(c.stats.winBp),
          ttk(c.stats),
          formatBp(c.stats.hpLostBp),
          formatX100(c.stats.potionsX100),
          String(c.stats.deaths),
          String(c.stats.timeouts),
        ]),
      ),
    );
    out.push('');
  }

  if (report.boss.length > 0) {
    out.push('## Mini-boss attempts');
    out.push('');
    out.push(
      mdTable(
        ['Build', 'Hero L', 'Mode', 'Success', 'Fight ticks p10 / p50 / p90 (wins)', 'Potions/attempt', 'Potions/win', 'HP lost', 'Deaths', 'Timeouts'],
        report.boss.map((b) => [
          b.build,
          String(b.level),
          b.mode === 'live' ? 'attentive live' : 'automation',
          formatBp(b.stats.winBp),
          ttk(b.stats),
          formatX100(b.stats.potionsX100),
          b.stats.wins === 0 ? '–' : formatX100(b.stats.winPotionsX100),
          formatBp(b.stats.hpLostBp),
          String(b.stats.deaths),
          String(b.stats.timeouts),
        ]),
      ),
    );
    out.push('');
  }

  if (report.hourly.length > 0) {
    out.push('## XP and gold per hour');
    out.push('');
    out.push(
      mdTable(
        ['Activity', 'Build', 'Hero L', 'XP/h (mean)', 'XP/h p10 / p50 / p90', 'Enemy gold/h', 'Vendor value/h', 'Gross/h', 'Potions/h', 'Fights/h', 'Deaths/h'],
        report.hourly.map((h) => [
          h.activity,
          h.build,
          String(h.level),
          String(h.xpPerHour),
          `${dash(h.xpP10)} / ${dash(h.xpP50)} / ${dash(h.xpP90)}`,
          String(h.enemyGoldPerHour),
          String(h.vendorPerHour),
          String(h.grossGoldPerHour),
          formatX100(h.potionsPerHourX100),
          formatX100(h.fightsPerHourX100),
          formatX100(Math.floor(h.deathsPerHourBp / 100)),
        ]),
      ),
    );
    out.push('');
  }

  out.push('## Targets (docs/design/region-1.md §5.3, §7)');
  out.push('');
  out.push(targetSummary(checks));
  out.push('');
  out.push(mdTable(['Ref', 'Metric', 'Subject', 'Target', 'Measured', 'Status'], checks.map((c) => [c.ref, c.metric, c.subject, c.target, c.measured, c.status])));
  out.push('');
  return out.join('\n');
}

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvBlock(name: string, head: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  return [`# ${name}`, head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

/** CSV: one block per section (`# name`, header row, data rows), separated by blank lines. Rates in bp, means ×100. */
export function renderCsv(report: BalanceReport, checks: readonly TargetCheck[] = evaluateTargets(report)): string {
  const blocks: string[] = [csvBlock('header', ['field', 'value'], headerRows(report))];
  blocks.push(
    csvBlock(
      'cells',
      ['group', 'group_level', 'build', 'level', 'runs', 'wins', 'deaths', 'timeouts', 'win_bp', 'ttk_p10', 'ttk_p50', 'ttk_p90', 'hp_lost_bp', 'potions_x100'],
      report.cells.map((c) => [c.group.label, c.group.level, c.build, c.level, c.stats.runs, c.stats.wins, c.stats.deaths, c.stats.timeouts, c.stats.winBp, c.stats.ttkP10, c.stats.ttkP50, c.stats.ttkP90, c.stats.hpLostBp, c.stats.potionsX100]),
    ),
  );
  blocks.push(
    csvBlock(
      'boss',
      ['build', 'level', 'mode', 'runs', 'wins', 'deaths', 'timeouts', 'win_bp', 'ticks_p10', 'ticks_p50', 'ticks_p90', 'hp_lost_bp', 'potions_x100', 'win_potions_x100'],
      report.boss.map((b) => [b.build, b.level, b.mode, b.stats.runs, b.stats.wins, b.stats.deaths, b.stats.timeouts, b.stats.winBp, b.stats.ttkP10, b.stats.ttkP50, b.stats.ttkP90, b.stats.hpLostBp, b.stats.potionsX100, b.stats.winPotionsX100]),
    ),
  );
  blocks.push(
    csvBlock(
      'hourly',
      ['activity', 'build', 'level', 'hours', 'xp_per_hour', 'xp_p10', 'xp_p50', 'xp_p90', 'enemy_gold_per_hour', 'vendor_per_hour', 'gross_per_hour', 'potions_per_hour_x100', 'fights_per_hour_x100', 'deaths_per_hour_bp'],
      report.hourly.map((h) => [h.activity, h.build, h.level, h.hours, h.xpPerHour, h.xpP10, h.xpP50, h.xpP90, h.enemyGoldPerHour, h.vendorPerHour, h.grossGoldPerHour, h.potionsPerHourX100, h.fightsPerHourX100, h.deathsPerHourBp]),
    ),
  );
  blocks.push(csvBlock('targets', ['ref', 'metric', 'subject', 'target', 'measured', 'status'], checks.map((c) => [c.ref, c.metric, c.subject, c.target, c.measured, c.status])));
  return `${blocks.join('\n\n')}\n`;
}

export function renderJson(report: BalanceReport, checks: readonly TargetCheck[] = evaluateTargets(report)): string {
  return `${JSON.stringify({ ...report, targets: checks }, null, 2)}\n`;
}

export function renderReport(report: BalanceReport, format: ReportFormat): string {
  const checks = evaluateTargets(report);
  if (format === 'csv') return renderCsv(report, checks);
  if (format === 'json') return renderJson(report, checks);
  return renderMarkdown(report, checks);
}
