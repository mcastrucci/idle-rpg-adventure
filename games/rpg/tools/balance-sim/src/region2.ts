/**
 * Region 2 fixed-cohort measurements. These are explicit scenario inputs, not acquisition or economy simulations.
 * All fights use the compiled content and shared @rpg/rpg-sim combat engine through `fight`.
 */
import { deriveSeed } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';
import { AutomationRulesSchema } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';

import type { BalanceContent } from './content.ts';
import { formatX100 } from './math.ts';
import { aggregateFights, distinctGroups, fight, heroBuild, toGroup } from './simulate.ts';
import type { EncounterGroup, FightResult, PolicyMode } from './simulate.ts';
import { BULWARK, THORNBLADE } from './scenario.ts';
import type { HeroBuildDef, HeroLoadout } from './scenario.ts';
import { attentiveLivePolicy } from './policies.ts';
import { ENGINE_VERSION, NO_INPUTS, runToEnd } from '@rpg/rpg-sim';
import type { CombatEvent, CombatPolicy } from '@rpg/rpg-sim';

export const REGION_2_TABLES = [
  'enc:region_2.shallows',
  'enc:region_2.prism_span',
  'enc:region_2.resonance_court',
] as const;
export const REGION_2_BOSS = 'enemy:region_2.resonant_warden';

export interface Region2Cohort {
  readonly key: string;
  readonly label: string;
  readonly level: 4 | 5;
  readonly gear: 'starter' | 'farmed';
  readonly supplies: 'fresh' | 'farmed' | 'farmed-no-healing' | 'farmed-no-tonic';
}

export const REGION_2_COHORTS: readonly Region2Cohort[] = [
  { key: 'fresh-l4', label: 'Fresh R1 clear · L4', level: 4, gear: 'starter', supplies: 'fresh' },
  { key: 'l5-starter', label: 'L5 starter gear · fresh supplies', level: 5, gear: 'starter', supplies: 'fresh' },
  { key: 'l5-farmed-gear', label: 'L5 farmed gear · fresh supplies', level: 5, gear: 'farmed', supplies: 'fresh' },
  { key: 'l5-farmed-supplies', label: 'L5 starter gear · farmed supplies', level: 5, gear: 'starter', supplies: 'farmed' },
  { key: 'l5-farmed', label: 'L5 farmed gear · farmed supplies', level: 5, gear: 'farmed', supplies: 'farmed' },
  { key: 'l5-farmed-no-healing', label: 'L5 farmed · no healing potion', level: 5, gear: 'farmed', supplies: 'farmed-no-healing' },
  { key: 'l5-farmed-no-tonic', label: 'L5 farmed · no sap tonic', level: 5, gear: 'farmed', supplies: 'farmed-no-tonic' },
];

export type SupplyInventory = readonly { readonly item: string; readonly qty: number }[];
export const FRESH_SUPPLIES: SupplyInventory = [
  { item: 'item:minor_healing_potion', qty: 4 },
  { item: 'item:sap_tonic', qty: 2 },
  { item: 'item:healing_potion', qty: 0 },
];
export const FARMED_SUPPLIES: SupplyInventory = [
  { item: 'item:minor_healing_potion', qty: 8 },
  { item: 'item:sap_tonic', qty: 3 },
  { item: 'item:healing_potion', qty: 2 },
];

const starterGear: Readonly<Record<string, readonly string[]>> = {
  bulwark: ['item:rusty_sword', 'item:padded_vest', 'item:wooden_buckler'],
  thornblade: ['item:rusty_sword', 'item:padded_vest'],
};
const farmedGear: Readonly<Record<string, readonly string[]>> = {
  bulwark: ['item:rusty_sword', 'item:padded_vest', 'item:tiller_plate_buckler'],
  thornblade: ['item:sapforged_blade', 'item:padded_vest', 'item:lantern_lens'],
};

function snapshotBuild(base: HeroBuildDef, cohort: Region2Cohort): HeroBuildDef {
  const gear = (cohort.gear === 'farmed' ? farmedGear : starterGear)[base.key];
  if (gear === undefined) throw new Error(`no R2 reference gear for build ${base.key}`);
  return { ...base, gearByLevel: () => gear };
}

