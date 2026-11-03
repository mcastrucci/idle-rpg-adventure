/** Bounded trace of the production live plugin on one finite authored Region 1 route. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { compileContentDirectory, formatErrors } from '@engine/content-compiler';
import { deriveSeed } from '@engine/sim-core';
import type { JsonValue, LiveCommandResult, LiveStep } from '@engine/live-kernel';
import plugin from '@rpg/content-plugin';
import { AutomationRulesSchema, EquipmentItemSchema } from '@rpg/rpg-schema';
import type { EquipmentItem } from '@rpg/rpg-schema';
import { ENGINE_VERSION } from '@rpg/rpg-sim';

import { PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS, BASIC_ATTACK } from '../src/characters/validation.ts';
import { createRpgLiveGame, RPG_LIVE_TICK_MS, RPG_LIVE_VERSION } from '../src/live/game.ts';
import type { RpgLiveHeroSetup, RpgLiveSetup, RpgLiveState } from '../src/live/game.ts';

const CONTENT_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
const LEVELS = [1, 3, 5] as const;
const POTIONS = [0, 5] as const;
const RUNS = 100;
const SEED_ROOT = 56;
const ACTOR = 'balance-live:starter';
const INSTANCE = 'balance-live:instance';
const AREA = 'area:region_1';
const R = (name: string) => `loc:region_1.${name}`;
const E = (from: string, to: string) => `exit:region_1.${from}.${to}`;
const ROUTE = ['portal_clearing', 'overgrown_causeway', 'tangle_orchard', 'irrigation_terraces', 'old_well'] as const;
const TRAVEL = ROUTE.slice(1).map((name, i) => {
  const from = ROUTE[i];
  if (!from) throw new Error(`route is missing origin for ${name}`);
  return { type: 'travel', exitId: E(from, name) };
});
const RETURN_TRAVEL = [{ type: 'travel', exitId: E('old_well', 'overgrown_causeway') },
  { type: 'travel', exitId: E('overgrown_causeway', 'portal_clearing') }];
const RETURN_MS = [0, 5_000, 30_000] as const;
const STARTER_KIT: readonly { id: string; slot: EquipmentItem['slot'] }[] = [
  { id: 'item:rusty_sword', slot: 'weapon' }, { id: 'item:padded_vest', slot: 'chest' }, { id: 'item:wooden_buckler', slot: 'offhand' },
];

export interface LiveRun {
  readonly seed: number; readonly level: number; readonly carriedPotions: number;
  readonly status: 'returned' | 'dead' | 'censored'; readonly location: string;
  readonly ticks: number; readonly commands: number; readonly xpGranted: number;
  readonly goldEffects: number; readonly potionUse: number; readonly bag: { readonly items: Record<string, number>; readonly gold: number };
  readonly potionsRemaining: number;
  readonly bagDisposition: 'recovered_on_return' | 'corpse_at_risk' | 'unsettled_censored';
  readonly trace: readonly { readonly kind: 'command' | 'tick'; readonly command?: unknown; readonly location: string;
    readonly phase: string; readonly hp: number | null; readonly groupId?: string; readonly effects: readonly unknown[] }[];
}
export interface LiveReport {
  readonly engineVersion: string; readonly liveVersion: string; readonly tickMs: number; readonly contentHash: string;
  readonly seedRoot: number; readonly runsPerCell: number; readonly route: readonly string[]; readonly command: string;
  readonly rows: readonly { level: number; carriedPotions: number; returned: number; dead: number; censored: number;
    meanXpGranted: number; meanGoldEffect: number; meanGoldEligibleOnReturn: number; meanCorpseAtRiskGold: number;
    meanPotionsUsed: number;
    meanCombatTicks: number; meanCommands: number; rates: readonly { overheadMs: number; xpPerHour: number }[] }[];
  readonly diagnostic: LiveRun;
}

const potionRules = AutomationRulesSchema.parse([
  ...PROVISIONAL_STARTER_RULES.slice(0, 4),
  { when: { selfHpBelowBp: 4000, hasConsumable: 'item:minor_healing_potion' }, do: { useConsumable: 'item:minor_healing_potion' } },
  { when: {}, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } },
]);
function ok<T>(result: LiveCommandResult<T>): LiveStep<T> {
  if ('rejected' in result) throw new Error(`live command rejected: ${result.rejected}`);
  return result;
}
function actor(level: number, carriedPotions: number, equipment: readonly EquipmentItem[] = []): RpgLiveHeroSetup {
  return { actorId: ACTOR, build: { level, attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, equipment: equipment.map(({ stats }) => ({ stats })) },
    skills: [BASIC_ATTACK, ...PROVISIONAL_STARTER_SKILLS], rules: potionRules,
    consumables: carriedPotions ? [{ item: 'item:minor_healing_potion', qty: carriedPotions }] : [] };
}
function runOne(game: ReturnType<typeof createRpgLiveGame>, setup: RpgLiveSetup, level: number, carriedPotions: number,
  seed: number): LiveRun {
  let state = game.init({ instanceId: INSTANCE, participants: [{ actorId: ACTOR, accountId: 'balance-live' }], seed,
    setup: setup as unknown as JsonValue });
  const trace: LiveRun['trace'][number][] = [];
  let ticks = 0; let commands = 0; let xpGranted = 0; let goldEffects = 0; let potionUse = 0;
  let status: LiveRun['status'] = 'censored';
  let hitSafetyCap = false;
  const record = (kind: 'command' | 'tick', step: LiveStep<RpgLiveState>, command?: unknown, groupId?: string) => {
    state = step.state;
    for (const effect of step.effects ?? []) {
      const value = effect as { type?: string; xp?: number; gold?: number; qty?: number; item?: string };
      if (value.type === 'xpGranted') xpGranted += value.xp ?? 0;
      if (value.type === 'lootGranted') goldEffects += value.gold ?? 0;
      if (value.type === 'consumableUsed' && value.item === 'item:minor_healing_potion') potionUse += value.qty ?? 0;
    }
    // Keep effect-bearing steps and each out-of-combat command. Ordinary tick state is represented by exact counters.
    if (kind === 'command' || (step.effects?.length ?? 0) > 0) trace.push({ kind, ...(command ? { command } : {}),
      location: state.location, phase: state.phase, hp: state.heroes[0]?.hp ?? null,
      ...(groupId ? { groupId } : {}), effects: step.effects ?? [] });
  };
  const isDead = () => state.phase === 'dead';
  const command = (value: Record<string, unknown>) => { commands++; record('command', ok(game.applyCommand(state, ACTOR, value as JsonValue)), value); };
  for (let index = 1; index < ROUTE.length; index++) {
    if (isDead() || hitSafetyCap) break;
    const travel = TRAVEL[index - 1];
    const loc = ROUTE[index];
    if (!travel || !loc) throw new Error(`route is incomplete at index ${index}`);
    command(travel);
    if (isDead() || state.location !== R(loc)) break;
    const groups = [...(state.visited[R(loc)]?.groups ?? [])];
    for (const group of groups) {
      if (isDead()) break;
      const current = state.visited[R(loc)]?.groups.find(g => g.id === group.id);
      if (!current || current.defeated) continue;
      command({ type: 'engage', groupId: current.id });
      let guard = 0;
      while (game.isTicking(state) && guard++ < 20_000) { ticks++; record('tick', game.tick(state), undefined, current.id); }
      if (game.isTicking(state)) { hitSafetyCap = true; break; }
    }
  }
  if (!isDead() && state.location === R('old_well') && !game.isTicking(state)) {
    for (const value of RETURN_TRAVEL) { command(value); if (isDead()) break; }
  }
  if (!isDead() && state.location === R('portal_clearing') && !game.isTicking(state)) {
    command({ type: 'returnToSanctuary' });
    if (state.phase === 'closing') status = 'returned';
  }
  if (state.phase === 'dead') status = 'dead';
  const bag = state.runBag[ACTOR] ?? { items: {}, gold: 0 };
  const potionsRemaining = state.heroes[0]?.consumables.find(stack => stack.item === 'item:minor_healing_potion')?.qty ?? 0;
  return { seed, level, carriedPotions, status, location: state.location, ticks, commands, xpGranted,
    goldEffects, potionUse, bag, potionsRemaining,
    bagDisposition: status === 'returned' ? 'recovered_on_return' : status === 'dead' ? 'corpse_at_risk' : 'unsettled_censored', trace };
}

function round(n: number, digits = 2): number { const p = 10 ** digits; return Math.round(n * p) / p; }
export function resolveLiveStarterKit(items: readonly unknown[]): readonly EquipmentItem[] {
  const parsed = items.map(item => EquipmentItemSchema.safeParse(item)).filter(result => result.success).map(result => result.data);
  return STARTER_KIT.map(({ id, slot }) => {
    const item = parsed.find(candidate => candidate.id === id);
    if (item === undefined || item.slot !== slot) throw new Error(`starter kit item ${id} is missing, invalid, or not in slot ${slot}`);
    return item;
  });
}
function runBalanceLiveWithEquipment(options: { runs?: number; seedRoot?: number } = {}, equipment?: readonly EquipmentItem[]): LiveReport {
  const runs = options.runs ?? RUNS; const seedRoot = options.seedRoot ?? SEED_ROOT;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10_000) throw new RangeError('runs must be in [1, 10000]');
  const compiled = compileContentDirectory(CONTENT_ROOT, plugin);
  if (!compiled.ok) throw new Error(`RPG content failed to compile:\n${formatErrors(compiled.errors)}`);
  const game = createRpgLiveGame(compiled.bundle);
  const setup = (level: number, carriedPotions: number): RpgLiveSetup => ({ area: AREA, heroes: [actor(level, carriedPotions, equipment)] });
  const all: LiveRun[] = [];
  for (const level of LEVELS) for (const carriedPotions of POTIONS) for (let i = 0; i < runs; i++)
    all.push(runOne(game, setup(level, carriedPotions), level, carriedPotions, deriveSeed(seedRoot, 'runtime-pass', i)));
  const rows = LEVELS.flatMap(level => POTIONS.map(carriedPotions => {
    const cell = all.filter(r => r.level === level && r.carriedPotions === carriedPotions);
    const sum = (pick: (run: LiveRun) => number) => cell.reduce((n, r) => n + pick(r), 0);
    const totalXp = sum(r => r.xpGranted); const totalTicks = sum(r => r.ticks); const totalCommands = sum(r => r.commands);
    return { level, carriedPotions, returned: cell.filter(r => r.status === 'returned').length, dead: cell.filter(r => r.status === 'dead').length,
      censored: cell.filter(r => r.status === 'censored').length, meanXpGranted: round(totalXp / runs),
      meanGoldEffect: round(sum(r => r.goldEffects) / runs),
      meanGoldEligibleOnReturn: round(sum(r => r.status === 'returned' ? r.bag.gold : 0) / runs),
      meanCorpseAtRiskGold: round(sum(r => r.status === 'dead' ? r.goldEffects : 0) / runs),
      meanPotionsUsed: round(sum(r => r.potionUse) / runs), meanCombatTicks: round(totalTicks / runs), meanCommands: round(totalCommands / runs),
      rates: RETURN_MS.map(overheadMs => {
        const durationMs = totalTicks * RPG_LIVE_TICK_MS + totalCommands * overheadMs;
        return { overheadMs, xpPerHour: durationMs === 0 ? 0 : round(totalXp * 3_600_000 / durationMs) };
      }) };
  }));
  const diagnostic = all.find(run => run.level === 5 && run.carriedPotions === 0 && run.status === 'returned') ?? all[0];
  if (!diagnostic) throw new Error('balance live matrix produced no runs');
  return { engineVersion: ENGINE_VERSION, liveVersion: RPG_LIVE_VERSION, tickMs: RPG_LIVE_TICK_MS, contentHash: compiled.bundle.contentHash,
    seedRoot, runsPerCell: runs, route: [...ROUTE.map(R), R('overgrown_causeway'), R('portal_clearing'), 'returnToSanctuary'], command: 'node games/rpg/apps/server/scripts/balance-live.ts', rows,
    diagnostic };
}
export function runBalanceLive(options: { runs?: number; seedRoot?: number } = {}): LiveReport {
  return runBalanceLiveWithEquipment(options);
}
export interface LiveStarterKitComparison {
  readonly engineVersion: string; readonly liveVersion: string; readonly tickMs: number; readonly contentHash: string;
  readonly seedRoot: number; readonly runsPerCell: number; readonly route: readonly string[]; readonly command: string;
  readonly equipment: readonly { id: string; slot: string; stats: Readonly<Record<string, number>> }[];
  readonly rows: readonly { level: number; carriedPotions: number; naked: LiveReport['rows'][number]; starterKit: LiveReport['rows'][number];
    delta: { returned: number; dead: number; meanXpGranted: number; meanGoldEligibleOnReturn: number; meanCorpseAtRiskGold: number;
      meanPotionsUsed: number; meanCombatTicks: number; meanCommands: number } }[];
}
export function runBalanceLiveStarterKitComparison(options: { runs?: number; seedRoot?: number } = {}): LiveStarterKitComparison {
  const naked = runBalanceLive(options);
  const compiled = compileContentDirectory(CONTENT_ROOT, plugin);
  if (!compiled.ok) throw new Error(`RPG content failed to compile:\n${formatErrors(compiled.errors)}`);
  if (compiled.bundle.contentHash !== naked.contentHash) throw new Error('starter-kit comparison compiled content hash differs from naked baseline');
  const equipment = resolveLiveStarterKit(compiled.bundle.collections['items'] ?? []);
  const kit = runBalanceLiveWithEquipment(options, equipment);
  if (kit.contentHash !== naked.contentHash) throw new Error('starter-kit live run content hash differs from naked baseline');
  const rows = naked.rows.map(a => {
    const b = kit.rows.find(r => r.level === a.level && r.carriedPotions === a.carriedPotions);
    if (!b) throw new Error('starter-kit live comparison matrix is incomplete');
    return { level: a.level, carriedPotions: a.carriedPotions, naked: a, starterKit: b,
      delta: { returned: b.returned - a.returned, dead: b.dead - a.dead,
        meanXpGranted: round(b.meanXpGranted - a.meanXpGranted),
        meanGoldEligibleOnReturn: round(b.meanGoldEligibleOnReturn - a.meanGoldEligibleOnReturn),
        meanCorpseAtRiskGold: round(b.meanCorpseAtRiskGold - a.meanCorpseAtRiskGold),
        meanPotionsUsed: round(b.meanPotionsUsed - a.meanPotionsUsed),
        meanCombatTicks: round(b.meanCombatTicks - a.meanCombatTicks), meanCommands: round(b.meanCommands - a.meanCommands) } };
  });
  return { engineVersion: naked.engineVersion, liveVersion: naked.liveVersion, tickMs: naked.tickMs, contentHash: naked.contentHash,
    seedRoot: naked.seedRoot, runsPerCell: naked.runsPerCell, route: naked.route,
    command: 'node games/rpg/apps/server/scripts/balance-live.ts --compare-starter-kit',
    equipment: equipment.map(item => ({ id: item.id, slot: item.slot, stats: item.stats })), rows };
}
export function renderBalanceLiveStarterKitComparison(report: LiveStarterKitComparison): string {
  return ['# Region 1 production live starter-kit paired baseline', '',
    `- Engine: \`${report.engineVersion}\`; live plugin: \`${report.liveVersion}\`; tick: ${report.tickMs} ms`,
    `- Content hash: \`${report.contentHash}\`; seed root: ${report.seedRoot}; ${report.runsPerCell} paired seeds per cell`,
    `- Command: \`${report.command}\`; route: ${report.route.join(' → ')}`,
    `- Resolved production gear: ${report.equipment.map(item => `${item.id} (${item.slot}; ${Object.entries(item.stats).map(([k,v]) => `${k} ${v}`).join(', ') || 'no stats'})`).join('; ')}`,
    '', 'Each naked/geared pair is the same starter build, level cohort, potion provision, route, rules, and seed (`deriveSeed(seedRoot, \'runtime-pass\', i)`). Live XP can level the hero during the route; level-up grants no attributes. This finite production plugin trace reports event counts and effects; it does not estimate sustainable XP/hour.',
    '', '| Level | Potions | Returned naked → kit | Dead naked → kit | Censored naked → kit | Gross XP grant naked → kit | Gold eligible on return naked → kit | Corpse-at-risk gold naked → kit | Potions used naked → kit | Combat ticks naked → kit | Commands naked → kit | Δ returned | Δ dead | Δ XP | Δ return gold | Δ corpse gold |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.rows.map(r => `| ${r.level} | ${r.carriedPotions} | ${r.naked.returned} → ${r.starterKit.returned} | ${r.naked.dead} → ${r.starterKit.dead} | ${r.naked.censored} → ${r.starterKit.censored} | ${r.naked.meanXpGranted} → ${r.starterKit.meanXpGranted} | ${r.naked.meanGoldEligibleOnReturn} → ${r.starterKit.meanGoldEligibleOnReturn} | ${r.naked.meanCorpseAtRiskGold} → ${r.starterKit.meanCorpseAtRiskGold} | ${r.naked.meanPotionsUsed} → ${r.starterKit.meanPotionsUsed} | ${r.naked.meanCombatTicks} → ${r.starterKit.meanCombatTicks} | ${r.naked.meanCommands} → ${r.starterKit.meanCommands} | ${r.delta.returned} | ${r.delta.dead} | ${r.delta.meanXpGranted} | ${r.delta.meanGoldEligibleOnReturn} | ${r.delta.meanCorpseAtRiskGold} |`),
    '', '## Limits', '',
    '- XP is gross live grant only; no net XP is projected. Gold eligible on return is a plugin bag proxy, not banked ledger evidence. Corpse-at-risk gold is the grants from deaths before the run bag is cleared; censored runs remain unsettled.',
    '- Access to this route is assumed; starter-kit ownership/acquisition and potion provision are also assumptions. L3/L5 with potions are provisioned cohorts. Claim reachability does not measure actual ledger grant or equipment transactions. No human or DB evidence is included.',
    '- The route is one finite authored path and excludes the Region 1 Matriarch/boss room. A 100/100 return count therefore does not show R1 conquest or boss success. Do not compare these live denominators with idle requested-hour denominators or treat the trace as a sustainable rate. Thornblade unlocks and level-scaled attributes are excluded.', ''].join('\n');
}
export function renderBalanceLive(report: LiveReport): string {
  return ['# Region 1 production live route trace', '', `- Engine: \`${report.engineVersion}\`; live plugin: \`${report.liveVersion}\`; tick: ${report.tickMs} ms`,
    `- Content hash: \`${report.contentHash}\`; seed root: ${report.seedRoot}; ${report.runsPerCell} seeds per cell`,
    `- Command: \`${report.command}\`; route: ${report.route.join(' → ')}`, '',
    'The script runs the actual `createRpgLiveGame(compiled.bundle)` plugin. Each location’s actual rolled undefeated groups are engaged once with production commands; effects are captured from every command and combat tick. The starter attributes, skills and base rules come from server validation; the potion rule is inserted before the basic-attack fallback in the same order and with the same threshold as the idle runtime pass. L1/L3/L5 denote initial level cohorts; live XP is granted on each victory and the plugin updates the hero level during the route, while the idle runtime pass holds the cohort snapshot level. The trace assumes access/init is permitted and inventory provisioned; it does not model acquisition.',
    '', '| Level | Carried potions | Returned | Dead | Censored | Mean XP grant | Mean gold effects | Gold eligible on return | Corpse-at-risk gold | Potions used | Combat ticks | Commands | XP/h at 0s, 5s, 30s per command |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...report.rows.map(r => `| ${r.level} | ${r.carriedPotions} | ${r.returned} | ${r.dead} | ${r.censored} | ${r.meanXpGranted} | ${r.meanGoldEffect} | ${r.meanGoldEligibleOnReturn} | ${r.meanCorpseAtRiskGold} | ${r.meanPotionsUsed} | ${r.meanCombatTicks} | ${r.meanCommands} | ${r.rates.map(x => `${x.overheadMs / 1000}s: ${x.xpPerHour}`).join('; ')} |`),
    '', '## Limits', '',
    '- Seeds are `deriveSeed(56, \'runtime-pass\', i)`, paired by index with the idle pass for conceptual comparison. Live/idle random streams differ, so pairing does not mean identical fights.',
    '- This is an offline plugin trace, not DB ledger settlement or human telemetry. XP/gold are measured from actual grant effects. XP is gross granted only; death has internal level-sensitive floor semantics, so no net XP projection is reported. Gold eligible on return is plugin bag value, not ledger-confirmed banking; corpse-at-risk gold totals grants from deaths before the plugin clears the run bag.',
    '- Gold in the run bag is recovered only on successful return. On death it is marked corpse-at-risk; no recovery probability is inferred. Censored runs are unsettled. No rest, reset, reroll, respawn, or repeat route is modeled.',
    '- XP/hour is a sensitivity calculation: actual combat ticks × 500 ms plus 0, 5, or 30 seconds for each recorded out-of-combat command (travel, engage, return). It assumes only this single finite route and is not an unlimited route rate or optimal/manual-player claim.',
    '- The idle runtime-pass baseline reports XP per requested content hour; this trace normalizes XP over one finite live session using combat ticks and assumed command delays. These denominators differ, so the rates cannot be read as a sustainable idle/live throughput comparison.',
    '- The live plugin applies victory XP and may level the hero up during the route. Idle runtime-pass runs hold the requested level snapshot, so level cohorts are not otherwise identical across the two passes.',
    '- Entry gate and inventory provision are assumed; no acquisition, access, banking, or persistence transaction is simulated. The complete authored route is portal_clearing → overgrown_causeway → tangle_orchard → irrigation_terraces → old_well → overgrown_causeway → portal_clearing → returnToSanctuary. The old well is not safe; all actual groups there are fought. Causeway groups remain defeated on revisit.',
    '- A deterministic successful L5/0-potion run is retained as a compact diagnostic trace by the exported function for test assertions; the baseline includes aggregate counts only.', '',
  ].join('\n');
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) writeFileSync(1,
  process.argv.includes('--compare-starter-kit') ? renderBalanceLiveStarterKitComparison(runBalanceLiveStarterKitComparison()) : renderBalanceLive(runBalanceLive()));
