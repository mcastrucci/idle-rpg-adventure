/**
 * Bounded Region 1 evidence pass on the production idle combat/reward/settlement path.
 * Run from the repo root with: node games/rpg/tools/balance-sim/src/runtime-pass.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { compileContentDirectory, formatErrors } from '@engine/content-compiler';
import { BP_SCALE, deriveSeed } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';
import rpgContentPlugin from '@rpg/content-plugin';
import { applyDeathXpLoss, totalXpAtLevelStart } from '@rpg/rpg-stats';
import { AutomationRulesSchema, EquipmentItemSchema, XpCurveSchema } from '@rpg/rpg-schema';
import type { EquipmentItem } from '@rpg/rpg-schema';
import {
  DEFAULT_RPG_IDLE_TUNING,
  RPG_IDLE_SIMULATOR_VERSION,
  GOLD_CURRENCY,
  idleBudget,
  rpgIdleContentFromBundle,
  rpgProgress,
  settleIdle,
  simulateIdle,
} from '@rpg/rpg-sim';
import type { RpgActorSnapshot, RpgIdleTuning } from '@rpg/rpg-sim';
import { ENGINE_VERSION } from '@rpg/rpg-sim';

const CONTENT_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
const ACTIVITY = 'idle:region_1.hunt';
const ACTOR_ID = 'runtime-pass:starter';
const LEVELS = [1, 3, 5] as const;
const SUPPLY_COUNTS = [0, 5] as const;
const RUNS = 100;
const SEED_ROOT = 56;
const STARTER_KIT: readonly { id: string; slot: EquipmentItem['slot'] }[] = [
  { id: 'item:rusty_sword', slot: 'weapon' }, { id: 'item:padded_vest', slot: 'chest' }, { id: 'item:wooden_buckler', slot: 'offhand' },
];

// Mirrors PROVISIONAL_STARTER_ATTRIBUTES / starter skills and rules in server characters/validation.ts.
// L1/L3/L5 are character levels only: level-up grants no attribute points under the current open decision #13.
const STARTER_ATTRIBUTES = Object.freeze({ STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 });
const STARTER_SKILLS = Object.freeze([
  'skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend',
]);
const STARTER_RULES = AutomationRulesSchema.parse([
  { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
  { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
  { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
  { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
  // An allowed sixth rule makes a carried, finite potion supply available to actual automation.
  { when: { selfHpBelowBp: 4000, hasConsumable: 'item:minor_healing_potion' }, do: { useConsumable: 'item:minor_healing_potion' } },
  { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
]);

export interface RuntimePassRow {
  readonly level: number;
  readonly carriedPotions: number;
  readonly model: 'idle-default-regen' | 'idle-no-regen-counterfactual';
  readonly runs: number;
  readonly meanSegments: number;
  readonly deaths: number;
  readonly timeouts: number;
  readonly meanCombatTicks: number;
  readonly grossXpPerRequestedHour: number;
  readonly netXpPerRequestedHour: number;
  readonly meanDeathXpLossPerRun: number;
  readonly meanGoldRetained: number;
  readonly meanItemsRetained: Readonly<Record<string, number>>;
  readonly meanPotionsUsed: number;
}

export interface RuntimePassReport {
  readonly engineVersion: string;
  readonly idleSimulatorVersion: string;
  readonly contentHash: string;
  readonly seedRoot: number;
  readonly command: string;
  readonly runsPerCell: number;
  readonly activity: string;
  readonly plannedBudget: number;
  readonly rows: readonly RuntimePassRow[];
}

/** Summarize only pure bag grants from settled deltas; escrow returns/burns are not new loot. */
export function summarizeRetainedBag(deltas: readonly {
  readonly from?: string;
  readonly qty: number;
  readonly asset: { readonly kind: string; readonly currency?: string; readonly item?: string };
}[]): { gold: number; items: Readonly<Record<string, number>> } {
  let gold = 0;
  const items = new Map<string, number>();
  for (const delta of deltas) {
    if (delta.from !== undefined) continue;
    if (delta.asset.kind === 'currency' && delta.asset.currency === GOLD_CURRENCY) gold += delta.qty;
    else if (delta.asset.kind === 'stack' && delta.asset.item !== undefined) items.set(delta.asset.item, (items.get(delta.asset.item) ?? 0) + delta.qty);
  }
  return { gold, items: Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function actor(level: number, equipment: readonly EquipmentItem[] = []): RpgActorSnapshot {
  return {
    actorId: ACTOR_ID,
    build: { level, attributes: { ...STARTER_ATTRIBUTES }, equipment: equipment.map(({ stats }) => ({ stats })) },
    skills: [...STARTER_SKILLS],
    rules: [...STARTER_RULES],
  };
}

function runCell(
  content: ReturnType<typeof rpgIdleContentFromBundle>,
  curve: ReturnType<typeof XpCurveSchema.parse>,
  level: number,
  carriedPotions: number,
  tuning: RpgIdleTuning,
  model: RuntimePassRow['model'],
  runs: number,
  budget: number,
  seedRoot: Seed,
  equipment: readonly EquipmentItem[] = [],
): RuntimePassRow {
  let segments = 0;
  let deaths = 0;
  let timeouts = 0;
  let combatTicks = 0;
  let grossXp = 0;
  let netXp = 0;
  let deathXpLost = 0;
  let potionsUsed = 0;
  let goldRetained = 0;
  const items = new Map<string, number>();
  const startXp = totalXpAtLevelStart(level, curve);

  for (let i = 0; i < runs; i++) {
    const timeline = simulateIdle(content, 'hunt', tuning, {
      config: {
        consumables: carriedPotions === 0 ? [] : [{ item: 'item:minor_healing_potion', qty: carriedPotions }],
        retreat: { belowHpBp: 0, onlyWhenNoHealing: false },
      },
      actors: [actor(level, equipment)],
      seed: deriveSeed(seedRoot, 'runtime-pass', i),
      budget,
      activityId: ACTIVITY,
    });
    const events = timeline.segments.flatMap((segment) => segment.events);
    const fights = events.filter((event) => event.type === 'encounter');
    const progress = rpgProgress(timeline, timeline.segments.length - 1, 'completed');
    const hero = progress.actors.find((entry) => entry.actorId === ACTOR_ID);
    if (hero === undefined) throw new Error('runtime pass timeline did not credit its actor');
    const kept = settleIdle(tuning, timeline, timeline.segments.length - 1, 'completed');
    const bag = summarizeRetainedBag(kept);

    segments += timeline.segments.length;
    deaths += hero.died ? 1 : 0;
    timeouts += fights.filter((fight) => fight.result === 'timeout').length;
    combatTicks += fights.reduce((sum, fight) => sum + fight.ticks, 0);
    grossXp += hero.xpEarned;
    const penalty = progress.applyDeathPenalty
      ? applyDeathXpLoss(startXp + hero.xpEarned, curve)
      : null;
    netXp += penalty === null ? hero.xpEarned : penalty.totalXp - startXp;
    deathXpLost += penalty?.xpLost ?? 0;
    potionsUsed += events.filter((event) => event.type === 'consumable').reduce((sum, event) => sum + event.qty, 0);
    goldRetained += bag.gold;
    for (const [id, qty] of Object.entries(bag.items)) items.set(id, (items.get(id) ?? 0) + qty);
  }

  return {
    level,
    carriedPotions,
    model,
    runs,
    meanSegments: round(segments / runs),
    deaths,
    timeouts,
    meanCombatTicks: round(combatTicks / runs),
    grossXpPerRequestedHour: round(grossXp / runs),
    netXpPerRequestedHour: round(netXp / runs),
    meanDeathXpLossPerRun: round(deathXpLost / runs),
    meanGoldRetained: round(goldRetained / runs),
    meanItemsRetained: Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, qty]) => [id, round(qty / runs)])),
    meanPotionsUsed: round(potionsUsed / runs),
  };
}

