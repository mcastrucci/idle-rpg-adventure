/**
 * `balance-sim` command line. {@link runCli} is I/O-injected so tests run it in-process; `bin.ts` wires it to the
 * real process. Exit codes: 0 report written (WARN rows never fail), 1 content does not compile, 2 usage error.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { assertSeed } from '@engine/sim-core';

import { DEFAULT_CONTENT_ROOT, loadBalanceContent } from './content.ts';
import type { BalanceContent } from './content.ts';
import { range } from './math.ts';
import { REPORT_FORMATS, renderReport } from './report.ts';
import type { ReportFormat } from './report.ts';
import { SECTIONS, runBalance } from './run.ts';
import type { BalanceConfig, Section } from './run.ts';
import { REGION_1_SCENARIO } from './scenario.ts';

export interface CliIo {
  readonly cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const DEFAULTS = {
  seed: 24,
  runs: 100,
  hours: 50,
  levels: '1-5',
  bossLevels: '3-5',
  hourLevels: '3-5',
  regenPct: 15,
  format: 'md' as ReportFormat,
  sections: 'cells,boss,hourly',
} as const;

export const USAGE = `Usage: balance-sim [options]

Monte Carlo balance report over compiled RPG content (Region 1 scenario; all numbers provisional).

Options:
  --content <dir>       Content root to compile (default: games/rpg/content)
  --runs <n>            Fights per encounter-group cell and attempts per boss row (default ${DEFAULTS.runs})
  --hours <n>           Simulated hours per hourly row (default ${DEFAULTS.hours})
  --seed <uint32>       Seed root (default ${DEFAULTS.seed}); run i uses deriveSeed(root, 'balance', i)
  --levels <spec>       Hero levels for group cells, e.g. 1-5 or 1,3,5 (default ${DEFAULTS.levels})
  --boss-levels <spec>  Hero levels for mini-boss attempts (default ${DEFAULTS.bossLevels})
  --hour-levels <spec>  Hero levels for XP/gold per hour (default ${DEFAULTS.hourLevels})
  --regen-pct <n>       Idle between-fight regen, % of max HP (provisional, default ${DEFAULTS.regenPct})
  --sections <list>     Any of cells,boss,hourly (default ${DEFAULTS.sections})
  --format <fmt>        md | csv | json (default ${DEFAULTS.format})
  --out <file>          Write the report to a file instead of stdout
  -h, --help            Show this help
`;

class UsageError extends Error {}

function int(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer, got "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new UsageError(`--${name} must be >= ${min}, got ${raw}`);
  return n;
}

/** `1-5`, `1,3,5` or `2`. */
export function parseLevels(name: string, spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (m === null) throw new UsageError(`--${name}: invalid level spec "${spec}"`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) throw new UsageError(`--${name}: invalid level range "${part}"`);
    for (const l of range(from, to)) out.add(l);
  }
  return [...out].sort((a, b) => a - b);
}

function parseSections(raw: string): Section[] {
  const list = raw.split(',').map((s) => s.trim());
  for (const s of list) if (!(SECTIONS as readonly string[]).includes(s)) throw new UsageError(`--sections: unknown section "${s}"`);
  return SECTIONS.filter((s) => list.includes(s));
}

export interface ParsedArgs {
  readonly contentRoot: string;
  readonly config: BalanceConfig;
  readonly format: ReportFormat;
  readonly out: string | null;
}

export function parseCliArgs(argv: readonly string[], cwd: string): ParsedArgs | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        content: { type: 'string' },
        runs: { type: 'string' },
        hours: { type: 'string' },
        seed: { type: 'string' },
        levels: { type: 'string' },
        'boss-levels': { type: 'string' },
        'hour-levels': { type: 'string' },
        'regen-pct': { type: 'string' },
        sections: { type: 'string' },
        format: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.help === true) return 'help';
  const format = (v.format ?? DEFAULTS.format) as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${REPORT_FORMATS.join(', ')}`);
  const seedRoot = int('seed', v.seed, DEFAULTS.seed, 0);
  try {
    assertSeed(seedRoot);
  } catch {
    throw new UsageError(`--seed must be a uint32, got ${v.seed ?? ''}`);
  }
  const regenPct = int('regen-pct', v['regen-pct'], DEFAULTS.regenPct, 0);
  if (regenPct > 100) throw new UsageError('--regen-pct must be <= 100');
  return {
    contentRoot: v.content === undefined ? DEFAULT_CONTENT_ROOT : path.resolve(cwd, v.content),
    format,
    out: v.out === undefined ? null : path.resolve(cwd, v.out),
    config: {
      seedRoot,
      runs: int('runs', v.runs, DEFAULTS.runs, 1),
      hours: int('hours', v.hours, DEFAULTS.hours, 1),
      levels: parseLevels('levels', v.levels ?? DEFAULTS.levels),
      bossLevels: parseLevels('boss-levels', v['boss-levels'] ?? DEFAULTS.bossLevels),
      hourLevels: parseLevels('hour-levels', v['hour-levels'] ?? DEFAULTS.hourLevels),
      idleRegenBp: regenPct * 100,
      sections: parseSections(v.sections ?? DEFAULTS.sections),
    },
  };
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs | 'help';
  try {
    args = parseCliArgs(argv, io.cwd);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  let content: BalanceContent;
  try {
    content = loadBalanceContent(args.contentRoot);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const report = runBalance(content, REGION_1_SCENARIO, args.config);
  const text = renderReport(report, args.format);
  if (args.out === null) {
    io.stdout(text);
  } else {
    writeFileSync(args.out, text);
    io.stderr(`Wrote ${args.out}\n`);
  }
  return 0;
}
