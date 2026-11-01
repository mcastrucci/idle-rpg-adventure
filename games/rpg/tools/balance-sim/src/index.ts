/**
 * @rpg/balance-sim — offline Monte Carlo balance reports over compiled RPG content (issue #24): TTK, win rate, HP and
 * potion use per encounter group, mini-boss success with automation vs an attentive live script, and XP/gold per hour
 * for idle activities vs a scripted live route, compared against the provisional Region 1 targets. A dev tool: it is
 * never imported by apps or server code, and its numbers are measurements, not balance decisions.
 */
export { BALANCE_SIM_TOOL, SECTIONS, runBalance } from './run.ts';
export type { BalanceConfig, BalanceReport, ReportHeader, Section } from './run.ts';
export { DEFAULT_CONTENT_ROOT, balanceContentFromBundle, loadBalanceContent } from './content.ts';
export type { BalanceContent } from './content.ts';
export { BULWARK, REGION_1_SCENARIO, THORNBLADE } from './scenario.ts';
export type { HeroBuildDef, HeroLoadout, LiveRouteDef, Scenario } from './scenario.ts';
export {
  HERO_ID,
  MAX_FIGHT_TICKS,
  aggregateFights,
  distinctGroups,
  fight,
  heroBuild,
  heroMaxHp,
  idleHourSpec,
  liveHourSpec,
  runBoss,
  runCell,
  runHours,
  simulateHour,
  toGroup,
} from './simulate.ts';
export type { BossRow, CellRow, EncounterGroup, FightResult, FightStats, HourRow, HourSpec, PolicyMode } from './simulate.ts';
export { attentiveLivePolicy, nextTelegraphResolveTick } from './policies.ts';
export { rollLoot } from './loot.ts';
export { evaluateTargets, BOSS_TARGETS, TTK_TARGETS, TOLERANCE } from './targets.ts';
export type { TargetCheck, TargetStatus } from './targets.ts';
export { REPORT_FORMATS, renderCsv, renderJson, renderMarkdown, renderReport } from './report.ts';
export type { ReportFormat } from './report.ts';
export { DEFAULTS, USAGE, parseCliArgs, parseLevels, runCli } from './cli.ts';
export type { CliIo } from './cli.ts';