export function resolveStarterKit(items: readonly unknown[]): readonly EquipmentItem[] {
  const parsed = items.map(item => EquipmentItemSchema.safeParse(item)).filter(result => result.success).map(result => result.data);
  return STARTER_KIT.map(({ id, slot }) => {
    const item = parsed.find(candidate => candidate.id === id);
    if (item === undefined || item.slot !== slot) throw new Error(`starter kit item ${id} is missing, invalid, or not in slot ${slot}`);
    return item;
  });
}

export interface RuntimePairedComparison {
  readonly engineVersion: string; readonly idleSimulatorVersion: string; readonly contentHash: string;
  readonly seedRoot: number; readonly runsPerCell: number; readonly activity: string; readonly plannedBudget: number;
  readonly command: string; readonly equipment: readonly { id: string; slot: string; stats: Readonly<Record<string, number>> }[];
  readonly rows: readonly { model: RuntimePassRow['model']; level: number; carriedPotions: number;
    naked: RuntimePassRow; starterKit: RuntimePassRow; delta: { deaths: number; grossXpPerRequestedHour: number;
      netXpPerRequestedHour: number; meanGoldRetained: number; meanPotionsUsed: number; meanCombatTicks: number } }[];
}

export function runRuntimePassStarterKitComparison(options: { readonly runs?: number; readonly seedRoot?: number } = {}): RuntimePairedComparison {
  const base = runRuntimePass(options);
  const compiled = compileContentDirectory(CONTENT_ROOT, rpgContentPlugin);
  if (!compiled.ok) throw new Error(`RPG content failed to compile:\n${formatErrors(compiled.errors)}`);
  if (compiled.bundle.contentHash !== base.contentHash) throw new Error('starter-kit comparison compiled content hash differs from naked baseline');
  const equipment = resolveStarterKit(compiled.bundle.collections['items'] ?? []);
  const content = rpgIdleContentFromBundle(compiled.bundle);
  const progression = compiled.bundle.collections['progression']?.[0] as { readonly xpToNext?: unknown; readonly tailGrowthBp?: unknown } | undefined;
  if (progression === undefined) throw new Error('compiled RPG content has no progression curve');
  const curve = XpCurveSchema.parse({ xpToNext: progression.xpToNext, tailGrowthBp: progression.tailGrowthBp });
  const rows = base.rows.map(naked => {
    const tuning: RpgIdleTuning = naked.model === 'idle-default-regen' ? DEFAULT_RPG_IDLE_TUNING : { ...DEFAULT_RPG_IDLE_TUNING, regenBetweenFightsBp: 0 };
    const geared = runCell(content, curve, naked.level, naked.carriedPotions, tuning, naked.model, base.runsPerCell,
      base.plannedBudget, base.seedRoot as Seed, equipment);
    return { model: naked.model, level: naked.level, carriedPotions: naked.carriedPotions, naked, starterKit: geared,
      delta: { deaths: geared.deaths - naked.deaths,
        grossXpPerRequestedHour: round(geared.grossXpPerRequestedHour - naked.grossXpPerRequestedHour),
        netXpPerRequestedHour: round(geared.netXpPerRequestedHour - naked.netXpPerRequestedHour),
        meanGoldRetained: round(geared.meanGoldRetained - naked.meanGoldRetained),
        meanPotionsUsed: round(geared.meanPotionsUsed - naked.meanPotionsUsed),
        meanCombatTicks: round(geared.meanCombatTicks - naked.meanCombatTicks) } };
  });
  return { engineVersion: base.engineVersion, idleSimulatorVersion: base.idleSimulatorVersion, contentHash: base.contentHash,
    seedRoot: base.seedRoot, runsPerCell: base.runsPerCell, activity: base.activity, plannedBudget: base.plannedBudget,
    command: 'node games/rpg/tools/balance-sim/src/runtime-pass.ts --compare-starter-kit',
    equipment: equipment.map(item => ({ id: item.id, slot: item.slot, stats: item.stats })), rows };
}

