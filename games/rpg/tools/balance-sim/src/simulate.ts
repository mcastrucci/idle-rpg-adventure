/**
 * Monte Carlo runners on top of `@rpg/rpg-sim` `runToEnd`:
 *
 * - {@link runCell}: one encounter group × build × level, N independent fights from full HP;
 * - {@link runBoss}: mini-boss attempts with automation only (idle-style) or with the attentive live script;
 * - {@link runHours}: N simulated hours of an idle activity or of the live route, chaining fights with HP carry-over,
 *   between-fight regen and a shared potion supply, rolling XP, gold and loot.
 *
 * Seeds: run `i` of every cell uses `deriveSeed(root, 'balance', i)` as its base (common random numbers across cells,
 * so differences between builds/levels are not seed noise), then labels per purpose. Everything is integer.
 */
import { RngStreams, deriveSeed } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';
import type { EquipmentItem } from '@rpg/rpg-schema';
import { NO_INPUTS, runToEnd } from '@rpg/rpg-sim';
import type { CombatPolicy, EnemySetup, HeroSetup } from '@rpg/rpg-sim';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';
import type { DeriveStatsInput } from '@rpg/rpg-stats';

import type { BalanceContent } from './content.ts';
import { rollLoot } from './loot.ts';
import { meanInt, meanX100, percentile, ratioBp, sortedAsc } from './math.ts';
import { attentiveLivePolicy } from './policies.ts';
import type { HeroBuildDef, HeroLoadout, Scenario } from './scenario.ts';

export const HERO_ID = 'hero:1';

/** Safety cap per fight; a fight that reaches it counts as a timeout (and as a loss for success rates). */
export const MAX_FIGHT_TICKS = 3000;

export interface GroupMember {
  readonly enemy: string;
  readonly count: number;
}

export interface EncounterGroup {
  /** Canonical key: members sorted by enemy ID, `enemy:a×2+enemy:b×1`. */
  readonly key: string;
  /** Short label: `glowcap_mite ×3`, `thornback_boar + glowcap_mite`. */
  readonly label: string;
  readonly members: readonly GroupMember[];
  /** Highest enemy level in the group. */
  readonly level: number;
}

export type PolicyMode = 'auto' | 'live';

function slug(enemyId: string): string {
  return enemyId.slice(enemyId.indexOf(':') + 1);
}

/** Canonical group of an encounter-table entry (member order and duplicates normalised). */
export function toGroup(entry: { readonly enemies: readonly GroupMember[] }, content: BalanceContent): EncounterGroup {
  const counts = new Map<string, number>();
  for (const m of entry.enemies) counts.set(m.enemy, (counts.get(m.enemy) ?? 0) + m.count);
  const members = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([enemy, count]) => ({ enemy, count }));
  const level = Math.max(...members.map((m) => content.combat.enemies[m.enemy]?.level ?? 0));
  return {
    key: members.map((m) => `${m.enemy}×${m.count}`).join('+'),
    label: members.map((m) => (m.count > 1 ? `${slug(m.enemy)} ×${m.count}` : slug(m.enemy))).join(' + '),
    members,
    level,
  };
}

