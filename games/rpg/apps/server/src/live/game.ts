/**
 * RPG live plugin (`rpg.live`): the exploration state machine of docs/spec/state-machines.md §3 on top of the engine
 * live host (ADR-0012). States `exploring`, `combat`, `dead`, `closing`; commands are untrusted and validated here, the
 * server owns every result (ADR-0002). Combat ticks through the real `@rpg/rpg-sim` step engine (automation acts for
 * every hero, connected or not).
 *
 * Deterministic: all randomness derives from the host-supplied instance seed through `@engine/sim-core` streams, all
 * game math is integer/basis points, no clocks and no I/O. Durable records (discoveries, boss defeats) leave the plugin
 * as `LiveStep.effects` and are committed by the store in the checkpoint/close transaction (see `effects.ts`).
 *
 * Provisional rules (docs/open-decisions.md #14, #17, #18, #20, #21 — implemented provisionally by #38, pending
 * playtest) are named constants or isolated functions below so a decision change touches one place.
 */
import { divFloor, hashSeed, mulBp, RngStreams } from '@engine/sim-core';
import type { JsonValue, LiveCommandResult, LiveGame, LiveStep } from '@engine/live-kernel';
import { createActorWorldState, evaluateRequirement } from '@engine/world';
import type { AreaId, LocationId } from '@engine/world';
import { createCombat, ENGINE_VERSION, rpgIdleContentFromBundle, rollLoot, step } from '@rpg/rpg-sim';
import type { CombatContent, CombatInput, CombatState, ConsumableStack, HeroSetup, RpgIdleContent } from '@rpg/rpg-sim';
import type { AutomationRule, ConsumableItem } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';
import { totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';
import type { DeriveStatsInput } from '@rpg/rpg-stats';
import { XpCurveSchema } from '@rpg/rpg-schema';

import type { RpgLiveEffect } from './effects.ts';
import { BOSS_ROOM_TAG, buildLiveWorld, SAFE_TAG, SECRET_TAG } from './world.ts';
import type { LiveLocation, LiveWorld } from './world.ts';

export const RPG_LIVE_GAME_ID = 'rpg.live';
/** Bumped for the instance-scoped run bag, hero XP/snapshot fields and reward checkpoint shape; old state is refused. */
export const RPG_LIVE_VERSION = `rpg.live@0.4.0+${ENGINE_VERSION}`;
/** Open decision #1 (provisional). */
export const RPG_LIVE_TICK_MS = 500;

/** Open decision #14 (provisional): encounter rolls per location with an encounter table, on first entry per instance. */
export const SPAWN_ROLLS = 2;
/** Open decision #14 (provisional): a `boss_room` rolls its table once (one boss group). */
export const BOSS_ROOM_SPAWN_ROLLS = 1;
/** Open decision #18 (provisional): HP cost of a retreat, per living hero in the fight, in bp of max HP (never below 1 HP). */
export const RETREAT_HP_COST_BP = 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Setup and state
// ---------------------------------------------------------------------------------------------------------------------

/** Server-recorded world progress of a hero when the instance starts (read through `progress.ts`, never from clients). */
export interface RpgLiveHeroWorld {
  /** Discovered location IDs (any area). */
  readonly discovered: readonly string[];
  readonly objectives: readonly string[];
  readonly completedAreas: readonly string[];
}

export interface RpgLiveHeroSetup {
  readonly actorId: string;
  build: DeriveStatsInput;
  /** XP within the supplied level, from the server character row. */
  readonly xp?: number;
  readonly skills: readonly string[];
  readonly rules: readonly AutomationRule[];
  /** Snapshot consumable loadout carried into the instance (escrow through the ledger is #28/#42). */
  readonly consumables?: readonly ConsumableStack[];
  /** Hash of server-owned character/build/equipment/supply/progress rows validated under actor locks at create. */
  readonly snapshotHash?: string;
  readonly world?: RpgLiveHeroWorld;
}
export interface RpgLiveGroup { readonly id: string; readonly enemies: readonly string[] }
/**
 * Prepared by the composition root (trusted). `area` defaults to the area containing `location`; `location` defaults
 * to the area's start location. `groups` replaces the encounter roll of the starting location (tests, scripted events).
 */
export interface RpgLiveSetup {
  readonly area?: string;
  readonly location?: string;
  readonly groups?: readonly RpgLiveGroup[];
  readonly heroes: readonly RpgLiveHeroSetup[];
}

export type RpgLivePhase = 'exploring' | 'combat' | 'dead' | 'closing';

interface HeroState {
  readonly actorId: string;
  readonly snapshotHash?: string;
  build: DeriveStatsInput;
  xp: number;
  readonly skills: readonly string[];
  readonly rules: readonly AutomationRule[];
  /** Current HP; `null` = full. */
  hp: number | null;
  present: boolean;
  consumables: { item: string; qty: number }[];
  /** Consumables used in this instance (ledger consumption hook for #42/#28). */
  used: Record<string, number>;
  /** Cumulative units already emitted as durable ledger effects. */
  usedReported: Record<string, number>;
  /** Persisted progress at start plus this instance's discoveries/defeats. */
  world: { discovered: string[]; objectives: string[]; completedAreas: string[] };
}
interface GroupState { id: string; enemies: string[]; boss: boolean; defeated: boolean }

export interface RpgLiveState {
  readonly instanceId: string;
  readonly seed: number;
  readonly area: string;
  location: string;
  /** Location the party came from (retreat target); `null` at the start location. */
  previous: string | null;
  phase: RpgLivePhase;
  heroes: HeroState[];
  /** Locations entered in this instance, with the enemy groups rolled on first entry (no respawn within the instance). */
  visited: Record<string, { groups: GroupState[] }>;
  /** Instance-scoped world flags set by hotspot effects (open decision #20). Sorted. */
  flags: string[];
  /** `<location>/<hotspot>` already interacted with (effects apply once per instance). */
  hotspotsDone: string[];
  /** `<location>/<nodeId>` already gathered (once per instance per node). */
  gathered: string[];
  /** Per-actor secured-in-this-instance loot; mirrored to `run_bag:<instanceId>` by checkpoint effects. */
  runBag: Record<string, { items: Record<string, number>; gold: number }>;
  combat: CombatState | null;
  combatGroup: string | null;
  encounters: number;
  /** Exit for which the boss-room risk summary was sent at the current location (confirmation prerequisite). */
  bossWarning: string | null;
  /** Durable effects not yet committed (e.g. the start-location discovery); flushed with the next durable write. */
  outbox: RpgLiveEffect[];
  /** Manual inputs queued for the next tick. Never part of a checkpoint (combat checkpoints are pre-combat). */
  pending: CombatInput[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

type Command =
  | { type: 'travel'; exitId: string }
  | { type: 'interact'; hotspotId: string }
  | { type: 'gather'; nodeId: string }
  | { type: 'engage'; groupId: string }
  | { type: 'enterBossRoom'; exitId: string; confirm: boolean }
  | { type: 'useConsumable'; itemId: string }
  | { type: 'returnToSanctuary' }
  | { type: 'retreat' }
  | { type: 'setAuto'; auto: boolean }
  | { type: 'useSkill'; skill: string; target?: string };

const MAX_ID = 128;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;

/** Exact keys only; anything else is `malformed`. */
function parseCommand(input: JsonValue): Command | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort().join(',');
  const one = (field: string): string | null => (keys === `${field},type` && id(input[field]) ? input[field] : null);
  switch (input['type']) {
    case 'travel': { const exitId = one('exitId'); return exitId === null ? null : { type: 'travel', exitId }; }
    case 'interact': { const hotspotId = one('hotspotId'); return hotspotId === null ? null : { type: 'interact', hotspotId }; }
    case 'gather': { const nodeId = one('nodeId'); return nodeId === null ? null : { type: 'gather', nodeId }; }
    case 'engage': { const groupId = one('groupId'); return groupId === null ? null : { type: 'engage', groupId }; }
    case 'useConsumable': { const itemId = one('itemId'); return itemId === null ? null : { type: 'useConsumable', itemId }; }
    case 'enterBossRoom':
      return keys === 'confirm,exitId,type' && id(input['exitId']) && typeof input['confirm'] === 'boolean'
        ? { type: 'enterBossRoom', exitId: input['exitId'], confirm: input['confirm'] } : null;
    case 'returnToSanctuary': return keys === 'type' ? { type: 'returnToSanctuary' } : null;
    case 'retreat': return keys === 'type' ? { type: 'retreat' } : null;
    case 'setAuto': return keys === 'auto,type' && typeof input['auto'] === 'boolean' ? { type: 'setAuto', auto: input['auto'] } : null;
    case 'useSkill':
      if (keys === 'skill,type' && id(input['skill'])) return { type: 'useSkill', skill: input['skill'] };
      if (keys === 'skill,target,type' && id(input['skill']) && id(input['target'])) {
        return { type: 'useSkill', skill: input['skill'], target: input['target'] };
      }
      return null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------------------------------

export interface RpgLiveContent {
  readonly world: unknown;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
}

export function createRpgLiveGame(content: RpgLiveContent): LiveGame<RpgLiveState> {
  const idle: RpgIdleContent = rpgIdleContentFromBundle(content);
  const combatContent: CombatContent = idle.combat;
  const progression = content.collections['progression']?.[0] as { id?: unknown; xpToNext?: unknown } | undefined;
  if (!progression || progression.id !== 'progression:xp_curve') throw new RangeError('missing live XP curve');
  const xpCurve = XpCurveSchema.parse({ xpToNext: progression.xpToNext });
  const world: LiveWorld = buildLiveWorld(content.world);
  const formulas = idle.formulas ?? DEFAULT_STAT_FORMULAS;

  const locationOf = (locationId: string): LiveLocation => {
    const location = world.locations.get(locationId);
    if (!location) throw new RangeError(`unknown live location ${locationId}`);
    return location;
  };
  const maxHp = (hero: HeroState): number => deriveStats(hero.build, formulas).maxHp;
  const hpOf = (hero: HeroState): number => hero.hp ?? maxHp(hero);
  const consumable = (item: string): ConsumableItem | undefined => {
    const found = combatContent.items[item];
    return found?.kind === 'consumable' ? found : undefined;
  };
  const lootTable = (table: string) => {
    const value = idle.lootTables[table];
    if (!value) throw new RangeError(`unknown live loot table ${table}`);
    return value;
  };
  const bagFor = (state: RpgLiveState, actorId: string) => state.runBag[actorId] ??= { items: {}, gold: 0 };
  const addLoot = (state: RpgLiveState, actorId: string, items: readonly { item: string; qty: number }[], gold: number) => {
    const bag = bagFor(state, actorId);
    for (const drop of items) bag.items[drop.item] = (bag.items[drop.item] ?? 0) + drop.qty;
    bag.gold += gold;
  };
  function flushConsumableEffects(state: RpgLiveState, effects: RpgLiveEffect[]): void {
    for (const hero of state.heroes) for (const [item, used] of Object.entries(hero.used)) {
      const reported = hero.usedReported[item] ?? 0;
      for (let ordinal = reported + 1; ordinal <= used; ordinal += 1) {
        effects.push({ type: 'consumableUsed', actionId: `consume:${hero.actorId}:${item}:${ordinal}`,
          actorId: hero.actorId, item, qty: 1 });
      }
      if (used > reported) hero.usedReported[item] = used;
    }
  }

  /** Open decision #14 (provisional): deterministic per (instance seed, location), independent of visit order. */
  function rollGroups(seed: number, location: LiveLocation): GroupState[] {
    const table = location.encounters === undefined ? undefined : idle.encounterTables[location.encounters];
    if (!table) return [];
    const rng = RngStreams.fromSeed(seed).stream(`spawn:${location.id}`);
    const rolls = location.tags.has(BOSS_ROOM_TAG) ? BOSS_ROOM_SPAWN_ROLLS : SPAWN_ROLLS;
    const groups: GroupState[] = [];
    for (let index = 0; index < rolls; index += 1) {
      const entry = rng.pickWeighted(table.entries.map((value) => ({ weight: value.weight, value })));
      const enemies = entry.enemies.flatMap((member) => Array.from({ length: member.count }, () => member.enemy));
      groups.push({ id: `${location.id}/${index}`, enemies, defeated: false,
        boss: enemies.some((enemy) => combatContent.enemies[enemy]?.rank === 'boss') });
    }
    return groups;
  }

  function evalContext(state: RpgLiveState, hero: HeroState) {
    const discovered: Record<AreaId, LocationId[]> = {};
    for (const location of hero.world.discovered) {
      const area = world.locations.get(location)?.area;
      if (area !== undefined) (discovered[area as AreaId] ??= []).push(location as LocationId);
    }
    const defeatedEnemies = new Set(hero.world.objectives.flatMap((key) => (key.startsWith('defeated:') ? [key.slice('defeated:'.length)] : [])));
    return { actor: createActorWorldState({ discovered, completedAreas: hero.world.completedAreas as AreaId[], objectives: hero.world.objectives,
      flags: state.flags }), game: { defeatedEnemies, level: hero.build.level } };
  }

  /** An exit is open when its requirement holds for every present participant (party moves together; provisional). */
  function exitStatus(state: RpgLiveState, exit: LiveLocation['exits'][number]): { open: boolean; reasons: string[] } {
    if (!exit.requires) return { open: true, reasons: [] };
    const reasons = new Set<string>();
    for (const hero of state.heroes.filter((h) => h.present)) {
      for (const reason of evaluateRequirement(exit.requires, evalContext(state, hero), world.predicates).reasons) reasons.add(reason);
    }
    return { open: reasons.size === 0, reasons: [...reasons].sort() };
  }

  /** Moves the party into `to`: rolls its groups on first entry and discovers it for every present participant. */
  function enter(state: RpgLiveState, to: string, effects: RpgLiveEffect[], events: JsonValue[], preset?: readonly RpgLiveGroup[]): void {
    const location = locationOf(to);
    if (state.visited[to] === undefined) {
      const groups = preset ? preset.map((group) => ({ id: group.id, enemies: [...group.enemies], defeated: false,
        boss: group.enemies.some((enemy) => combatContent.enemies[enemy]?.rank === 'boss') })) : rollGroups(state.seed, location);
      state.visited[to] = { groups };
    }
    state.location = to;
    state.bossWarning = null;
    const discoverers: string[] = [];
    for (const hero of state.heroes) {
      if (!hero.present || hero.world.discovered.includes(to)) continue;
      hero.world.discovered.push(to);
      discoverers.push(hero.actorId);
      const completion = world.areas.get(location.area)?.completion;
      effects.push({ type: 'discovery', actorId: hero.actorId, areaId: location.area, locationId: to,
        ...(completion ? { completion } : {}) });
    }
    if (discoverers.length > 0) events.push({ type: 'discovered', locationId: to, actorIds: discoverers });
  }

  /** A durable step: checkpoint (or close) carrying the outbox plus `effects`, committed atomically by the store. */
  function persist(state: RpgLiveState, events: JsonValue[], effects: readonly RpgLiveEffect[] = [],
    close?: { outcome: string }): LiveStep<RpgLiveState> {
    const all = [...state.outbox, ...effects];
    const next: RpgLiveState = { ...state, outbox: [] };
    return { state: next, events, checkpoint: true, ...(all.length > 0 ? { effects: all as unknown as JsonValue[] } : {}),
      ...(close ? { close: { outcome: close.outcome, result: summary(next) } } : {}) };
  }

  function startCombat(state: RpgLiveState, group: GroupState, events: JsonValue[], effects: RpgLiveEffect[]): LiveStep<RpgLiveState> | { rejected: string } {
    const fighters = state.heroes.filter((h) => h.present && h.hp !== 0);
    if (fighters.length === 0) return { rejected: 'no_living_heroes' };
    const heroes: HeroSetup[] = fighters.map((h) => ({ id: h.actorId, build: h.build, skills: h.skills, rules: h.rules,
      consumables: h.consumables.filter((c) => c.qty > 0), ...(h.hp === null ? {} : { hp: h.hp }) }));
    const combat = createCombat({ heroes, content: combatContent,
      enemies: group.enemies.map((enemy, index) => ({ id: `${group.id}#${index}`, enemy })) }, hashSeed(state.seed, 'encounter', state.encounters));
    events.push({ type: 'combatStarted', groupId: group.id, boss: group.boss });
    // Pre-encounter checkpoint (combat tick 0): a crash mid-combat restarts this fight from its start (no escape by crash).
    return persist({ ...state, phase: 'combat', combat, combatGroup: group.id, encounters: state.encounters + 1, pending: [] }, events, effects);
  }

  /** Copies HP and remaining consumables of the fighters back to the heroes (consumption tracked for the ledger hook). */
  function absorbCombat(state: RpgLiveState, combat: CombatState): void {
    for (const hero of state.heroes) {
      const actor = combat.actors.find((a) => a.side === 'hero' && a.id === hero.actorId);
      if (!actor) continue;
      hero.hp = actor.hp;
      hero.consumables = hero.consumables.map((c) => {
        const left = actor.consumables.find((x) => x.item === c.item)?.qty ?? 0;
        if (left < c.qty) hero.used[c.item] = (hero.used[c.item] ?? 0) + (c.qty - left);
        return { item: c.item, qty: left };
      });
    }
  }

  function currentGroups(state: RpgLiveState): GroupState[] {
    return state.visited[state.location]?.groups ?? [];
  }

  /** Open decision #17 (provisional): out of combat, from a `safe` location, the area's start or a cleared boss room. */
  function mayReturn(state: RpgLiveState): boolean {
    const location = locationOf(state.location);
    if (location.tags.has(SAFE_TAG) || state.location === world.areas.get(state.area)?.startLocation) return true;
    return location.tags.has(BOSS_ROOM_TAG) && currentGroups(state).every((group) => group.defeated);
  }

  function riskSummary(state: RpgLiveState, to: LiveLocation): JsonValue {
    const groups = state.visited[to.id]?.groups ?? rollGroups(state.seed, to);
    return {
      locationId: to.id,
      enemies: groups.filter((g) => !g.defeated).flatMap((g) => g.enemies).map((enemy) => {
        const def = combatContent.enemies[enemy];
        return { enemy, rank: def?.rank ?? 'normal', level: def?.level ?? 0 };
      }),
      heroes: state.heroes.filter((h) => h.present).map((h) => ({ actorId: h.actorId, hp: hpOf(h), maxHp: maxHp(h),
        healingConsumables: h.consumables.filter((c) => isHealing(consumable(c.item))).reduce((sum, c) => sum + c.qty, 0) })),
      retreatAllowed: false,
      // Live death consequences (rewards-and-persistence §4, provisional; applied by #43). Text keys for the client.
      onDeath: ['live.death.run_bag_to_corpse', 'live.death.xp_penalty'],
    };
  }

  function summary(state: RpgLiveState): JsonValue {
    return {
      area: state.area,
      location: state.location,
      heroes: state.heroes.map((hero) => ({ actorId: hero.actorId, hp: hero.hp, present: hero.present,
        consumables: hero.consumables, used: hero.used, level: hero.build.level, xp: hero.xp })),
      defeatedGroups: Object.values(state.visited).flatMap((v) => v.groups.filter((g) => g.defeated).map((g) => g.id)),
      gathered: state.gathered,
      runBag: Object.entries(state.runBag).sort(([a], [b]) => a.localeCompare(b)).map(([actorId, bag]) => ({ actorId,
        items: Object.entries(bag.items).sort(([a], [b]) => a.localeCompare(b)).map(([item, qty]) => ({ item, qty })), gold: bag.gold })),
    } as unknown as JsonValue;
  }

  const game: LiveGame<RpgLiveState> = {
    id: RPG_LIVE_GAME_ID,
    version: RPG_LIVE_VERSION,
    tickIntervalMs: RPG_LIVE_TICK_MS,

    init({ instanceId, participants, seed, setup }) {
      const parsed = setup as unknown as RpgLiveSetup;
      const startArea = parsed.area ?? (parsed.location === undefined ? undefined : world.locations.get(parsed.location)?.area);
      const area = startArea === undefined ? undefined : world.areas.get(startArea);
      if (!area) throw new RangeError('live setup needs an explorable area or one of its locations');
      const location = parsed.location ?? area.startLocation;
      if (!area.locations.includes(location)) throw new RangeError(`location ${location} is not in ${area.id}`);
      const groupIds = new Set<string>();
      for (const group of parsed.groups ?? []) {
        if (groupIds.has(group.id)) throw new RangeError(`duplicate live group ${group.id}`);
        groupIds.add(group.id);
        if (group.enemies.length === 0 || group.enemies.some((enemy) => combatContent.enemies[enemy] === undefined)) {
          throw new RangeError(`invalid enemy group ${group.id}`);
        }
      }
      const heroes = participants.map((participant): HeroState => {
        const hero = parsed.heroes.find((h) => h.actorId === participant.actorId);
        if (!hero) throw new RangeError(`missing hero snapshot for ${participant.actorId}`);
        const consumables = (hero.consumables ?? []).map((c) => {
          if (!consumable(c.item) || !Number.isSafeInteger(c.qty) || c.qty <= 0) throw new RangeError(`invalid consumable ${c.item}`);
          return { item: c.item, qty: c.qty };
        });
        const totalXp = totalXpFromLevelProgress(hero.build.level, hero.xp ?? 0, xpCurve);
        const level = xpProgress(totalXp, xpCurve).level;
        return { actorId: hero.actorId, ...(hero.snapshotHash ? { snapshotHash: hero.snapshotHash } : {}),
          build: { ...structuredClone(hero.build), level }, xp: totalXp,
          skills: [...hero.skills], rules: structuredClone([...hero.rules]),
          hp: null, present: true, consumables, used: {}, usedReported: {},
          world: { discovered: [...(hero.world?.discovered ?? [])], objectives: [...(hero.world?.objectives ?? [])],
            completedAreas: [...(hero.world?.completedAreas ?? [])] } };
      }).sort((a, b) => (a.actorId < b.actorId ? -1 : 1));
      const state: RpgLiveState = { instanceId, seed, area: area.id, location, previous: null, phase: 'exploring', heroes, visited: {}, flags: [],
        hotspotsDone: [], gathered: [], runBag: {}, combat: null, combatGroup: null, encounters: 0, bossWarning: null, outbox: [], pending: [] };
      // Entering the area discovers its first location; the record is committed with the first durable write.
      enter(state, location, state.outbox, [], parsed.groups);
      return state;
    },

    applyCommand(input, actorId, raw): LiveCommandResult<RpgLiveState> {
      const command = parseCommand(raw);
      if (!command) return { rejected: 'malformed' };
      if (input.phase === 'dead' || input.phase === 'closing') return { rejected: 'instance_closing' };
      const actor = input.heroes.find((h) => h.actorId === actorId);
      if (!actor?.present) return { rejected: 'not_present' };
      const state = structuredClone(input);
      const hero = state.heroes.find((h) => h.actorId === actorId) as HeroState;
      const here = locationOf(state.location);
      const events: JsonValue[] = [];
      const effects: RpgLiveEffect[] = [];

      if (state.phase === 'combat') {
        switch (command.type) {
          case 'setAuto': state.pending.push({ actorId, kind: 'setAuto', auto: command.auto }); return { state };
          case 'useSkill':
            state.pending.push({ actorId, kind: 'useSkill', skill: command.skill, ...(command.target === undefined ? {} : { target: command.target }) });
            return { state };
          case 'useConsumable':
            // The combat engine validates stock, timing and death; ledger consumption follows the fight (#42/#28 hook).
            if (!hero.consumables.some((c) => c.item === command.itemId && c.qty > 0)) return { rejected: 'no_such_consumable' };
            state.pending.push({ actorId, kind: 'useConsumable', item: command.itemId });
            return { state };
          case 'retreat': return retreat(state);
          default: return { rejected: 'in_combat' };
        }
      }

      switch (command.type) {
        case 'setAuto': case 'useSkill': case 'retreat': return { rejected: 'not_in_combat' };

        case 'travel': {
          const exit = here.exits.find((e) => e.id === command.exitId);
          if (!exit) return { rejected: 'unknown_exit' };
          const status = exitStatus(state, exit);
          // A locked secret exit is indistinguishable from a missing one (no leak before the secret is revealed).
          if (!status.open) return { rejected: exit.tags.includes(SECRET_TAG) ? 'unknown_exit' : 'exit_locked' };
          if (locationOf(exit.to).tags.has(BOSS_ROOM_TAG)) return { rejected: 'boss_room_requires_confirmation' };
          const from = state.location;
          enter(state, exit.to, effects, events);
          state.previous = from;
          events.unshift({ type: 'traveled', exitId: exit.id, from, to: exit.to });
          return persist(state, events, effects);
        }

        case 'enterBossRoom': {
          const exit = here.exits.find((e) => e.id === command.exitId);
          if (!exit || (exit.tags.includes(SECRET_TAG) && !exitStatus(state, exit).open)) return { rejected: 'unknown_exit' };
          const target = locationOf(exit.to);
          if (!target.tags.has(BOSS_ROOM_TAG)) return { rejected: 'not_a_boss_room' };
          if (!exitStatus(state, exit).open) return { rejected: 'exit_locked' };
          if (!command.confirm) {
            // First step: the server sends the risk summary; only a later confirmation for the same exit enters.
            state.bossWarning = exit.id;
            return { state, events: [{ type: 'bossRoomWarning', exitId: exit.id, risk: riskSummary(state, target) }] };
          }
          if (state.bossWarning !== exit.id) return { rejected: 'confirmation_required' };
          const from = state.location;
          enter(state, exit.to, effects, events);
          state.previous = from;
          events.unshift({ type: 'traveled', exitId: exit.id, from, to: exit.to });
          // The boss aggroes on entry.
          const boss = currentGroups(state).find((g) => !g.defeated);
          if (!boss) return persist(state, events, effects);
          return startCombat(state, boss, events, effects);
        }

        case 'engage': {
          const group = currentGroups(state).find((g) => g.id === command.groupId && !g.defeated);
          if (!group) return { rejected: 'unknown_group' };
          return startCombat(state, group, events, effects);
        }

        case 'interact': {
          // Corpse recovery (#43) will add owner corpses spawned into the instance as interactable hotspots here.
          const hotspot = here.hotspots.find((h) => h.id === command.hotspotId);
          if (!hotspot) return { rejected: 'unknown_hotspot' };
          const key = `${here.id}/${hotspot.id}`;
          const base = { type: 'hotspotInteracted', hotspotId: hotspot.id, hotspotType: hotspot.type, textKey: hotspot.textKey };
          if (state.hotspotsDone.includes(key)) {
            // Replays show the text again but never re-apply effects.
            return { state, events: [{ ...base, repeat: true, flagsSet: [], revealedExits: [] }] };
          }
          const lockedBefore = here.exits.filter((exit) => !exitStatus(state, exit).open).map((exit) => exit.id);
          const flagsSet = (hotspot.effects ?? []).map((effect) => effect.setFlag).filter((flag) => !state.flags.includes(flag));
          state.flags = [...new Set([...state.flags, ...flagsSet])].sort();
          state.hotspotsDone.push(key);
          const revealedExits = lockedBefore.filter((exitId) => {
            const exit = here.exits.find((e) => e.id === exitId);
            return exit !== undefined && exitStatus(state, exit).open;
          });
          events.push({ ...base, repeat: false, flagsSet, revealedExits });
          return persist(state, events, effects);
        }

        case 'gather': {
          const node = here.resources.find((r) => r.nodeId === command.nodeId);
          if (!node) return { rejected: 'unknown_node' };
          const key = `${here.id}/${node.nodeId}`;
          if (state.gathered.includes(key)) return { rejected: 'already_gathered' };
          if (hero.hp === 0) return { rejected: 'hero_dead' };
          state.gathered.push(key);
          const actionId = `gather:${key}`;
          const rolled = rollLoot(lootTable(node.lootTable), RngStreams.fromSeed(hashSeed(state.seed, actionId)).stream('loot'));
          addLoot(state, actorId, rolled.items, rolled.gold);
          effects.push({ type: 'lootGranted', actionId, actorId, items: rolled.items.map((drop) => ({ ...drop,
            kind: combatContent.items[drop.item]?.kind === 'equipment' ? 'unique_mint' as const : 'stack' as const })), gold: rolled.gold });
          events.push({ type: 'gathered', nodeId: node.nodeId, resource: node.resource, lootTable: node.lootTable,
            drops: rolled.items.map(({ item, qty }) => ({ item, qty })), gold: rolled.gold, actorId });
          return persist(state, events, effects);
        }

        case 'useConsumable': return useOutOfCombat(state, hero, command.itemId);

        case 'returnToSanctuary': {
          if (!mayReturn(state)) return { rejected: 'not_safe_location' };
          // Run bag → inventory commit (#42) belongs in the store's close hook, in the same fenced transaction.
          return persist({ ...state, phase: 'closing' }, [{ type: 'returned', locationId: state.location }], effects, { outcome: 'returned' });
        }
      }
    },

    tick(state): LiveStep<RpgLiveState> {
      if (!state.combat) return { state };
      const result = step(state.combat, state.pending);
      const events: JsonValue[] = result.events.map((event) => ({ type: 'combat', event: event as unknown as JsonValue }));
      const outcome = result.state.outcome;
      if (outcome === null) return { state: { ...state, combat: result.state, pending: [] }, events };
      const ended = structuredClone({ ...state, combat: null, pending: [] }) as RpgLiveState;
      absorbCombat(ended, result.state);
      const groupId = state.combatGroup;
      const group = currentGroups(ended).find((g) => g.id === groupId);
      const effects: RpgLiveEffect[] = [];
      flushConsumableEffects(ended, effects);
      if (outcome === 'victory' && group) {
        group.defeated = true;
        const fighters = result.state.actors.filter((a) => a.side === 'hero' && a.alive).map((a) =>
          ended.heroes.find((h) => h.actorId === a.id)).filter((h): h is HeroState => Boolean(h?.present));
        const actionId = `victory:${group.id}`;
        const xpEach = group.enemies.reduce((sum, enemy) => sum + (combatContent.enemies[enemy]?.xp ?? 0), 0);
        const rewards = fighters.map((hero) => ({ actorId: hero.actorId, xp: xpEach,
          drops: [] as { item: string; qty: number; kind: 'stack' | 'unique_mint' }[], gold: 0 }));
        for (const [enemyIndex, enemyId] of group.enemies.entries()) {
          const tableId = combatContent.enemies[enemyId]?.lootTable;
          if (!tableId || rewards.length === 0) continue;
          const rolled = rollLoot(lootTable(tableId), RngStreams.fromSeed(hashSeed(state.seed, actionId, enemyIndex)).stream('loot'));
          const recipient = rewards[enemyIndex % rewards.length];
          if (!recipient) continue;
          recipient.drops.push(...rolled.items.map((drop) => ({ ...drop,
            kind: combatContent.items[drop.item]?.kind === 'equipment' ? 'unique_mint' as const : 'stack' as const })));
          recipient.gold += rolled.gold;
        }
        for (const reward of rewards) {
          const hero = ended.heroes.find((h) => h.actorId === reward.actorId);
          if (!hero) continue;
          hero.xp += reward.xp;
          hero.build = { ...hero.build, level: xpProgress(hero.xp, xpCurve).level };
          addLoot(ended, hero.actorId, reward.drops, reward.gold);
          if (reward.xp > 0) effects.push({ type: 'xpGranted', actionId, actorId: hero.actorId, xp: reward.xp,
            xpToNext: xpCurve.xpToNext });
          if (reward.drops.length > 0 || reward.gold > 0) effects.push({ type: 'lootGranted', actionId, actorId: hero.actorId, items: reward.drops, gold: reward.gold });
        }
        events.push({ type: 'combatRewards', groupId: group.id, rewards });
        if (group.boss) {
          // Boss credit goes to the participants who were in the fight, alive or dead (conquest-rules, provisional).
          const bosses = [...new Set(group.enemies.filter((enemy) => combatContent.enemies[enemy]?.rank === 'boss'))].sort();
          const completion = world.areas.get(ended.area)?.completion;
          for (const fighter of result.state.actors.filter((a) => a.side === 'hero')) {
            const hero = ended.heroes.find((h) => h.actorId === fighter.id);
            if (!hero?.present) continue;
            effects.push({ type: 'bossDefeated', actorId: fighter.id, areaId: ended.area, enemyIds: bosses,
              ...(completion ? { completion } : {}) });
            for (const enemy of bosses) if (!hero.world.objectives.includes(`defeated:${enemy}`)) hero.world.objectives.push(`defeated:${enemy}`);
          }
        }
      }
      events.push({ type: 'combatEnded', outcome, groupId });
      // Party wiped: `dead`, then the instance closes (corpse creation and penalties are #43, open decisions #7/#8).
      if (outcome === 'defeat') {
        return persist({ ...ended, phase: 'dead', combatGroup: null }, events, effects, { outcome: 'defeated' });
      }
      return persist({ ...ended, phase: 'exploring', combatGroup: null }, events, effects);
    },

    isTicking: (state) => state.phase === 'combat',

    removeParticipant(state, actorId) {
      // Grace expired mid-combat: keep fighting on automation until the encounter ends.
      if (state.phase === 'combat') return null;
      const next = { ...state, heroes: state.heroes.map((hero) => (hero.actorId === actorId ? { ...hero, present: false } : hero)) };
      return { ...persist(next, [{ type: 'heroLeft', actorId }]), checkpoint: false };
    },

    serialize: (state) => ({ ...state, pending: [] }) as unknown as JsonValue,
    restore: (checkpoint) => ({ ...(structuredClone(checkpoint) as unknown as RpgLiveState), pending: [] }),
    view: (state) => {
      const here = locationOf(state.location);
      return {
        phase: state.phase, area: state.area, location: state.location,
        heroes: state.heroes.map((hero) => ({ actorId: hero.actorId, hp: hero.hp, maxHp: maxHp(hero), present: hero.present,
          consumables: hero.consumables, level: hero.build.level, xp: hero.xp })),
        groups: currentGroups(state).map((group) => ({ id: group.id, enemies: group.enemies, boss: group.boss, defeated: group.defeated })),
        runBag: Object.entries(state.runBag).sort(([a], [b]) => a.localeCompare(b)).map(([actorId, bag]) => ({ actorId,
          items: Object.entries(bag.items).sort(([a], [b]) => a.localeCompare(b)).map(([item, qty]) => ({ item, qty })), gold: bag.gold })),
        exits: here.exits.flatMap((exit) => {
          const status = exitStatus(state, exit);
          if (!status.open && exit.tags.includes(SECRET_TAG)) return [];
          return [{ id: exit.id, to: exit.to, open: status.open, reasons: status.reasons,
            bossRoom: locationOf(exit.to).tags.has(BOSS_ROOM_TAG), visited: state.visited[exit.to] !== undefined }];
        }),
        hotspots: here.hotspots.map((h) => ({ id: h.id, type: h.type, textKey: h.textKey, done: state.hotspotsDone.includes(`${here.id}/${h.id}`) })),
        resources: here.resources.map((r) => ({ nodeId: r.nodeId, resource: r.resource, gathered: state.gathered.includes(`${here.id}/${r.nodeId}`) })),
        flags: state.flags,
        canReturn: state.phase === 'exploring' && mayReturn(state),
        combat: state.combat === null ? null : { tick: state.combat.tick, groupId: state.combatGroup,
          actors: state.combat.actors.map((actor) => ({ id: actor.id, side: actor.side, hp: actor.hp, alive: actor.alive })) },
      } as unknown as JsonValue;
    },
  };

  /** Open decision #18 (provisional): non-boss fights only; HP cost; fall back to the previous location; group stays. */
  function retreat(state: RpgLiveState): LiveCommandResult<RpgLiveState> {
    const combat = state.combat as CombatState;
    const group = currentGroups(state).find((g) => g.id === state.combatGroup);
    if (!group || group.boss || locationOf(state.location).tags.has(BOSS_ROOM_TAG)) return { rejected: 'retreat_not_allowed' };
    absorbCombat(state, combat);
    const costs: { actorId: string; hp: number }[] = [];
    for (const actor of combat.actors.filter((a) => a.side === 'hero')) {
      const hero = state.heroes.find((h) => h.actorId === actor.id);
      if (!hero || hero.hp === 0 || hero.hp === null) continue;
      const cost = mulBp(actor.stats.maxHp, RETREAT_HP_COST_BP);
      const after = hero.hp - cost < 1 ? 1 : hero.hp - cost;
      costs.push({ actorId: hero.actorId, hp: hero.hp - after });
      hero.hp = after;
    }
    const events: JsonValue[] = [{ type: 'combatEnded', outcome: 'retreated', groupId: group.id }];
    const effects: RpgLiveEffect[] = [];
    flushConsumableEffects(state, effects);
    const from = state.location;
    const next: RpgLiveState = { ...state, phase: 'exploring', combat: null, combatGroup: null, pending: [] };
    if (state.previous !== null) {
      enter(next, state.previous, effects, events);
      next.previous = from;
    }
    events.push({ type: 'retreated', from, to: next.location, hpCost: costs });
    return persist(next, events, effects);
  }

  /**
   * Open decision #21 (provisional): out of combat only healing consumables apply; instant `heal` effects heal
   * `maxHp × coeff`, a `hot` heals its whole duration at once (`perTick × ⌊ticks / period⌋`, tick durations only).
   * Same max-HP scaling as the combat engine applies to items.
   */
  function useOutOfCombat(state: RpgLiveState, hero: HeroState, itemId: string): LiveCommandResult<RpgLiveState> {
    const stack = hero.consumables.find((c) => c.item === itemId && c.qty > 0);
    const item = consumable(itemId);
    if (!stack || !item) return { rejected: 'no_such_consumable' };
    if (!isHealing(item)) return { rejected: 'no_effect_out_of_combat' };
    if (hero.hp === 0) return { rejected: 'hero_dead' };
    const max = maxHp(hero);
    const before = hpOf(hero);
    if (before >= max) return { rejected: 'full_hp' };
    let healed = 0;
    for (const effect of item.use) {
      if (effect.type === 'heal') healed += mulBp(max, effect.coeffBp);
      if (effect.type === 'hot' && effect.duration.unit === 'ticks') {
        healed += mulBp(max, effect.coeffBp) * divFloor(effect.duration.value, effect.periodTicks);
      }
    }
    const after = before + healed > max ? max : before + healed;
    stack.qty -= 1;
    hero.used[itemId] = (hero.used[itemId] ?? 0) + 1;
    hero.hp = after === max ? null : after;
    // Ledger consumption (#42/#28): `used` is reported in the close result for settlement.
    const effects: RpgLiveEffect[] = [];
    flushConsumableEffects(state, effects);
    return persist(state, [{ type: 'consumableUsed', actorId: hero.actorId, itemId, hpBefore: before, hp: after }], effects);
  }

  return game;
}

function isHealing(item: ConsumableItem | undefined): boolean {
  return item?.use.some((effect) => effect.type === 'heal' || effect.type === 'hot') ?? false;
}