export function renderRuntimePassStarterKitComparison(report: RuntimePairedComparison): string {
  const lines = ['# Region 1 idle starter-kit paired baseline', '',
    `- ENGINE_VERSION: \`${report.engineVersion}\`; idle simulator: \`${report.idleSimulatorVersion}\``,
    `- Content hash: \`${report.contentHash}\`; seed root: ${report.seedRoot}; ${report.runsPerCell} paired seeds per cell`,
    `- Command: \`${report.command}\`; activity: \`${report.activity}\`; requested-hour budget: ${report.plannedBudget} slots`,
    `- Resolved production gear: ${report.equipment.map(item => `${item.id} (${item.slot}; ${Object.entries(item.stats).map(([k,v]) => `${k} ${v}`).join(', ') || 'no stats'})`).join('; ')}`,
    '', 'Each naked/geared pair uses the same level, potion provision, rules, activity, and seed (`deriveSeed(seedRoot, \'runtime-pass\', i)`). The kit is equipped in the snapshot; level-up does not add attributes. `idle-default-regen` is the current production idle tuning; `idle-no-regen-counterfactual` is a counterfactual sensitivity run, not another production policy.',
    '', '| Model | Level | Potions | Deaths naked → kit | Timeouts naked → kit | Censored | Gross XP naked → kit | Net XP naked → kit | Gold retained proxy naked → kit | Potions used naked → kit | Combat ticks naked → kit | Δ deaths | Δ gross XP | Δ net XP | Δ gold proxy |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.rows.map(r => `| ${r.model} | ${r.level} | ${r.carriedPotions} | ${r.naked.deaths}/${r.naked.runs} → ${r.starterKit.deaths}/${r.starterKit.runs} | ${r.naked.timeouts} → ${r.starterKit.timeouts} | 0 | ${r.naked.grossXpPerRequestedHour} → ${r.starterKit.grossXpPerRequestedHour} | ${r.naked.netXpPerRequestedHour} → ${r.starterKit.netXpPerRequestedHour} | ${r.naked.meanGoldRetained} → ${r.starterKit.meanGoldRetained} | ${r.naked.meanPotionsUsed} → ${r.starterKit.meanPotionsUsed} | ${r.naked.meanCombatTicks} → ${r.starterKit.meanCombatTicks} | ${r.delta.deaths} | ${r.delta.grossXpPerRequestedHour} | ${r.delta.netXpPerRequestedHour} | ${r.delta.meanGoldRetained} |`),
    '', '## Limits', '',
    '- Gross XP is credited before death loss; net XP applies the production idle death penalty. Gold retained is the result of in-memory idle settlement math, not DB-confirmed banking or sales. Idle settlement has no live corpse flow; this gold quantity is not corpse-at-risk gold. Timeout count is reported separately and censored is zero for this completed idle matrix.',
    '- Access to the Region 1 hunt activity is assumed already unlocked; a new level-1 character is not necessarily eligible to start it. Kit ownership/acquisition and potion provision are also assumed. L3/L5 potion cohorts are provisioned. Current server kit claim reachability is not evidence of a ledger grant, equipment transaction, or banked sales. This does not measure human play, DB evidence, or sustainable rates.',
    '- This is a bounded current-code comparison, not a target or a balance verdict. Thornblade unlocks and level-scaled attributes are excluded.', ''];
  return lines.join('\n');
}