/** Distinct groups of the given encounter tables, excluding boss groups, sorted by (level, key). */
export function distinctGroups(content: BalanceContent, tableIds: readonly string[]): EncounterGroup[] {
  const out = new Map<string, EncounterGroup>();
  for (const id of tableIds) {
    const table = content.encounterTables[id];
    if (table === undefined) throw new Error(`unknown encounter table ${id}`);
    for (const entry of table.entries) {
      if (entry.enemies.some((m) => content.combat.enemies[m.enemy]?.rank === 'boss')) continue;
      const g = toGroup(entry, content);
      if (!out.has(g.key)) out.set(g.key, g);
    }
  }
  return [...out.values()].sort((a, b) => a.level - b.level || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function heroBuild(build: HeroBuildDef, level: number, content: BalanceContent): DeriveStatsInput {
  const attributes = build.attributesByLevel[level];
  if (attributes === undefined) throw new Error(`build ${build.key} has no attributes for level ${level}`);
  const equipment = build.gearByLevel(level).map((id): EquipmentItem => {
    const item = content.combat.items[id];
    if (item?.kind !== 'equipment') throw new Error(`build ${build.key}: ${id} is not an equipment item`);
    return item;
  });
  return { level, attributes, equipment };
}

export function heroMaxHp(build: DeriveStatsInput): number {
  return deriveStats(build, DEFAULT_STAT_FORMULAS).maxHp;
}

function enemySetups(group: EncounterGroup): EnemySetup[] {
  const out: EnemySetup[] = [];
  for (const m of group.members) {
    for (let k = 1; k <= m.count; k++) out.push({ id: `${m.enemy}#${k}`, enemy: m.enemy });
  }
  return out;
}

export interface FightInput {
  readonly content: BalanceContent;
  readonly build: DeriveStatsInput;
  readonly loadout: HeroLoadout;
  readonly group: EncounterGroup;
  readonly potion: string;
  readonly potions: number;
  readonly hp?: number;
  readonly policy: CombatPolicy;
  readonly seed: Seed;
}

export interface FightResult {
  readonly outcome: 'victory' | 'defeat' | 'timeout';
  readonly ticks: number;
  readonly hpEnd: number;
  readonly potionsUsed: number;
}

export function fight(input: FightInput): FightResult {
  const hero: HeroSetup = {
    id: HERO_ID,
    build: input.build,
    skills: input.loadout.skills,
    rules: input.loadout.rules,
    consumables: input.potions > 0 ? [{ item: input.potion, qty: input.potions }] : [],
    ...(input.hp === undefined ? {} : { hp: input.hp }),
  };
  const run = runToEnd(
    { heroes: [hero], enemies: enemySetups(input.group), content: input.content.combat },
    input.seed,
    input.policy,
    MAX_FIGHT_TICKS,
  );
  const h = run.state.actors.find((a) => a.id === HERO_ID);
  const left = h?.consumables.find((c) => c.item === input.potion)?.qty ?? 0;
  return { outcome: run.outcome, ticks: run.ticks, hpEnd: h?.hp ?? 0, potionsUsed: input.potions - left };
}

function policyFor(mode: PolicyMode, build: HeroBuildDef, loadout: HeroLoadout): CombatPolicy {
  if (mode === 'auto') return NO_INPUTS;
  const equipped = (s: string | undefined): string | undefined => (s !== undefined && loadout.skills.includes(s) ? s : undefined);
  return attentiveLivePolicy({ heroId: HERO_ID, guard: equipped(build.live.guard), cleanse: equipped(build.live.cleanse) });
}

/** Aggregates of N fights. Rates in bp, means in hundredths, TTK percentiles over wins only. */
export interface FightStats {
  readonly runs: number;
  readonly wins: number;
  readonly deaths: number;
  readonly timeouts: number;
  readonly winBp: number;
  readonly ttkP10: number | null;
  readonly ttkP50: number | null;
  readonly ttkP90: number | null;
  /** Mean net HP lost, bp of max HP (a death counts as 100%). */
  readonly hpLostBp: number;
  /** Mean potions used per fight, hundredths. */
  readonly potionsX100: number;
  /** Mean potions used in won fights, hundredths. */
  readonly winPotionsX100: number;
}

export function aggregateFights(results: readonly FightResult[], maxHp: number): FightStats {
  const winTicks: number[] = [];
  let deaths = 0;
  let timeouts = 0;
  let hpLostBpSum = 0;
  let potions = 0;
  let winPotions = 0;
  for (const r of results) {
    potions += r.potionsUsed;
    if (r.outcome === 'victory') {
      winTicks.push(r.ticks);
      winPotions += r.potionsUsed;
    } else if (r.outcome === 'defeat') deaths++;
    else timeouts++;
    hpLostBpSum += ratioBp(Math.max(0, maxHp - r.hpEnd), maxHp);
  }
  const sorted = sortedAsc(winTicks);
  return {
    runs: results.length,
    wins: winTicks.length,
    deaths,
    timeouts,
    winBp: ratioBp(winTicks.length, results.length),
    ttkP10: percentile(sorted, 10),
    ttkP50: percentile(sorted, 50),
    ttkP90: percentile(sorted, 90),
    hpLostBp: meanInt(hpLostBpSum, results.length),
    potionsX100: meanX100(potions, results.length),
    winPotionsX100: meanX100(winPotions, winTicks.length),
  };
}

export interface RunOptions {
  readonly seedRoot: Seed;
  readonly runs: number;
}

export interface CellRow {
  readonly group: EncounterGroup;
  readonly build: string;
  readonly level: number;
  readonly stats: FightStats;
}

/** One group × build × level: `runs` automation-only fights from full HP with `scenario.cellPotions` potions. */
export function runCell(
  content: BalanceContent,
  scenario: Scenario,
  group: EncounterGroup,
  build: HeroBuildDef,
  level: number,
  opts: RunOptions,
): CellRow {
  const b = heroBuild(build, level, content);
  const results: FightResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    results.push(
      fight({
        content,
        build: b,
        loadout: build.loadout,
        group,
        potion: scenario.potion,
        potions: scenario.cellPotions,
        policy: NO_INPUTS,
        seed: deriveSeed(deriveSeed(opts.seedRoot, 'balance', i), 'cell'),
      }),
    );
  }
  return { group, build: build.key, level, stats: aggregateFights(results, heroMaxHp(b)) };
}

export interface BossRow {
  readonly build: string;
  readonly level: number;
  readonly mode: PolicyMode;
  readonly stats: FightStats;
}

/** Mini-boss attempts with the boss loadout and `scenario.bossPotions` potions. */
export function runBoss(
  content: BalanceContent,
  scenario: Scenario,
  build: HeroBuildDef,
  level: number,
  mode: PolicyMode,
  opts: RunOptions,
): BossRow {
  const b = heroBuild(build, level, content);
  const group = toGroup({ enemies: [{ enemy: scenario.boss, count: 1 }] }, content);
  const policy = policyFor(mode, build, build.bossLoadout);
  const results: FightResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    results.push(
      fight({
        content,
        build: b,
        loadout: build.bossLoadout,
        group,
        potion: scenario.potion,
        potions: scenario.bossPotions,
        policy,
        seed: deriveSeed(deriveSeed(opts.seedRoot, 'balance', i), 'boss'),
      }),
    );
  }
  return { build: build.key, level, mode, stats: aggregateFights(results, heroMaxHp(b)) };
}