export function cohortInventory(cohort: Region2Cohort): SupplyInventory {
  switch (cohort.supplies) {
    case 'fresh': return FRESH_SUPPLIES;
    case 'farmed': return FARMED_SUPPLIES;
    case 'farmed-no-healing': return FARMED_SUPPLIES.map((x) => x.item === 'item:healing_potion' ? { ...x, qty: 0 } : x);
    case 'farmed-no-tonic': return FARMED_SUPPLIES.map((x) => x.item === 'item:sap_tonic' ? { ...x, qty: 0 } : x);
  }
}

const MINOR_POTION = 'item:minor_healing_potion';
const HEALING_POTION = 'item:healing_potion';
const SAP_TONIC = 'item:sap_tonic';

/** R2-only six-rule policies: preserve guard, spend the stronger potion first, and use tonics against DoTs. */
function region2Loadouts(build: HeroBuildDef): { readonly common: HeroLoadout; readonly boss: HeroLoadout } {
  const commonRules = build.key === 'bulwark'
    ? [
        { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
        { when: { selfHpBelowBp: 5500, hasConsumable: HEALING_POTION }, do: { useConsumable: HEALING_POTION } },
        { when: { selfHpBelowBp: 4000, hasConsumable: MINOR_POTION }, do: { useConsumable: MINOR_POTION } },
        { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
        { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
        { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
      ]
    : [
        { when: { selfHasHarmfulEffect: true, skillReady: 'skill:second_wind' }, do: { useSkill: 'skill:second_wind' } },
        { when: { selfHpBelowBp: 5500, hasConsumable: HEALING_POTION }, do: { useConsumable: HEALING_POTION } },
        { when: { selfHpBelowBp: 4000, hasConsumable: MINOR_POTION }, do: { useConsumable: MINOR_POTION } },
        { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
        { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
        { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
      ];
  const bossRules = build.key === 'bulwark'
    ? [
        { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
        { when: { selfHasHarmfulEffect: true, hasConsumable: SAP_TONIC }, do: { useConsumable: SAP_TONIC } },
        { when: { selfHpBelowBp: 5500, hasConsumable: HEALING_POTION }, do: { useConsumable: HEALING_POTION } },
        { when: { selfHpBelowBp: 4000, hasConsumable: MINOR_POTION }, do: { useConsumable: MINOR_POTION } },
        { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
        { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
      ]
    : [
        { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
        { when: { selfHasHarmfulEffect: true, hasConsumable: SAP_TONIC }, do: { useConsumable: SAP_TONIC } },
        { when: { selfHpBelowBp: 5500, hasConsumable: HEALING_POTION }, do: { useConsumable: HEALING_POTION } },
        { when: { selfHpBelowBp: 4000, hasConsumable: MINOR_POTION }, do: { useConsumable: MINOR_POTION } },
        { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
        { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
      ];
  return {
    common: { skills: build.loadout.skills, rules: AutomationRulesSchema.parse(commonRules) },
    boss: { skills: build.bossLoadout.skills, rules: AutomationRulesSchema.parse(bossRules) },
  };
}

/** Validate that an assumed loadout is equippable at its snapshot level and doesn't occupy a slot twice. */
export function validateCohortGear(content: BalanceContent, build: HeroBuildDef, level: number): void {
  const slots = new Set<string>();
  for (const id of build.gearByLevel(level)) {
    const item = content.combat.items[id];
    if (item?.kind !== 'equipment') throw new Error(`cohort gear ${id} is not equipment`);
    if (item.levelRequired !== undefined && item.levelRequired > level) {
      throw new Error(`cohort gear ${id} requires level ${item.levelRequired}, above cohort level ${level}`);
    }
    if (slots.has(item.slot)) throw new Error(`cohort gear occupies ${item.slot} more than once`);
    slots.add(item.slot);
  }
}

function validateCohortInventory(content: BalanceContent, inventory: SupplyInventory): void {
  const seen = new Set<string>();
  for (const { item: id, qty } of inventory) {
    if (!Number.isSafeInteger(qty) || qty < 0) throw new Error(`invalid cohort inventory quantity for ${id}`);
    if (seen.has(id)) throw new Error(`duplicate cohort inventory stack for ${id}`);
    seen.add(id);
    if (content.combat.items[id]?.kind !== 'consumable') throw new Error(`cohort supply ${id} is not a compiled consumable`);
  }
}

export interface Region2FightStats {
  readonly runs: number;
  readonly wins: number;
  readonly deaths: number;
  readonly timeouts: number;
  readonly winBp: number;
  readonly ticksP10: number | null;
  readonly ticksP50: number | null;
  readonly ticksP90: number | null;
  readonly hpLostBp: number;
  readonly usedPerTrial: Readonly<Record<string, number>>;
  readonly usedPerWin: Readonly<Record<string, number | null>>;
}

function itemMeans(results: readonly FightResult[], inventory: SupplyInventory, winsOnly: false): Record<string, number>;
function itemMeans(results: readonly FightResult[], inventory: SupplyInventory, winsOnly: true): Record<string, number | null>;
function itemMeans(results: readonly FightResult[], inventory: SupplyInventory, winsOnly: boolean): Record<string, number | null> {
  const selected = winsOnly ? results.filter((r) => r.outcome === 'victory') : results;
  const out: Record<string, number | null> = {};
  for (const { item } of inventory) {
    const total = selected.reduce((sum, result) => sum + (result.inventoryUsed?.[item] ?? 0), 0);
    out[item] = selected.length === 0 ? (winsOnly ? null : 0) : Math.round((total * 100) / selected.length);
  }
  return out;
}

function region2Stats(results: readonly FightResult[], content: BalanceContent, build: HeroBuildDef, level: number, inventory: SupplyInventory): Region2FightStats {
  const derived = heroBuild(build, level, content);
  const maxHp = deriveStats(derived, DEFAULT_STAT_FORMULAS).maxHp;
  const aggregate = aggregateFights(results, maxHp);
  return {
    runs: aggregate.runs,
    wins: aggregate.wins,
    deaths: aggregate.deaths,
    timeouts: aggregate.timeouts,
    winBp: aggregate.winBp,
    ticksP10: aggregate.ttkP10,
    ticksP50: aggregate.ttkP50,
    ticksP90: aggregate.ttkP90,
    hpLostBp: aggregate.hpLostBp,
    usedPerTrial: itemMeans(results, inventory, false),
    usedPerWin: itemMeans(results, inventory, true),
  };
}

export interface Region2CellRow {
  readonly cohort: string;
  readonly build: string;
  readonly level: number;
  readonly group: EncounterGroup;
  readonly stats: Region2FightStats;
}
export interface Region2BossRow extends Omit<Region2CellRow, 'group'> {
  readonly mode: PolicyMode;
}
export interface Region2CounterTrace {
  readonly cohort: string;
  readonly build: string;
  readonly mode: PolicyMode;
  readonly signalHits: number;
  readonly guardedSignalHits: number;
  readonly signalDamageMean: number;
  readonly brambleDotsApplied: number;
  readonly cleansedDots: number;
  readonly tonicsUsed: number;
  readonly secondWindActions: number;
}
export interface Region2Report {
  readonly engineVersion: string;
  readonly contentHash: string;
  readonly seedRoot: Seed;
  readonly runs: number;
  readonly command: string;
  readonly cohortInputs: readonly {
    readonly cohort: Region2Cohort;
    readonly build: string;
    readonly attributes: Readonly<Record<string, number>>;
    readonly inventory: SupplyInventory;
    readonly supplyCostGoldAssumption: number;
    readonly gear: readonly string[];
    readonly commonSkills: readonly string[];
    readonly bossSkills: readonly string[];
    readonly commonRules: HeroLoadout['rules'];
    readonly bossRules: HeroLoadout['rules'];
  }[];
  readonly cells: readonly Region2CellRow[];
  readonly boss: readonly Region2BossRow[];
  readonly counterTraces: readonly Region2CounterTrace[];
}

function region2Policy(mode: PolicyMode, build: HeroBuildDef, loadout: HeroLoadout): CombatPolicy {
  if (mode === 'auto') return NO_INPUTS;
  return attentiveLivePolicy({
    heroId: 'hero:1',
    ...(build.live.guard === undefined || !loadout.skills.includes(build.live.guard) ? {} : { guard: build.live.guard }),
    ...(build.live.cleanse === undefined || !loadout.skills.includes(build.live.cleanse) ? {} : { cleanse: build.live.cleanse }),
  });
}

/** One seed-index-0 event trace per fresh build/mode makes counter use directly auditable beside aggregate rows. */
function counterTrace(
  content: BalanceContent,
  cohort: Region2Cohort,
  build: HeroBuildDef,
  loadout: HeroLoadout,
  inventory: SupplyInventory,
  mode: PolicyMode,
  seed: Seed,
): Region2CounterTrace {
  const hero = {
    id: 'hero:1',
    build: heroBuild(build, cohort.level, content),
    skills: loadout.skills,
    rules: loadout.rules,
    consumables: inventory.filter((item) => item.qty > 0),
  };
  const run = runToEnd({
    heroes: [hero],
    enemies: [{ id: `${REGION_2_BOSS}#1`, enemy: REGION_2_BOSS }],
    content: content.combat,
  }, seed, region2Policy(mode, build, loadout), 3000);
  const guardUids = new Set<number>();
  let signalHits = 0;
  let guardedSignalHits = 0;
  let signalDamage = 0;
  let brambleDotsApplied = 0;
  let cleansedDots = 0;
  let tonicsUsed = 0;
  let secondWindActions = 0;
  for (const event of run.events as readonly CombatEvent[]) {
    if (event.type === 'EffectApplied' && event.origin === 'skill:guard' && event.targetId === hero.id) guardUids.add(event.effectUid);
    if (event.type === 'EffectExpired' && event.effect === 'stat_mod') guardUids.delete(event.effectUid);
    if (event.type === 'DamageDealt' && event.origin === 'skill:region_2.signal_pulse' && event.targetId === hero.id) {
      signalHits++;
      signalDamage += event.amount;
      if (guardUids.size > 0) guardedSignalHits++;
    }
    if (event.type === 'EffectApplied' && event.effect === 'dot' && event.origin === 'skill:bramble_lash' && event.targetId === hero.id) brambleDotsApplied++;
    if (event.type === 'EffectExpired' && event.effect === 'dot' && event.reason === 'cleansed' && event.targetId === hero.id) cleansedDots++;
    if (event.type === 'ConsumableUsed' && event.item === SAP_TONIC) tonicsUsed++;
    if (event.type === 'ActionStarted' && event.actorId === hero.id && event.action.kind === 'skill' && event.action.skill === 'skill:second_wind') secondWindActions++;
  }
  return {
    cohort: cohort.key,
    build: build.key,
    mode,
    signalHits,
    guardedSignalHits,
    signalDamageMean: signalHits === 0 ? 0 : Math.round((signalDamage * 100) / signalHits),
    brambleDotsApplied,
    cleansedDots,
    tonicsUsed,
    secondWindActions,
  };
}

export function runRegion2Balance(content: BalanceContent, seedRoot: Seed, runs: number, sections: readonly ('cells' | 'boss')[]): Region2Report {
  if (content.combat.enemies[REGION_2_BOSS] === undefined) throw new Error(`missing Region 2 boss ${REGION_2_BOSS}`);
  const tables = REGION_2_TABLES.filter((id) => content.encounterTables[id] !== undefined);
  if (tables.length !== REGION_2_TABLES.length) {
    const missing = REGION_2_TABLES.filter((id) => content.encounterTables[id] === undefined);
    throw new Error(`missing Region 2 encounter tables: ${missing.join(', ')}`);
  }
  const groups = sections.includes('cells') ? distinctGroups(content, tables) : [];
  const cells: Region2CellRow[] = [];
  const boss: Region2BossRow[] = [];
  const counterTraces: Region2CounterTrace[] = [];
  const cohortInputs: Region2Report['cohortInputs'][number][] = [];
  const baseBuilds = [BULWARK, THORNBLADE];
  for (const cohort of REGION_2_COHORTS) {
    const inventory = cohortInventory(cohort);
    validateCohortInventory(content, inventory);
    for (const base of baseBuilds) {
      const build = snapshotBuild(base, cohort);
      const loadouts = region2Loadouts(build);
      validateCohortGear(content, build, cohort.level);
      const attributes = build.attributesByLevel[cohort.level];
      if (attributes === undefined) throw new Error(`missing ${build.key} attributes for level ${cohort.level}`);
      cohortInputs.push({
        cohort,
        build: build.key,
        attributes,
        inventory,
        supplyCostGoldAssumption: supplyCost(inventory),
        gear: build.gearByLevel(cohort.level),
        commonSkills: loadouts.common.skills,
        bossSkills: loadouts.boss.skills,
        commonRules: loadouts.common.rules,
        bossRules: loadouts.boss.rules,
      });
      for (const group of groups) {
        const b = heroBuild(build, cohort.level, content);
        const results: FightResult[] = [];
        for (let i = 0; i < runs; i++) {
          results.push(fight({
            content, build: b, loadout: loadouts.common, group, potion: MINOR_POTION, potions: 0,
            inventory, policy: NO_INPUTS, seed: deriveSeed(deriveSeed(seedRoot, 'balance', i), 'cell'),
          }));
        }
        cells.push({ cohort: cohort.key, build: build.key, level: cohort.level, group, stats: region2Stats(results, content, build, cohort.level, inventory) });
      }
      if (sections.includes('boss')) {
        const group = toGroup({ enemies: [{ enemy: REGION_2_BOSS, count: 1 }] }, content);
        for (const mode of ['auto', 'live'] as const) {
          const loadout: HeroLoadout = loadouts.boss;
          const policy = region2Policy(mode, build, loadout);
          const b = heroBuild(build, cohort.level, content);
          const results: FightResult[] = [];
          for (let i = 0; i < runs; i++) {
            results.push(fight({
              content, build: b, loadout, group, potion: MINOR_POTION, potions: 0,
              inventory, policy, seed: deriveSeed(deriveSeed(seedRoot, 'balance', i), 'boss'),
            }));
          }
          boss.push({ cohort: cohort.key, build: build.key, level: cohort.level, mode, stats: region2Stats(results, content, build, cohort.level, inventory) });
          if (cohort.key === 'fresh-l4' && runs > 0) {
            counterTraces.push(counterTrace(
              content, cohort, build, loadout, inventory, mode,
              deriveSeed(deriveSeed(seedRoot, 'balance', 0), 'boss'),
            ));
          }
        }
      }
    }
  }
  return {
    engineVersion: ENGINE_VERSION,
    contentHash: content.contentHash,
    seedRoot,
    runs,
    command: `pnpm balance-sim --scenario region-2 --runs ${runs} --seed ${seedRoot} --sections ${sections.join(',')} --format md`,
    cohortInputs,
    cells,
    boss,
    counterTraces,
  };
}

/** Markdown report with assumptions and all per-item consumption. */
export function renderRegion2Markdown(report: Region2Report): string {
  const boss = (cohort: string, build: string, mode: PolicyMode): Region2BossRow | undefined =>
    report.boss.find((row) => row.cohort === cohort && row.build === build && row.mode === mode);
  const freshBulwark = boss('fresh-l4', 'bulwark', 'auto');
  const freshThornblade = boss('fresh-l4', 'thornblade', 'auto');
  const farmedBulwark = boss('l5-farmed', 'bulwark', 'auto');
  const farmedThornblade = boss('l5-farmed', 'thornblade', 'auto');
  const freshGroupsAllWin = report.cells.filter((row) => row.cohort === 'fresh-l4').every((row) => row.stats.winBp === 10_000);
  const freshModesAllWin = freshBulwark?.stats.winBp === 10_000 && freshThornblade?.stats.winBp === 10_000;
  const preparedModesAllWin = farmedBulwark?.stats.winBp === 10_000 && farmedThornblade?.stats.winBp === 10_000;
  const sameBossMode = (cohort: string, build: string): boolean => {
    const auto = boss(cohort, build, 'auto')?.stats;
    const live = boss(cohort, build, 'live')?.stats;
    return auto !== undefined && live !== undefined && auto.winBp === live.winBp && auto.ticksP50 === live.ticksP50 && auto.hpLostBp === live.hpLostBp;
  };
  const lines = [
    '# Region 2 balance measurements', '',
    '> Working proposal measurement only. This is not an owner-approved balance decision.', '',
    '| ENGINE_VERSION | contentHash | seed root | N | command |', '|---|---|---:|---:|---|',
    `| ${report.engineVersion} | \`${report.contentHash}\` | ${report.seedRoot} | ${report.runs} | \`${report.command}\` |`, '',
    '## #55 acceptance finding', '',
    freshGroupsAllWin && freshModesAllWin && preparedModesAllWin
      ? `**The proposed fresh-struggles / prepared-succeeds contrast is not demonstrated.** All fresh L4 ordinary groups and both fresh L4 Warden builds are 100.00% wins, and both full farmed L5 Warden builds are also 100.00% wins. Fresh L4 Warden p50 is ${freshBulwark?.stats.ticksP50} ticks / ${bp(freshBulwark?.stats.hpLostBp ?? 0)} HP lost for Bulwark and ${freshThornblade?.stats.ticksP50} / ${bp(freshThornblade?.stats.hpLostBp ?? 0)} for Thornblade; full farmed L5 is ${farmedBulwark?.stats.ticksP50} / ${bp(farmedBulwark?.stats.hpLostBp ?? 0)} and ${farmedThornblade?.stats.ticksP50} / ${bp(farmedThornblade?.stats.hpLostBp ?? 0)}. The proposed prepared Warden bands (≥90% attentive live, ≤60% automation) are not met because both modes win 100%. Authored power 26 is a provisional playtest hypothesis only; these samples do not approve final balance or complete issue #55.`
      : 'The fresh-struggles / prepared-succeeds acceptance contrast should be reviewed against the rows below; this run did not match the all-win failure pattern above.',
    `The live mode is scripted guard/cleanse with automation still enabled, not optimal or manual player performance. Scripted-live and automation aggregate Warden metrics are ${sameBossMode('fresh-l4', 'bulwark') && sameBossMode('fresh-l4', 'thornblade') ? 'identical for both fresh builds' : 'shown separately in the Warden table'}. The fixed seed-index-0 traces below report actual guarded pulse hits and DoT cleansing; they are mechanism checks, not rates across N.`, '',
    '## Cohort inputs', '',
    '| cohort | build | level | STR/AGI/INT/VIT/SPI | gear IDs | carried inventory | supply cost assumption |', '|---|---|---:|---|---|---|---:|',
    ...report.cohortInputs.map((i) => `| ${i.cohort.label} | ${i.build} | ${i.cohort.level} | ${Object.values(i.attributes).join('/')} | ${i.gear.join(', ')} | ${i.inventory.map((x) => `${x.item} ×${x.qty}`).join(', ')} | ${i.supplyCostGoldAssumption}g |`), '',
    '## Reference combat setup', '',
    ...report.cohortInputs.filter((i, index, all) => all.findIndex((x) => x.build === i.build && x.cohort.level === i.cohort.level) === index).flatMap((i) => [
      `### ${i.build} L${i.cohort.level}`,
      `- Common skills: ${i.commonSkills.join(', ')}.`,
      `- Boss skills: ${i.bossSkills.join(', ')}.`,
      `- Common rules: \`${JSON.stringify(i.commonRules)}\`.`,
      `- Boss rules: \`${JSON.stringify(i.bossRules)}\`.`,
      '',
    ]),
    'Fresh/farmed supplies are declared scenario inputs. Gold amounts are arithmetic at the paper\'s current merchant prices (minor healing potion 12g, sap tonic 18g, healing potion 40g); affordability, purchase timing, gear acquisition, route completion, retreat, rest, and travel are not simulated. `used/trial` and `used/win` are mean quantities per item, hundredths; zero means the item was carried but the reference automation did not use it. A `—` per-win value means there were no wins to average. Win-only tick percentiles exclude losses; mean HP lost counts a death as 100%.', '',
    '## Ordinary encounter groups (automation)', '',
    '| cohort | build | group | runs | wins | deaths | timeouts | win | ticks p10/p50/p90 | mean HP lost | used/trial by item | used/win by item |', '|---|---|---|---:|---:|---:|---:|---:|---|---:|---|---|',
    ...report.cells.map((r) => `| ${r.cohort} | ${r.build} L${r.level} | ${r.group.label} | ${r.stats.runs} | ${r.stats.wins} | ${r.stats.deaths} | ${r.stats.timeouts} | ${bp(r.stats.winBp)} | ${ticks(r.stats)} | ${bp(r.stats.hpLostBp)} | ${formatItems(r.stats.usedPerTrial)} | ${formatItems(r.stats.usedPerWin)} |`), '',
    '## Warden (automation and attentive live)', '',
    '| cohort | build | mode | runs | wins | deaths | timeouts | win | ticks p10/p50/p90 | mean HP lost | consumables used/trial by item | used/win by item |', '|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|',
    ...report.boss.map((r) => `| ${r.cohort} | ${r.build} L${r.level} | ${r.mode} | ${r.stats.runs} | ${r.stats.wins} | ${r.stats.deaths} | ${r.stats.timeouts} | ${bp(r.stats.winBp)} | ${ticks(r.stats)} | ${bp(r.stats.hpLostBp)} | ${formatItems(r.stats.usedPerTrial)} | ${formatItems(r.stats.usedPerWin)} |`), '',
    '## Fresh Warden counter-effect traces (seed index 0)', '',
    '| build | mode | guarded signal hits | mean signal damage | bramble DoTs applied / cleansed | tonics used | second_wind actions |', '|---|---|---:|---:|---:|---:|---:|',
    ...report.counterTraces.map((r) => `| ${r.build} | ${r.mode} | ${r.guardedSignalHits}/${r.signalHits} | ${formatX100(r.signalDamageMean)} | ${r.brambleDotsApplied} / ${r.cleansedDots} | ${r.tonicsUsed} | ${r.secondWindActions} |`), '',
    '## Limitations', '',
    '- Per-encounter samples start at full HP and use the compiled encounters, enemy stats, skills, rules, and current shared combat implementation. Every cohort comparison uses paired seed indices.',
    '- R2 uses isolated six-rule boss policies based on the reference builds. Guard has priority; boss runs then cleanse with a sap tonic, use a full healing potion below 55% HP, and use a minor potion below 40% HP. Bulwark replaces a lower-priority shield-bash offense rule with Mend below 55% HP so its equipped heal remains available; Thornblade automation uses tonic cleansing while attentive live can use its equipped `second_wind`. The choice keeps R1 reference policies unchanged and spends one offense slot for boss sustain. Common encounters have no harmful effects, so carried tonics are not expected to be used there. Zero-stock item rules do not fire.',
    '- “Scripted live” means automation remains enabled while the existing attentive script adds guard/cleanse inputs; it is not an estimate of optimal or manual player performance. Counter-effect traces replay one fresh L4 fight per build and mode at seed index 0. They prove event ordering and effect application for that sample; they are not a population counter rate. The script does not simulate routing or acquisition history.',
    '- Proposed target bands remain provisional; results are measurements only. No combat formulas or target multipliers are changed by this tool.', '',
  ];
  return lines.join('\n');
}

export function renderRegion2Json(report: Region2Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function bp(n: number): string { return `${(n / 100).toFixed(2)}%`; }
function ticks(s: Region2FightStats): string { return [s.ticksP10, s.ticksP50, s.ticksP90].map((x) => x ?? '–').join(' / '); }
function formatItems(items: Readonly<Record<string, number | null>>): string {
  return Object.entries(items).map(([id, x100]) => `${id}: ${x100 === null ? '—' : (x100 / 100).toFixed(2)}`).join('<br>');
}
function supplyCost(inventory: SupplyInventory): number {
  const prices: Readonly<Record<string, number>> = {
    'item:minor_healing_potion': 12,
    'item:sap_tonic': 18,
    'item:healing_potion': 40,
  };
  return inventory.reduce((sum, { item, qty }) => sum + (prices[item] ?? 0) * qty, 0);
}