export function runRuntimePass(options: { readonly runs?: number; readonly seedRoot?: number } = {}): RuntimePassReport {
  const runs = options.runs ?? RUNS;
  const seedRoot = options.seedRoot ?? SEED_ROOT;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10_000) throw new RangeError('runs must be in [1, 10000]');
  if (!Number.isSafeInteger(seedRoot) || seedRoot < 0 || seedRoot > 0xffff_ffff) throw new RangeError('seedRoot must be uint32');
  const compiled = compileContentDirectory(CONTENT_ROOT, rpgContentPlugin);
  if (!compiled.ok) throw new Error(`RPG content failed to compile:\n${formatErrors(compiled.errors)}`);
  const content = rpgIdleContentFromBundle(compiled.bundle);
  const activity = content.idleActivities[ACTIVITY];
  if (activity === undefined) throw new Error(`compiled content has no activity ${ACTIVITY}`);
  const plannedBudget = idleBudget(activity, DEFAULT_RPG_IDLE_TUNING, 60, BP_SCALE);
  const progression = compiled.bundle.collections['progression']?.[0] as { readonly xpToNext?: unknown; readonly tailGrowthBp?: unknown } | undefined;
  if (progression === undefined) throw new Error('compiled RPG content has no progression curve');
  const curve = XpCurveSchema.parse({ xpToNext: progression.xpToNext, tailGrowthBp: progression.tailGrowthBp });
  const rows: RuntimePassRow[] = [];
  for (const model of ['idle-default-regen', 'idle-no-regen-counterfactual'] as const) {
    const tuning: RpgIdleTuning = model === 'idle-default-regen'
      ? DEFAULT_RPG_IDLE_TUNING
      : { ...DEFAULT_RPG_IDLE_TUNING, regenBetweenFightsBp: 0 };
    for (const level of LEVELS) {
      for (const carriedPotions of SUPPLY_COUNTS) {
        rows.push(runCell(content, curve, level, carriedPotions, tuning, model, runs, plannedBudget, seedRoot));
      }
    }
  }
  return {
    engineVersion: ENGINE_VERSION,
    idleSimulatorVersion: RPG_IDLE_SIMULATOR_VERSION,
    contentHash: compiled.bundle.contentHash,
    seedRoot,
    command: 'node games/rpg/tools/balance-sim/src/runtime-pass.ts',
    runsPerCell: runs,
    activity: ACTIVITY,
    plannedBudget,
    rows,
  };
}

