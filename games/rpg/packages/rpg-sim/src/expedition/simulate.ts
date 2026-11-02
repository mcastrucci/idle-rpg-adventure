/**
 * The idle simulation model (docs/spec/idle-simulation.md §4): one segment (weight 1) = one encounter slot.
 *
 * Per segment `i` (global index; resumed simulations continue the numbering):
 *   1. RNG: `segmentStreams(seed, i)` — streams `encounters` (group roll) and `loot` (kill loot and resource rolls);
 *      the combat seed is `deriveSeed(segmentSeed(seed, i), 'combat')`. A segment depends only on `(seed, i, state)`.
 *   2. If the activity has an encounter table: roll a group, run the combat with `runToEnd` (automation rules, no manual
 *      inputs) — heroes start with their carried HP and remaining consumables. Each killed enemy grants its XP to every
 *      hero (event only, not a ledger delta) and rolls its loot table into the bag (round-robin recipient, solo: the
 *      hero). Consumables used are burnt from escrow.
 *   3. If no hero died: between-fight regen `min(maxHp − hp, ⌊maxHp × regenBp / 10000⌋)` (provisional 15 %, open
 *      decision #16), then resource rolls: yield `y` rolls `⌊(i+1)·R/S⌋ − ⌊i·R/S⌋` times (`R` = rolls per hour, `S` =
 *      segments per hour), i.e. exactly `R` rolls per `S` segments, spread evenly and resumable.
 *   4. Outcome: a hero died → `failed` (timeline ends with this segment); otherwise, if budget remains, a combat timeout
 *      or the retreat policy → `retreated` (ends here); else continue. Reaching the budget → `completed`.
 */
import type { LedgerDelta } from '@engine/economy';
import { segmentSeed, segmentStreams } from '@engine/expedition-kernel';
import type { Outcome, Segment, SimulateInput, Timeline } from '@engine/expedition-kernel';
import { BP_SCALE, deriveSeed, mulBp, mulDivFloor } from '@engine/sim-core';
import type { IdleActivity, LootTable } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';

import { NO_INPUTS, runToEnd } from '../combat/engine.ts';
import { hashEvents } from '../combat/hash.ts';
import type { CombatEvent, EnemySetup, HeroSetup } from '../combat/types.ts';
import type { RpgIdleContent } from './content.ts';
import { isHealingConsumable } from './content.ts';
import { idleActivityFor } from './config.ts';
import type { IdleKind } from './config.ts';
import { ESCROW, GOLD, INVENTORY, itemAsset, mergeDeltas, stack } from './deltas.ts';
import { rollLoot } from './loot.ts';
import type {
  DeathCause,
  EncounterMember,
  IdleConsumable,
  RpgActorSnapshot,
  RpgIdleConfig,
  RpgIdleEvent,
  RpgIdleState,
} from './types.ts';

/** Provisional idle constants (open decisions #8, #16). Part of the simulator: changing one bumps its version. */
export interface RpgIdleTuning {
  /** HP restored after every survived fight, bp of max HP (open decision #16, design Q-B9: 15 %). */
  readonly regenBetweenFightsBp: number;
  /** Combat safety cap; a fight reaching it is a `timeout` (the party walks away: retreat). */
  readonly maxCombatTicks: number;
  /** Share of the bag (gold and items, per asset) lost when the expedition fails (rewards §4: 50 %). */
  readonly deathBagLossBp: number;
  /** Segments per in-game hour for activities without encounters (`encountersPerHour = 0`). */
  readonly gatherSegmentsPerHour: number;
  /** Durations a start may request (idle-simulation §2, POC). */
  readonly durationsMin: readonly number[];
}

export const DEFAULT_RPG_IDLE_TUNING: RpgIdleTuning = Object.freeze({
  regenBetweenFightsBp: 1500,
  maxCombatTicks: 3000,
  deathBagLossBp: 5000,
  gatherSegmentsPerHour: 12,
  durationsMin: Object.freeze([15, 30, 60, 180]),
});

/** Segments per in-game hour: `encountersPerHour`, or the tuning's gather rate for encounter-free activities. */
export function segmentsPerHour(activity: IdleActivity, tuning: RpgIdleTuning): number {
  return activity.encountersPerHour > 0 ? activity.encountersPerHour : tuning.gatherSegmentsPerHour;
}

