/**
 * Region 1 balance targets (docs/design/region-1.md §5.3, §7) and their evaluation against a report.
 *
 * Every target is provisional and every check reports PASS or WARN, never a failure: balance is not a CI gate. The
 * design gives point estimates ("≈ 650 XP/h", "TTK 24 ticks"); the tolerances used to turn them into PASS/WARN are a
 * convention of this tool (stated in each row), not design decisions. Targets the tool cannot measure yet are listed
 * as N/A so the gap stays visible.
 */
import { formatBp, formatX100 } from './math.ts';
import type { BalanceReport } from './run.ts';
import type { BossRow, CellRow, HourRow } from './simulate.ts';

export type TargetStatus = 'PASS' | 'WARN' | 'N/A';

export interface TargetCheck {
  /** Design section, e.g. `§7.2`. */
  readonly ref: string;
  readonly metric: string;
  readonly subject: string;
  readonly target: string;
  readonly measured: string;
  readonly status: TargetStatus;
}

/** Tool tolerances for point targets, bp of the target. */
export const TOLERANCE = {
  ttkBp: 3000,
  hpLostAbsBp: 1000,
  xpPerHourBp: 1500,
  goldPerHourBp: 2500,
  bossFightBp: 3000,
} as const;

const MITE3 = 'enemy:glowcap_mite×3';
const BOAR = 'enemy:thornback_boar×1';
const CREEPER = 'enemy:hollow_creeper×1';
const LANTERN = 'enemy:sentinel_lantern×1';
const TILLER = 'enemy:rusted_tiller×1';
const BOAR_MITE = 'enemy:glowcap_mite×1+enemy:thornback_boar×1';

/** §7.2: median TTK (ticks) at L1/L3/L5 and HP lost at L3 (bp), per build. */
export const TTK_TARGETS: readonly {
  readonly group: string;
  readonly label: string;
  readonly ttk: Readonly<Record<string, readonly [number, number, number]>>;
  readonly hpLostL3: Readonly<Record<string, number>>;
}[] = [
  { group: MITE3, label: 'mite ×3', ttk: { bulwark: [24, 24, 14], thornblade: [23, 14, 14] }, hpLostL3: { bulwark: 1600, thornblade: 2100 } },
  { group: BOAR, label: 'boar', ttk: { bulwark: [24, 19, 14], thornblade: [14, 13, 9] }, hpLostL3: { bulwark: 1300, thornblade: 1900 } },
  { group: CREEPER, label: 'creeper', ttk: { bulwark: [29, 23, 19], thornblade: [20, 15, 14] }, hpLostL3: { bulwark: 1400, thornblade: 200 } },
  { group: LANTERN, label: 'lantern', ttk: { bulwark: [19, 14, 9], thornblade: [9, 9, 4] }, hpLostL3: { bulwark: 1900, thornblade: 1400 } },
  { group: TILLER, label: 'tiller', ttk: { bulwark: [73, 44, 33], thornblade: [30, 21, 15] }, hpLostL3: { bulwark: 3700, thornblade: 3200 } },
  { group: BOAR_MITE, label: 'boar + mite', ttk: { bulwark: [34, 24, 24], thornblade: [29, 19, 19] }, hpLostL3: { bulwark: 2000, thornblade: 3100 } },
];

/** §7.4: success ranges (bp) live / automation and fight length (ticks). */
export const BOSS_TARGETS: readonly {
  readonly build: string;
  readonly level: number;
  readonly live: readonly [number, number];
  readonly auto: readonly [number, number];
  readonly ticks: number;
}[] = [
  { build: 'bulwark', level: 3, live: [1500, 2500], auto: [0, 500], ticks: 360 },
  { build: 'bulwark', level: 4, live: [8500, 9500], auto: [1500, 3000], ticks: 300 },
  { build: 'bulwark', level: 5, live: [9500, 10_000], auto: [9000, 10_000], ticks: 235 },
  { build: 'thornblade', level: 3, live: [5000, 7000], auto: [0, 500], ticks: 160 },
  { build: 'thornblade', level: 4, live: [8500, 9500], auto: [4500, 6000], ticks: 125 },
  { build: 'thornblade', level: 5, live: [9500, 10_000], auto: [9000, 10_000], ticks: 105 },
];