export function renderRuntimePass(report: RuntimePassReport): string {
  const lines = [
    '# Region 1 runtime evidence pass',
    '',
    `- ENGINE_VERSION: \`${report.engineVersion}\``,
    `- Combat engine: \`${report.idleSimulatorVersion}\``,
    `- Content hash: \`${report.contentHash}\``,
    `- Seed root: ${report.seedRoot}; ${report.runsPerCell} paired seeds per cell`,
    `- Command: \`${report.command}\``,
    `- Activity: \`${report.activity}\`; budget ${report.plannedBudget} slots = one requested content hour by the production idle budget function`,
    '',
    'Actor for every cell: naked provisional starter character. The current server starter snapshot is level 1, attributes STR 9 / AGI 4 / INT 2 / VIT 10 / SPI 5, no equipped items, Basic Attack plus the four unlocked starter skills, and the starter automation rules. L3 and L5 change only the level field: current level-ups do not grant attribute points (open decision #13). The sixth rule uses a carried minor healing potion below 40% HP; each seeded expedition receives exactly 0 or 5 escrowed potions.',
    '',
    '| Model | Level | Potions | Mean slots | Deaths / runs | Timeouts | Combat ticks / run | Gross XP / requested hour | Net XP / requested hour | Mean death XP loss / run | Gold kept | Potions used |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.rows.map((r) => `| ${r.model} | ${r.level} | ${r.carriedPotions} | ${r.meanSegments} | ${r.deaths}/${r.runs} | ${r.timeouts} | ${r.meanCombatTicks} | ${r.grossXpPerRequestedHour} | ${r.netXpPerRequestedHour} | ${r.meanDeathXpLossPerRun} | ${r.meanGoldRetained} | ${r.meanPotionsUsed} |`),
    '',
    '## Interpretation and limits',
    '',
    '- Idle rows run the actual compiled-content `simulateIdle`, `rpgProgress`, `settleIdle`, and XP-loss functions. Gross XP includes kill XP through the fatal segment; net XP applies the runtime death penalty after adding that gross XP. Gold is settled gold. Kept item stacks are listed below; they are not converted to gold because no sale was simulated.',
    '- The no-regen rows are a counterfactual run of the idle simulator over the hunt activity’s real weighted encounters, with carried HP/inventory and actual timeout/death stopping. They are not live server measurements. Live navigation, input delays, loot grants, and live death handling were not simulated here, so this report makes no live throughput or XP/hour claim.',
    '- The report assumes the idle activity’s expedition start gate is already satisfied. It is a combat/economy measurement of a provisioned input snapshot; starting inventory, potion acquisition, item acquisition, and unlocking hunt for a newly created character are not modeled.',
    '- Idle default regen is 15% max HP between survived fights; no regeneration is free within a fight. The no-regen reference sets between-fight regen to zero. Deaths and timeouts are separate; timeout count is zero in this run unless shown otherwise.',
    '- No gear is equipped. The content defines starter items but does not grant them on character creation or drop them as loot. This is the current reachable naked starter baseline, not a gear-acquisition model. Thornblade skills and the paper’s level-scaled attribute spreads are not available character configurations today. Retained item totals below include stack grants only; unique-item grants are omitted.',
    '- This is evidence about current code/content, not a tuning recommendation. The XP curve, death loss, gear acquisition, character progression, live navigation pacing, and #56 balance decision remain open.',
    '',
    '### Mean retained item stacks per requested expedition',
    '',
    '| Model | Level | Potions | Retained item quantities |',
    '|---|---:|---:|---|',
    ...report.rows.map((r) => `| ${r.model} | ${r.level} | ${r.carriedPotions} | ${Object.entries(r.meanItemsRetained).map(([id, qty]) => `${id}: ${qty}`).join('; ') || '—'} |`),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync(1, process.argv.includes('--compare-starter-kit')
    ? renderRuntimePassStarterKitComparison(runRuntimePassStarterKitComparison())
    : renderRuntimePass(runRuntimePass()));
}