/**
 * Planned segments: `max(1, ⌊segmentsPerHour × durationMin × paceBp / (60 × 10000)⌋)` — exact integer math, floored
 * (a partial encounter is not played), at least one segment.
 */
export function idleBudget(activity: IdleActivity, tuning: RpgIdleTuning, durationMin: number, paceBp: number): number {
  const b = mulDivFloor(segmentsPerHour(activity, tuning) * durationMin, paceBp, 60 * BP_SCALE);
  return b < 1 ? 1 : b;
}

export function maxHpOf(content: RpgIdleContent, actor: RpgActorSnapshot): number {
  return deriveStats(actor.build, content.formulas ?? DEFAULT_STAT_FORMULAS).maxHp;
}

interface Hero {
  readonly snap: RpgActorSnapshot;
  readonly maxHp: number;
  hp: number;
  consumables: IdleConsumable[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function initialHeroes(content: RpgIdleContent, config: RpgIdleConfig, actors: readonly RpgActorSnapshot[], state: RpgIdleState | undefined): Hero[] {
  return [...actors]
    .sort((a, b) => cmp(a.actorId, b.actorId))
    .map((snap): Hero => {
      const maxHp = maxHpOf(content, snap);
      const saved = state?.heroes.find((h) => h.actorId === snap.actorId);
      if (state !== undefined && saved === undefined) throw new RangeError(`resume state has no hero ${snap.actorId}`);
      const startHp = snap.hp === undefined ? maxHp : Math.min(snap.hp, maxHp);
      return {
        snap,
        maxHp,
        hp: saved?.hp ?? startHp,
        consumables: (saved?.consumables ?? config.consumables).map((c) => ({ item: c.item, qty: c.qty })),
      };
    });
}

function stateOf(heroes: readonly Hero[]): RpgIdleState {
  return { heroes: heroes.map((h) => ({ actorId: h.snap.actorId, hp: h.hp, consumables: h.consumables.map((c) => ({ item: c.item, qty: c.qty })) })) };
}

function foeId(n: number): string {
  return `foe:${String(n).padStart(3, '0')}`;
}

/** Death causes of `heroId` from the fatal fight's combat log (plain-language keys, see {@link DeathCause}). */
export function deathCauses(input: {
  readonly content: RpgIdleContent;
  readonly events: readonly CombatEvent[];
  readonly heroId: string;
  readonly foes: ReadonlyMap<string, string>;
  readonly startHp: number;
  readonly maxHp: number;
  readonly brought: readonly IdleConsumable[];
  readonly left: readonly IdleConsumable[];
}): DeathCause[] {
  const { content, events, heroId, foes } = input;
  const bySource = new Map<string, { enemy: string; skill: string; amount: number; count: number }>();
  let biggest: { enemy: string; skill: string; amount: number; crit: boolean } | null = null;
  let stuns = 0;
  for (const e of events) {
    if (e.type === 'DamageDealt' && e.targetId === heroId && e.amount > 0) {
      const enemy = foes.get(e.sourceId) ?? e.sourceId;
      const key = JSON.stringify([enemy, e.origin]);
      const acc = bySource.get(key) ?? { enemy, skill: e.origin, amount: 0, count: 0 };
      acc.amount += e.amount;
      acc.count += 1;
      bySource.set(key, acc);
      if (biggest === null || e.amount > biggest.amount) biggest = { enemy, skill: e.origin, amount: e.amount, crit: e.crit };
    } else if (e.type === 'EffectApplied' && e.targetId === heroId && e.effect === 'stun') {
      stuns++;
    }
  }
  const causes: DeathCause[] = [...bySource.values()]
    .sort((a, b) => b.amount - a.amount || cmp(a.enemy, b.enemy) || cmp(a.skill, b.skill))
    .slice(0, 3)
    .map((s) => ({ key: 'idle.death.damage_taken', enemy: s.enemy, skill: s.skill, amount: s.amount, count: s.count }));
  if (biggest !== null) causes.push({ key: 'idle.death.biggest_hit', ...biggest });
  if (stuns > 0) causes.push({ key: 'idle.death.stunned', count: stuns });
  const healing = (list: readonly IdleConsumable[]): number =>
    list.reduce((s, c) => s + (isHealingConsumable(content, c.item) ? c.qty : 0), 0);
  if (healing(input.brought) === 0) causes.push({ key: 'idle.death.no_consumables' });
  else if (healing(input.left) === 0) causes.push({ key: 'idle.death.out_of_consumables' });
  if (foes.size >= 2) causes.push({ key: 'idle.death.outnumbered', count: foes.size });
  if (input.startHp * BP_SCALE < 5000 * input.maxHp) {
    causes.push({ key: 'idle.death.started_wounded', amount: mulDivFloor(input.startHp, BP_SCALE, input.maxHp) });
  }
  return causes;
}

function lootTable(content: RpgIdleContent, id: string): LootTable {
  const t = content.lootTables[id];
  if (t === undefined) throw new RangeError(`unknown loot table ${id}`);
  return t;
}

export function simulateIdle(
  content: RpgIdleContent,
  kind: IdleKind,
  tuning: RpgIdleTuning,
  input: SimulateInput<RpgIdleConfig, RpgActorSnapshot, RpgIdleState>,
): Timeline<RpgIdleEvent, RpgIdleState> {
  const { config, actors, seed, budget, from } = input;
  const target = idleActivityFor(content, kind, input.activityId);
  if (!target.ok) throw new RangeError(target.message);
  const { activity } = target;
  const table = activity.encounterTable === undefined ? undefined : content.encounterTables[activity.encounterTable];
  if (activity.encounterTable !== undefined && table === undefined) throw new RangeError(`unknown encounter table ${activity.encounterTable}`);
  const perHour = segmentsPerHour(activity, tuning);
  const heroes = initialHeroes(content, config, actors, from?.state);
  if (heroes.length === 0) throw new RangeError('no actors');
  const heroIds = heroes.map((h) => h.snap.actorId);
  const groups = table?.entries.map((e) => ({ weight: e.weight, value: e })) ?? [];

  const segments: Segment<RpgIdleEvent, RpgIdleState>[] = [];
  let outcome: Outcome = 'completed';
  let index = from?.segment ?? 0;
  for (let used = 0; used < budget; used++, index++) {
    const streams = segmentStreams(seed, index);
    const loot = streams.stream('loot');
    const events: RpgIdleEvent[] = [];
    const deltas: LedgerDelta[] = [];
    let drop = 0; // round-robin counter for bag recipients
    const recipient = (): string => heroIds[(index + drop++) % heroIds.length] as string;
    const grant = (actorId: string, source: string, roll: ReturnType<typeof rollLoot>): void => {
      for (const it of roll.items) {
        events.push({ type: 'loot', actorId, source, item: it.item, qty: it.qty });
        deltas.push({ actorId, asset: itemAsset(content, it.item), qty: it.qty, to: INVENTORY });
      }
      if (roll.gold > 0) {
        events.push({ type: 'gold', actorId, source, qty: roll.gold });
        deltas.push({ actorId, asset: GOLD, qty: roll.gold });
      }
    };

    const dead: string[] = [];
    let timeout = false;
    const afterCombat = new Map<string, number>();
    const beforeCombat = new Map(heroes.map((h) => [h.snap.actorId, h.hp] as const));
    if (table !== undefined) {
      const entry = streams.stream('encounters').pickWeighted(groups);
      const members: EncounterMember[] = entry.enemies.map((m) => ({ enemy: m.enemy, count: m.count }));
      const foes = new Map<string, string>();
      const enemySetups: EnemySetup[] = [];
      for (const m of members) {
        for (let k = 0; k < m.count; k++) {
          const id = foeId(foes.size + 1);
          foes.set(id, m.enemy);
          enemySetups.push({ id, enemy: m.enemy });
        }
      }
      const heroSetups: HeroSetup[] = heroes.map((h) => ({
        id: h.snap.actorId,
        build: h.snap.build,
        skills: h.snap.skills,
        rules: h.snap.rules,
        consumables: h.consumables.filter((c) => c.qty > 0),
        hp: h.hp,
      }));
      const run = runToEnd(
        { heroes: heroSetups, enemies: enemySetups, content: content.combat, ...(content.formulas === undefined ? {} : { formulas: content.formulas }) },
        deriveSeed(segmentSeed(seed, index), 'combat'),
        NO_INPUTS,
        tuning.maxCombatTicks,
      );
      events.push({ type: 'encounter', enemies: members, result: run.outcome, ticks: run.ticks, combatHash: hashEvents(run.events) });
      timeout = run.outcome === 'timeout';

      for (const e of run.events) {
        if (e.type !== 'ActorDied') continue;
        const enemyId = foes.get(e.actorId);
        if (enemyId === undefined) continue;
        const def = content.combat.enemies[enemyId];
        if (def === undefined) throw new RangeError(`unknown enemy ${enemyId}`);
        events.push({ type: 'kill', enemy: enemyId, xp: def.xp, credited: [...heroIds] });
        if (def.lootTable !== undefined) grant(recipient(), enemyId, rollLoot(lootTable(content, def.lootTable), loot));
      }

      for (const h of heroes) {
        const after = run.state.actors.find((a) => a.id === h.snap.actorId);
        if (after === undefined) throw new RangeError(`hero ${h.snap.actorId} missing from combat state`);
        const startHp = h.hp;
        const before = h.consumables;
        h.consumables = before.map((c) => ({ item: c.item, qty: after.consumables.find((x) => x.item === c.item)?.qty ?? 0 }));
        before.forEach((c, j) => {
          const usedQty = c.qty - (h.consumables[j]?.qty ?? 0);
          if (usedQty > 0) {
            events.push({ type: 'consumable', actorId: h.snap.actorId, item: c.item, qty: usedQty });
            deltas.push({ actorId: h.snap.actorId, asset: stack(c.item), qty: usedQty, from: ESCROW });
          }
        });
        h.hp = after.alive ? after.hp : 0;
        afterCombat.set(h.snap.actorId, h.hp);
        if (!after.alive) {
          dead.push(h.snap.actorId);
          events.push({
            type: 'death',
            actorId: h.snap.actorId,
            causes: deathCauses({
              content,
              events: run.events,
              heroId: h.snap.actorId,
              foes,
              startHp,
              maxHp: h.maxHp,
              brought: config.consumables,
              left: h.consumables,
            }),
          });
        }
      }
    }

    if (dead.length === 0) {
      for (const h of heroes) {
        const fought = afterCombat.get(h.snap.actorId);
        if (fought === undefined) continue;
        const missing = h.maxHp - h.hp;
        const r = mulBp(h.maxHp, tuning.regenBetweenFightsBp);
        const regen = r < missing ? r : missing;
        h.hp += regen;
        events.push({ type: 'hp', actorId: h.snap.actorId, maxHp: h.maxHp, before: beforeCombat.get(h.snap.actorId) ?? fought, afterCombat: fought, regen, hp: h.hp });
      }
      for (const y of activity.resourceYields) {
        const rolls = mulDivFloor(index + 1, y.rollsPerHour, perHour) - mulDivFloor(index, y.rollsPerHour, perHour);
        const t = lootTable(content, y.lootTable);
        for (let r = 0; r < rolls; r++) grant(recipient(), y.node, rollLoot(t, loot));
      }
    } else {
      for (const h of heroes) {
        events.push({ type: 'hp', actorId: h.snap.actorId, maxHp: h.maxHp, before: beforeCombat.get(h.snap.actorId) ?? h.hp, afterCombat: h.hp, regen: 0, hp: h.hp });
      }
    }

    if (dead.length > 0) {
      outcome = 'failed';
    } else if (used + 1 < budget) {
      if (timeout) {
        events.push({ type: 'retreat', actorId: heroIds[0] as string, reason: 'combat_timeout' });
        outcome = 'retreated';
      } else if (config.retreat.belowHpBp > 0) {
        for (const h of heroes) {
          const low = h.hp * BP_SCALE < config.retreat.belowHpBp * h.maxHp;
          const healing = h.consumables.some((c) => c.qty > 0 && isHealingConsumable(content, c.item));
          if (low && !(config.retreat.onlyWhenNoHealing && healing)) {
            events.push({ type: 'retreat', actorId: h.snap.actorId, reason: 'low_hp' });
            outcome = 'retreated';
          }
        }
      }
    }
    segments.push({ index, weight: 1, events, deltas: mergeDeltas(deltas), stateAfter: stateOf(heroes) });
    if (outcome !== 'completed') break;
  }
  return { segments, outcome };
}
