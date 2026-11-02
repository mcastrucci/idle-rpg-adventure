/**
 * Minimal RPG live plugin for spike 3 (#13): one location with authored enemy groups, `engage`, combat ticks through the
 * real `@rpg/rpg-sim` step engine (automation acts for every hero, connected or not), and `returnToSanctuary`.
 * Travel, hotspots, gathering, loot and corpses are stubs/out of scope. Deterministic: all randomness derives from the
 * host-supplied instance seed.
 */
import { hashSeed } from '@engine/sim-core';
import type { JsonValue, LiveCommandResult, LiveGame, LiveStep } from '@engine/live-kernel';
import type { LoadedContent } from '@engine/server-kit';
import { createCombat, ENGINE_VERSION, rpgIdleContentFromBundle, step } from '@rpg/rpg-sim';
import type { CombatContent, CombatInput, CombatState, HeroSetup } from '@rpg/rpg-sim';
import type { AutomationRule } from '@rpg/rpg-schema';
import type { DeriveStatsInput } from '@rpg/rpg-stats';

export const RPG_LIVE_GAME_ID = 'rpg.live';
export const RPG_LIVE_VERSION = `rpg.live@0.1.0+${ENGINE_VERSION}`;
/** Open decision #1 (provisional). */
export const RPG_LIVE_TICK_MS = 500;

export interface RpgLiveHeroSetup {
  readonly actorId: string;
  readonly build: DeriveStatsInput;
  readonly skills: readonly string[];
  readonly rules: readonly AutomationRule[];
}
export interface RpgLiveGroup { readonly id: string; readonly enemies: readonly string[] }
export interface RpgLiveSetup {
  readonly location: string;
  readonly groups: readonly RpgLiveGroup[];
  readonly heroes: readonly RpgLiveHeroSetup[];
}

interface HeroState extends RpgLiveHeroSetup {
  /** Current HP; `null` = full. */
  hp: number | null;
  present: boolean;
}
export interface RpgLiveState {
  readonly seed: number;
  readonly location: string;
  phase: 'exploring' | 'combat';
  heroes: HeroState[];
  groups: { id: string; enemies: string[]; defeated: boolean }[];
  /** Started combat (tick 0 when checkpointed at engage = the pre-combat checkpoint). */
  combat: CombatState | null;
  combatGroup: string | null;
  encounters: number;
  /** Manual inputs queued for the next tick. Never part of a checkpoint (combat checkpoints are pre-combat). */
  pending: CombatInput[];
}

type Command =
  | { type: 'engage'; groupId: string }
  | { type: 'returnToSanctuary' }
  | { type: 'setAuto'; auto: boolean }
  | { type: 'useSkill'; skill: string; target?: string };

function parseCommand(input: JsonValue): Command | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort().join(',');
  switch (input['type']) {
    case 'engage': return keys === 'groupId,type' && typeof input['groupId'] === 'string' ? { type: 'engage', groupId: input['groupId'] } : null;
    case 'returnToSanctuary': return keys === 'type' ? { type: 'returnToSanctuary' } : null;
    case 'setAuto': return keys === 'auto,type' && typeof input['auto'] === 'boolean' ? { type: 'setAuto', auto: input['auto'] } : null;
    case 'useSkill':
      if (keys === 'skill,type' && typeof input['skill'] === 'string') return { type: 'useSkill', skill: input['skill'] };
      if (keys === 'skill,target,type' && typeof input['skill'] === 'string' && typeof input['target'] === 'string') {
        return { type: 'useSkill', skill: input['skill'], target: input['target'] };
      }
      return null;
    default: return null;
  }
}

function summary(state: RpgLiveState): JsonValue {
  return {
    location: state.location,
    heroes: state.heroes.map((hero) => ({ actorId: hero.actorId, hp: hero.hp, present: hero.present })),
    defeatedGroups: state.groups.filter((group) => group.defeated).map((group) => group.id),
  };
}