/** §7.4: potions used in a winning live attempt (hundredths). */
export const BOSS_LIVE_POTIONS: Readonly<Record<number, readonly [number, number]>> = { 4: [200, 350], 5: [100, 300] };

const status = (ok: boolean): TargetStatus => (ok ? 'PASS' : 'WARN');
const within = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;
/** `|v − t| ≤ t × tolBp / 10000`, integer-only. */
const near = (v: number, t: number, tolBp: number): boolean => Math.abs(v - t) * 10_000 <= t * tolBp;
const pct = (bp: number): string => (bp % 100 === 0 ? `${bp / 100}%` : formatBp(bp));

function cell(report: BalanceReport, group: string, build: string, level: number): CellRow | undefined {
  return report.cells.find((c) => c.group.key === group && c.build === build && c.level === level);
}

function bossRow(report: BalanceReport, build: string, level: number, mode: BossRow['mode']): BossRow | undefined {
  return report.boss.find((b) => b.build === build && b.level === level && b.mode === mode);
}

function hourRow(report: BalanceReport, activity: string, build: string, level: number): HourRow | undefined {
  return report.hourly.find((h) => h.activity === activity && h.build === build && h.level === level);
}

function ttkChecks(report: BalanceReport, out: TargetCheck[]): void {
  if (report.cells.length === 0) return;
  for (const t of TTK_TARGETS) {
    for (const [build, ttks] of Object.entries(t.ttk)) {
      ([1, 3, 5] as const).forEach((level, i) => {
        const target = ttks[i] ?? 0;
        const c = cell(report, t.group, build, level);
        if (c === undefined) return;
        const p50 = c.stats.ttkP50;
        out.push({
          ref: '§7.2',
          metric: 'TTK p50 (ticks)',
          subject: `${t.label} · ${build} L${level}`,
          target: `${target} ±${pct(TOLERANCE.ttkBp)}`,
          measured: p50 === null ? 'no wins' : String(p50),
          status: status(p50 !== null && near(p50, target, TOLERANCE.ttkBp)),
        });
        out.push({
          ref: '§7.2',
          metric: 'win rate',
          subject: `${t.label} · ${build} L${level}`,
          target: '≥ 99%',
          measured: formatBp(c.stats.winBp),
          status: status(c.stats.winBp >= 9900),
        });
      });
      const c3 = cell(report, t.group, build, 3);
      const hp = t.hpLostL3[build];
      if (c3 !== undefined && hp !== undefined) {
        out.push({
          ref: '§7.2',
          metric: 'HP lost per fight',
          subject: `${t.label} · ${build} L3`,
          target: `${pct(hp)} ±${pct(TOLERANCE.hpLostAbsBp)} (abs)`,
          measured: formatBp(c3.stats.hpLostBp),
          status: status(Math.abs(c3.stats.hpLostBp - hp) <= TOLERANCE.hpLostAbsBp),
        });
      }
    }
  }
}

function bandChecks(report: BalanceReport, out: TargetCheck[]): void {
  for (const c of report.cells) {
    if (c.group.level !== c.level) continue;
    const p50 = c.stats.ttkP50;
    out.push({
      ref: '§7.2 band',
      metric: 'TTK p50 at own level',
      subject: `${c.group.label} · ${c.build} L${c.level}`,
      target: '15–35 ticks',
      measured: p50 === null ? 'no wins' : String(p50),
      status: status(p50 !== null && within(p50, 15, 35)),
    });
    out.push({
      ref: '§7.2 band',
      metric: 'HP lost at own level',
      subject: `${c.group.label} · ${c.build} L${c.level}`,
      target: '10–35%',
      measured: formatBp(c.stats.hpLostBp),
      status: status(within(c.stats.hpLostBp, 1000, 3500)),
    });
  }
}

