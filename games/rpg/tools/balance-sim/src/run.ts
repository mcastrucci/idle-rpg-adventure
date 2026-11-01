/**
 * Runs a whole balance report: per-group cells, mini-boss attempts (automation vs attentive live) and hourly
 * XP/gold for idle activities and the live route. Pure apart from reading the content passed in: the same config and
 * content always produce the same report.
 */
import type { Seed } from '@engine/sim-core';
import { ENGINE_VERSION } from '@rpg/rpg-sim';

import type { BalanceContent } from './content.ts';
import type { BossRow, CellRow, HourRow, PolicyMode } from './simulate.ts';
import { distinctGroups, idleHourSpec, liveHourSpec, runBoss, runCell, runHours } from './simulate.ts';
import type { Scenario } from './scenario.ts';

export type Section = 'cells' | 'boss' | 'hourly';
export const SECTIONS: readonly Section[] = ['cells', 'boss', 'hourly'];

export interface BalanceConfig {
  readonly seedRoot: Seed;
  /** Fights per cell and attempts per boss row. */
  readonly runs: number;
  /** Simulated hours per hourly row. */
  readonly hours: number;
  readonly levels: readonly number[];
  readonly bossLevels: readonly number[];
  readonly hourLevels: readonly number[];
  /** Idle between-fight regen, bp of max HP (provisional, design A9: 15%). */
  readonly idleRegenBp: number;
  readonly sections: readonly Section[];
}

export interface ReportHeader {
  readonly tool: string;
  readonly engineVersion: string;
  readonly contentHash: string;
  readonly scenario: string;
  readonly seedRoot: Seed;
  readonly runs: number;
  readonly hours: number;
  readonly idleRegenBp: number;
  readonly levels: readonly number[];
  readonly bossLevels: readonly number[];
  readonly hourLevels: readonly number[];
  readonly cellPotions: number;
  readonly bossPotions: number;
  readonly idlePotionsPerHour: number;
  readonly liveRoute: Scenario['liveRoute'];
}

export interface BalanceReport {
  readonly header: ReportHeader;
  readonly cells: readonly CellRow[];
  readonly boss: readonly BossRow[];
  readonly hourly: readonly HourRow[];
}

export const BALANCE_SIM_TOOL = '@rpg/balance-sim';

export function runBalance(content: BalanceContent, scenario: Scenario, config: BalanceConfig): BalanceReport {
  const opts = { seedRoot: config.seedRoot, runs: config.runs };
  const cells: CellRow[] = [];
  if (config.sections.includes('cells')) {
    for (const group of distinctGroups(content, scenario.cellTables)) {
      for (const build of scenario.builds) {
        for (const level of config.levels) cells.push(runCell(content, scenario, group, build, level, opts));
      }
    }
  }
  const boss: BossRow[] = [];
  if (config.sections.includes('boss')) {
    for (const build of scenario.builds) {
      for (const level of config.bossLevels) {
        for (const mode of ['auto', 'live'] as const satisfies readonly PolicyMode[]) {
          boss.push(runBoss(content, scenario, build, level, mode, opts));
        }
      }
    }
  }
  const hourly: HourRow[] = [];
  if (config.sections.includes('hourly')) {
    const specs = [
      ...scenario.idleActivities.map((id) => idleHourSpec(content, scenario, id, config.idleRegenBp)),
      liveHourSpec(content, scenario),
    ];
    for (const spec of specs) {
      for (const build of scenario.builds) {
        for (const level of config.hourLevels) {
          hourly.push(runHours(content, scenario, spec, build, level, { seedRoot: config.seedRoot, hours: config.hours }));
        }
      }
    }
  }
  return {
    header: {
      tool: BALANCE_SIM_TOOL,
      engineVersion: ENGINE_VERSION,
      contentHash: content.contentHash,
      scenario: scenario.name,
      seedRoot: config.seedRoot,
      runs: config.runs,
      hours: config.hours,
      idleRegenBp: config.idleRegenBp,
      levels: config.levels,
      bossLevels: config.bossLevels,
      hourLevels: config.hourLevels,
      cellPotions: scenario.cellPotions,
      bossPotions: scenario.bossPotions,
      idlePotionsPerHour: scenario.idlePotionsPerHour,
      liveRoute: scenario.liveRoute,
    },
    cells,
    boss,
    hourly,
  };
}