export function createRpgLiveGame(content: LoadedContent | { collections: LoadedContent['collections'] }): LiveGame<RpgLiveState> {
  const combatContent: CombatContent = rpgIdleContentFromBundle(content).combat;
  const game: LiveGame<RpgLiveState> = {
    id: RPG_LIVE_GAME_ID,
    version: RPG_LIVE_VERSION,
    tickIntervalMs: RPG_LIVE_TICK_MS,

    init({ participants, seed, setup }) {
      const parsed = setup as unknown as RpgLiveSetup;
      for (const group of parsed.groups) {
        if (group.enemies.length === 0 || group.enemies.some((enemy) => combatContent.enemies[enemy] === undefined)) {
          throw new RangeError(`invalid enemy group ${group.id}`);
        }
      }
      const heroes = participants.map((participant) => {
        const hero = parsed.heroes.find((h) => h.actorId === participant.actorId);
        if (!hero) throw new RangeError(`missing hero snapshot for ${participant.actorId}`);
        return { ...structuredClone(hero), hp: null, present: true };
      }).sort((a, b) => (a.actorId < b.actorId ? -1 : 1));
      return { seed, location: parsed.location, phase: 'exploring', heroes, combat: null, combatGroup: null, encounters: 0, pending: [],
        groups: parsed.groups.map((group) => ({ id: group.id, enemies: [...group.enemies], defeated: false })) };
    },

    applyCommand(state, actorId, raw): LiveCommandResult<RpgLiveState> {
      const command = parseCommand(raw);
      if (!command) return { rejected: 'malformed' };
      const hero = state.heroes.find((h) => h.actorId === actorId);
      if (!hero?.present) return { rejected: 'not_present' };
      if (command.type === 'engage') {
        if (state.phase !== 'exploring') return { rejected: 'in_combat' };
        const group = state.groups.find((g) => g.id === command.groupId && !g.defeated);
        if (!group) return { rejected: 'unknown_group' };
        const fighters = state.heroes.filter((h) => h.present && h.hp !== 0);
        if (fighters.length === 0) return { rejected: 'no_living_heroes' };
        const heroes: HeroSetup[] = fighters.map((h) => ({ id: h.actorId, build: h.build,
          skills: h.skills, rules: h.rules, ...(h.hp === null ? {} : { hp: h.hp }) }));
        const combat = createCombat({ heroes, content: combatContent,
          enemies: group.enemies.map((enemy, index) => ({ id: `${group.id}#${index}`, enemy })) }, hashSeed(state.seed, 'encounter', state.encounters));
        // Checkpoint at combat tick 0: a crash mid-combat restarts this fight from its start (no escape by crash).
        return { state: { ...state, phase: 'combat', combat, combatGroup: group.id, encounters: state.encounters + 1, pending: [] },
          events: [{ type: 'combatStarted', groupId: group.id }], checkpoint: true };
      }
      if (command.type === 'returnToSanctuary') {
        // Open decision #17: provisional "out of combat only"; the stub location counts as a start location.
        if (state.phase !== 'exploring') return { rejected: 'in_combat' };
        return { state, events: [{ type: 'returned' }], close: { outcome: 'returned', result: summary(state) } };
      }
      if (state.phase !== 'combat') return { rejected: 'not_in_combat' };
      const input: CombatInput = command.type === 'setAuto' ? { actorId, kind: 'setAuto', auto: command.auto }
        : { actorId, kind: 'useSkill', skill: command.skill, ...(command.target === undefined ? {} : { target: command.target }) };
      return { state: { ...state, pending: [...state.pending, input] } };
    },

    tick(state): LiveStep<RpgLiveState> {
      if (!state.combat) return { state };
      const result = step(state.combat, state.pending);
      const events: JsonValue[] = result.events.map((event) => ({ type: 'combat', event: event as unknown as JsonValue }));
      const outcome = result.state.outcome;
      if (outcome === null) return { state: { ...state, combat: result.state, pending: [] }, events };
      const hpOf = new Map(result.state.actors.filter((a) => a.side === 'hero').map((a) => [a.id, a.hp]));
      const heroes = state.heroes.map((hero) => (hpOf.has(hero.actorId) ? { ...hero, hp: hpOf.get(hero.actorId) ?? 0 } : hero));
      const ended: RpgLiveState = { ...state, phase: 'exploring', heroes, combat: null, combatGroup: null, pending: [],
        groups: state.groups.map((group) => (group.id === state.combatGroup && outcome === 'victory' ? { ...group, defeated: true } : group)) };
      events.push({ type: 'combatEnded', outcome, groupId: state.combatGroup });
      // Party wiped: the instance closes with a death outcome (corpse/penalties are open decisions #7/#8).
      if (outcome === 'defeat') return { state: ended, events, close: { outcome: 'defeated', result: summary(ended) } };
      return { state: ended, events, checkpoint: true };
    },

    isTicking: (state) => state.phase === 'combat',

    removeParticipant(state, actorId) {
      // Grace expired mid-combat: keep fighting on automation until the encounter ends.
      if (state.phase === 'combat') return null;
      return { state: { ...state, heroes: state.heroes.map((hero) => (hero.actorId === actorId ? { ...hero, present: false } : hero)) },
        events: [{ type: 'heroLeft', actorId }] };
    },

    serialize: (state) => ({ ...state, pending: [] }) as unknown as JsonValue,
    restore: (checkpoint) => ({ ...(structuredClone(checkpoint) as unknown as RpgLiveState), pending: [] }),
    view: (state) => ({
      phase: state.phase, location: state.location,
      heroes: state.heroes.map((hero) => ({ actorId: hero.actorId, hp: hero.hp, present: hero.present })),
      groups: state.groups.map((group) => ({ id: group.id, enemies: group.enemies, defeated: group.defeated })),
      combat: state.combat === null ? null : { tick: state.combat.tick,
        actors: state.combat.actors.map((actor) => ({ id: actor.id, side: actor.side, hp: actor.hp, alive: actor.alive })) },
    }),
  };
  return game;
}