function bossChecks(report: BalanceReport, out: TargetCheck[]): void {
  for (const t of BOSS_TARGETS) {
    for (const mode of ['live', 'auto'] as const) {
      const row = bossRow(report, t.build, t.level, mode);
      if (row === undefined) continue;
      const [lo, hi] = mode === 'live' ? t.live : t.auto;
      out.push({
        ref: '§7.4',
        metric: `boss success (${mode === 'live' ? 'attentive live' : 'automation'})`,
        subject: `${t.build} L${t.level}`,
        target: `${pct(lo)}–${pct(hi)}`,
        measured: formatBp(row.stats.winBp),
        status: status(within(row.stats.winBp, lo, hi)),
      });
    }
    const live = bossRow(report, t.build, t.level, 'live');
    if (live !== undefined) {
      const p50 = live.stats.ttkP50;
      out.push({
        ref: '§7.4',
        metric: 'boss fight length p50, live wins (ticks)',
        subject: `${t.build} L${t.level}`,
        target: `${t.ticks} ±${pct(TOLERANCE.bossFightBp)}`,
        measured: p50 === null ? 'no wins' : String(p50),
        status: status(p50 !== null && near(p50, t.ticks, TOLERANCE.bossFightBp)),
      });
      const potions = BOSS_LIVE_POTIONS[t.level];
      if (potions !== undefined) {
        out.push({
          ref: '§7.4',
          metric: 'potions per winning live attempt',
          subject: `${t.build} L${t.level}`,
          target: `${formatX100(potions[0])}–${formatX100(potions[1])}`,
          measured: live.stats.wins === 0 ? 'no wins' : formatX100(live.stats.winPotionsX100),
          status: status(live.stats.wins > 0 && within(live.stats.winPotionsX100, potions[0], potions[1])),
        });
      }
    }
  }
}