/** An hourly activity: an idle activity from content or the scenario's live route. */
export interface HourSpec {
  /** Report label, e.g. `idle:region_1.hunt` or `live:route`. */
  readonly activity: string;
  readonly mode: PolicyMode;
  readonly encountersPerHour: number;
  /** Weighted groups rolled per encounter. */
  readonly groups: readonly { readonly weight: number; readonly group: EncounterGroup }[];
  /** Groups skipped at no time cost (re-rolled). */
  readonly skip: (group: EncounterGroup) => boolean;
  readonly regenBp: number;
  readonly potions: number;
  /** Resource rolls per hour (idle `resourceYields`). */
  readonly resourceRolls: readonly { readonly lootTable: string; readonly rollsPerHour: number }[];
  /** Share of gold and loot kept after a death, bp (idle: 50% expedition penalty). */
  readonly deathKeepBp: number;
}

export function idleHourSpec(content: BalanceContent, scenario: Scenario, activityId: string, regenBp: number): HourSpec {
  const activity = content.idleActivities[activityId];
  if (activity === undefined) throw new Error(`unknown idle activity ${activityId}`);
  const table = activity.encounterTable === undefined ? undefined : content.encounterTables[activity.encounterTable];
  return {
    activity: activityId,
    mode: 'auto',
    encountersPerHour: activity.encountersPerHour,
    groups: (table?.entries ?? []).map((e) => ({ weight: e.weight, group: toGroup(e, content) })),
    skip: () => false,
    regenBp,
    potions: scenario.idlePotionsPerHour,
    resourceRolls: activity.resourceYields.map((y) => ({ lootTable: y.lootTable, rollsPerHour: y.rollsPerHour })),
    deathKeepBp: 5000,
  };
}

export function liveHourSpec(content: BalanceContent, scenario: Scenario): HourSpec {
  const route = scenario.liveRoute;
  const tables = route.tables.map((id) => {
    const table = content.encounterTables[id];
    if (table === undefined) throw new Error(`unknown encounter table ${id}`);
    return { table, total: table.entries.reduce((s, e) => s + e.weight, 0) };
  });
  // Tables are visited uniformly: scale each table's weights to a common total (the product of all totals).
  const common = tables.reduce((p, t) => p * t.total, 1);
  const groups = tables.flatMap(({ table, total }) =>
    table.entries.map((e) => ({ weight: e.weight * (common / total), group: toGroup(e, content) })),
  );
  const skipSet = new Set(route.skipGroupsOnlyOf);
  return {
    activity: 'live:route',
    mode: 'live',
    encountersPerHour: route.encountersPerHour,
    groups,
    skip: (g) => g.members.every((m) => skipSet.has(m.enemy)),
    regenBp: route.restBetweenFightsBp,
    potions: route.potionsPerHour,
    resourceRolls: [],
    deathKeepBp: 5000,
  };
}

export interface HourResult {
  readonly xp: number;
  readonly enemyGold: number;
  readonly vendorValue: number;
  readonly potionsUsed: number;
  readonly died: boolean;
  readonly fights: number;
}