function hourChecks(report: BalanceReport, out: TargetCheck[]): void {
  if (report.hourly.length === 0) return;
  const builds = [...new Set(report.hourly.map((h) => h.build))];
  const HUNT = 'idle:region_1.hunt';
  const GATHER = 'idle:region_1.gather';
  const LIVE = 'live:route';
  const push = (ref: string, metric: string, subject: string, target: string, measured: string, ok: boolean): void => {
    out.push({ ref, metric, subject, target, measured, status: status(ok) });
  };
  for (const build of builds) {
    const hunt4 = hourRow(report, HUNT, build, 4);
    const hunt3 = hourRow(report, HUNT, build, 3);
    const gather4 = hourRow(report, GATHER, build, 4);
    const live4 = hourRow(report, LIVE, build, 4);
    if (hunt4 !== undefined) {
      const s = `idle hunt · ${build} L4`;
      push('§7.3', 'XP/h', s, `≈ 650 ±${pct(TOLERANCE.xpPerHourBp)}`, String(hunt4.xpPerHour), near(hunt4.xpPerHour, 650, TOLERANCE.xpPerHourBp));
      push('§7.3', 'potions/h', s, '≤ 1', formatX100(hunt4.potionsPerHourX100), hunt4.potionsPerHourX100 <= 100);
      push('§7.3', 'deaths/h', s, '< 1%', formatBp(hunt4.deathsPerHourBp), hunt4.deathsPerHourBp < 100);
      push('§5.3', 'gross gold/h', s, `≈ 210 ±${pct(TOLERANCE.goldPerHourBp)}`, String(hunt4.grossGoldPerHour), near(hunt4.grossGoldPerHour, 210, TOLERANCE.goldPerHourBp));
      push('§5.3', 'enemy gold/h', s, `≈ 120 ±${pct(TOLERANCE.goldPerHourBp)}`, String(hunt4.enemyGoldPerHour), near(hunt4.enemyGoldPerHour, 120, TOLERANCE.goldPerHourBp));
      push('§5.3', 'vendor value/h', s, `≈ 90 ±${pct(TOLERANCE.goldPerHourBp)}`, String(hunt4.vendorPerHour), near(hunt4.vendorPerHour, 90, TOLERANCE.goldPerHourBp));
    }
    if (hunt3 !== undefined) {
      push('§7.3', 'potions/h', `idle hunt · ${build} L3`, '0.50–1.50', formatX100(hunt3.potionsPerHourX100), within(hunt3.potionsPerHourX100, 50, 150));
    }
    if (gather4 !== undefined) {
      push('§7.3', 'XP/h', `idle gather · ${build} L4`, `≈ 150 ±${pct(TOLERANCE.xpPerHourBp)}`, String(gather4.xpPerHour), near(gather4.xpPerHour, 150, TOLERANCE.xpPerHourBp));
      push('§7.3', 'deaths/h', `idle gather · ${build} L4`, '< 1%', formatBp(gather4.deathsPerHourBp), gather4.deathsPerHourBp < 100);
    }
    if (live4 !== undefined) {
      const s = `live route · ${build} L4`;
      push('§7.3', 'XP/h', s, `≈ 970 ±${pct(TOLERANCE.xpPerHourBp)}`, String(live4.xpPerHour), near(live4.xpPerHour, 970, TOLERANCE.xpPerHourBp));
      push('§7.3', 'potions/h', s, '3–6', formatX100(live4.potionsPerHourX100), within(live4.potionsPerHourX100, 300, 600));
      push('§5.3', 'gross gold/h', s, `≈ 320 ±${pct(TOLERANCE.goldPerHourBp)}`, String(live4.grossGoldPerHour), near(live4.grossGoldPerHour, 320, TOLERANCE.goldPerHourBp));
      if (hunt4 !== undefined) {
        const ratio = hunt4.xpPerHour === 0 ? 0 : Math.floor((live4.xpPerHour * 10_000) / hunt4.xpPerHour);
        push('§7.3', 'live/idle XP ratio', `${build} L4`, '×1.40–×1.60', `×${formatX100(Math.floor(ratio / 100))}`, within(ratio, 14_000, 16_000));
        push('§7.3', 'live ≥ idle × premium cap 1.25', `${build} L4`, '≥ ×1.25', `×${formatX100(Math.floor(ratio / 100))}`, ratio >= 12_500);
      }
    }
    for (const h of report.hourly) {
      if (h.activity !== LIVE || h.build !== build || h.level < 4) continue;
      push('§7.1/§7.3', 'deaths/h', `live route · ${build} L${h.level}`, '≤ 0.10', formatX100(Math.floor(h.deathsPerHourBp / 100)), h.deathsPerHourBp <= 1000);
    }
  }
}

const NOT_MODELLED: readonly Omit<TargetCheck, 'measured' | 'status'>[] = [
  { ref: '§7.1', metric: 'first-time conquest (live, median)', subject: 'region', target: '45–60 min, 20–25 encounters' },
  { ref: '§7.1', metric: 'level on reaching the boss', subject: 'region', target: '4 (3–5)' },
  { ref: '§7.1', metric: 'deaths before conquest', subject: 'region', target: 'mean ≤ 0.8, p90 ≤ 2' },
  { ref: '§5.3', metric: 'recurring sinks share of gross gold', subject: 'live / idle', target: '20–35% / 5–15%' },
];

/** Evaluates every target the report has data for; unmeasured targets are N/A. */
export function evaluateTargets(report: BalanceReport): TargetCheck[] {
  const out: TargetCheck[] = [];
  ttkChecks(report, out);
  bandChecks(report, out);
  bossChecks(report, out);
  hourChecks(report, out);
  for (const t of NOT_MODELLED) out.push({ ...t, measured: 'not modelled (needs the live instance/conquest model)', status: 'N/A' });
  return out;
}