/** Simulates one hour; ends early on a death or timeout (the expedition stops there). */
export function simulateHour(
  content: BalanceContent,
  scenario: Scenario,
  spec: HourSpec,
  build: HeroBuildDef,
  b: DeriveStatsInput,
  seed: Seed,
): HourResult {
  const rng = RngStreams.fromSeed(seed);
  const enc = rng.stream('encounters');
  const loot = rng.stream('loot');
  const maxHp = heroMaxHp(b);
  const policy = policyFor(spec.mode, build, build.loadout);
  const options = spec.groups.map((g) => ({ weight: g.weight, value: g.group }));
  let hp = maxHp;
  let potions = spec.potions;
  let xp = 0;
  let gold = 0;
  let vendor = 0;
  let died = false;
  let fights = 0;
  for (let i = 0; i < spec.encountersPerHour && options.length > 0; i++) {
    let group = enc.pickWeighted(options);
    for (let tries = 0; spec.skip(group) && tries < 100; tries++) group = enc.pickWeighted(options);
    const r = fight({
      content,
      build: b,
      loadout: build.loadout,
      group,
      potion: scenario.potion,
      potions,
      hp,
      policy,
      seed: deriveSeed(seed, 'combat', i),
    });
    fights++;
    potions -= r.potionsUsed;
    if (r.outcome !== 'victory') {
      died = true;
      break;
    }
    for (const m of group.members) {
      const enemy = content.combat.enemies[m.enemy];
      if (enemy === undefined) continue;
      for (let k = 0; k < m.count; k++) {
        xp += enemy.xp;
        const table = enemy.lootTable === undefined ? undefined : content.lootTables[enemy.lootTable];
        if (table === undefined) continue;
        const roll = rollLoot(table, content.combat.items, loot);
        gold += roll.gold;
        vendor += roll.vendorValue;
      }
    }
    hp = Math.min(maxHp, r.hpEnd + Math.floor((maxHp * spec.regenBp) / 10_000));
  }
  // Resource yields accrue over the part of the hour that was actually played.
  const budget = spec.encountersPerHour;
  for (const y of spec.resourceRolls) {
    const table = content.lootTables[y.lootTable];
    if (table === undefined) throw new Error(`unknown loot table ${y.lootTable}`);
    const rolls = died && budget > 0 ? Math.floor((y.rollsPerHour * fights) / budget) : y.rollsPerHour;
    for (let k = 0; k < rolls; k++) vendor += rollLoot(table, content.combat.items, loot).vendorValue;
  }
  if (died) {
    gold = Math.floor((gold * spec.deathKeepBp) / 10_000);
    vendor = Math.floor((vendor * spec.deathKeepBp) / 10_000);
  }
  return { xp, enemyGold: gold, vendorValue: vendor, potionsUsed: spec.potions - potions, died, fights };
}

export interface HourRow {
  readonly activity: string;
  readonly build: string;
  readonly level: number;
  readonly hours: number;
  /** Mean per hour (integers, floored). */
  readonly xpPerHour: number;
  readonly enemyGoldPerHour: number;
  readonly vendorPerHour: number;
  readonly grossGoldPerHour: number;
  /** Hundredths. */
  readonly potionsPerHourX100: number;
  readonly fightsPerHourX100: number;
  /** Deaths per hour, bp (each hour ends at its first death). */
  readonly deathsPerHourBp: number;
  readonly xpP10: number | null;
  readonly xpP50: number | null;
  readonly xpP90: number | null;
}

export function runHours(
  content: BalanceContent,
  scenario: Scenario,
  spec: HourSpec,
  build: HeroBuildDef,
  level: number,
  opts: { readonly seedRoot: Seed; readonly hours: number },
): HourRow {
  const b = heroBuild(build, level, content);
  const results: HourResult[] = [];
  for (let i = 0; i < opts.hours; i++) {
    results.push(simulateHour(content, scenario, spec, build, b, deriveSeed(deriveSeed(opts.seedRoot, 'balance', i), 'hour', spec.activity)));
  }
  const sum = (f: (r: HourResult) => number): number => results.reduce((s, r) => s + f(r), 0);
  const n = results.length;
  const xps = sortedAsc(results.map((r) => r.xp));
  const enemyGold = meanInt(sum((r) => r.enemyGold), n);
  const vendor = meanInt(sum((r) => r.vendorValue), n);
  return {
    activity: spec.activity,
    build: build.key,
    level,
    hours: n,
    xpPerHour: meanInt(sum((r) => r.xp), n),
    enemyGoldPerHour: enemyGold,
    vendorPerHour: vendor,
    grossGoldPerHour: meanInt(sum((r) => r.enemyGold + r.vendorValue), n),
    potionsPerHourX100: meanX100(sum((r) => r.potionsUsed), n),
    fightsPerHourX100: meanX100(sum((r) => r.fights), n),
    deathsPerHourBp: ratioBp(sum((r) => (r.died ? 1 : 0)), n),
    xpP10: percentile(xps, 10),
    xpP50: percentile(xps, 50),
    xpP90: percentile(xps, 90),
  };
}
