/**
 * The step-based combat engine (docs/spec/combat-engine.md §1–§2, ADR-0004).
 *
 * Tick order (§2), for tick `t = state.tick + 1`:
 *   1. Apply inputs in the given order (queue manual actions, toggle automation); invalid ones emit `InputRejected`.
 *   2. Periodic effects (DoT/HoT) due at `t`, in effect-application order.
 *   3. Ready actors: alive and either a windup resolving at `t` or `nextActionTick ≤ t`; sorted by initiative
 *      (effective `haste`) descending, then actor ID ascending. The list is fixed at this point; actors that die before
 *      their turn are skipped.
 *   4. Each ready actor: resolve a due windup; else a stunned actor skips its action; else choose an action
 *      (queued manual input → automation rules (if auto) → enemy AI) and resolve it — or, for skills with
 *      `windupTicks > 0`, emit `TelegraphStarted` and resolve at `t + windupTicks`. Processing stops as soon as one side
 *      is wiped out.
 *   5. Decrement `ticks` durations (effects applied before `t`) and expire them.
 *   6. End check: no living hero ⇒ defeat (also when both sides fall in the same tick); else no living enemy ⇒ victory.
 *
 * Timing: the action timer restarts when an action resolves (`nextActionTick = t + actionIntervalTicks`, read from the
 * current effective stats, so haste buffs apply from the next action). A telegraphed action therefore occupies
 * `windupTicks + interval` ticks. Cooldowns start when the action starts. A ready actor with nothing to do (manual mode
 * without input, or no rule matches) stays ready and is re-evaluated every tick.
 */
import { RngStreams, assertSeed } from '@engine/sim-core';
import type { Seed } from '@engine/sim-core';
import type { ConsumableItem, Skill } from '@rpg/rpg-schema';
import { isBoss } from '@rpg/rpg-schema';
import { DEFAULT_STAT_FORMULAS } from '@rpg/rpg-stats';

import { createCtx, emit, living } from './context.ts';
import type { Ctx } from './context.ts';
import {
  applyEffect,
  consumeCharge,
  dealDamage,
  heal,
  heldBefore,
  isHarmful,
} from './effects.ts';
import { automationChoice, consumableQty, enemyChoice, isSelector, resolveTargets, skillChoice } from './rules.ts';
import type { Choice } from './rules.ts';
import { enemyStats, heroStats } from './stats.ts';
import type {
  ActorState,
  CombatEvent,
  CombatInput,
  CombatOutcome,
  CombatSetup,
  CombatState,
  CombatTuning,
  InputRejectReason,
} from './types.ts';
import { ENGINE_VERSION } from '../version.ts';

/** Provisional constants (open decision #2): 1 armor/resist point = +1% effective HP; crits deal 150%. */
export const DEFAULT_COMBAT_TUNING: CombatTuning = Object.freeze({ armorKBp: 100, critMultBp: 15_000 });

/** Default `runToEnd` safety cap. */
export const DEFAULT_MAX_TICKS = 10_000;

// ---------------------------------------------------------------------------------------------------------------------
// createCombat
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Builds the initial state. Throws on an invalid setup (server-built data, not player input): duplicate actor IDs,
 * unknown content, empty sides. Only referenced skills/consumables are copied into the state.
 */
export function createCombat(setup: CombatSetup, seed: Seed): CombatState {
  assertSeed(seed);
  if (setup.heroes.length === 0 || setup.enemies.length === 0) throw new RangeError('combat needs heroes and enemies');
  const formulas = setup.formulas ?? DEFAULT_STAT_FORMULAS;
  const tuning: CombatTuning = { ...DEFAULT_COMBAT_TUNING, ...setup.tuning };
  const skills: Record<string, Skill> = {};
  const items: Record<string, ConsumableItem> = {};
  const needSkill = (id: string): void => {
    const s = setup.content.skills[id];
    if (s === undefined) throw new RangeError(`unknown skill ${id}`);
    skills[id] = s;
  };
  const needItem = (id: string): void => {
    const it = setup.content.items[id];
    if (it === undefined || it.kind !== 'consumable') throw new RangeError(`unknown consumable ${id}`);
    items[id] = it;
  };

  const actors: ActorState[] = [];
  const seen = new Set<string>();
  const claimId = (id: string): void => {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) throw new RangeError(`invalid or duplicate actor id "${id}"`);
    seen.add(id);
  };

  for (const h of setup.heroes) {
    claimId(h.id);
    h.skills.forEach(needSkill);
    const consumables = (h.consumables ?? []).map((c) => {
      needItem(c.item);
      if (!Number.isSafeInteger(c.qty) || c.qty < 0) throw new RangeError(`invalid consumable qty for ${c.item}`);
      return { item: c.item, qty: c.qty };
    });
    for (const r of h.rules) {
      if ('useConsumable' in r.do && setup.content.items[r.do.useConsumable] !== undefined) needItem(r.do.useConsumable);
    }
    const stats = heroStats(h.build, [], formulas);
    actors.push({
      id: h.id,
      side: 'hero',
      enemy: null,
      hp: clampHp(h.hp, stats.maxHp),
      alive: true,
      stats,
      build: h.build,
      baseStats: null,
      skills: [...h.skills],
      cooldowns: {},
      rules: h.rules,
      ai: [],
      boss: null,
      auto: h.auto ?? true,
      consumables,
      queued: null,
      windup: null,
      nextActionTick: 1,
      actionsTaken: 0,
    });
  }
  for (const e of setup.enemies) {
    claimId(e.id);
    const def = setup.content.enemies[e.enemy];
    if (def === undefined) throw new RangeError(`unknown enemy ${e.enemy}`);
    def.skills.forEach(needSkill);
    const stats = enemyStats(def.stats, [], formulas);
    actors.push({
      id: e.id,
      side: 'enemy',
      enemy: def.id,
      hp: clampHp(e.hp, stats.maxHp),
      alive: true,
      stats,
      build: null,
      baseStats: def.stats,
      skills: [...def.skills],
      cooldowns: {},
      rules: [],
      ai: def.ai,
      boss: isBoss(def) ? { phases: def.phases, phaseIndex: 0, rotationIndex: 0 } : null,
      auto: true,
      consumables: [],
      queued: null,
      windup: null,
      nextActionTick: 1,
      actionsTaken: 0,
    });
  }
  actors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Deep copy through JSON: the state owns plain data only and never aliases the caller's content objects.
  return JSON.parse(
    JSON.stringify({
      engineVersion: ENGINE_VERSION,
      tick: 0,
      rng: RngStreams.fromSeed(seed).state(),
      formulas,
      tuning,
      actors,
      effects: [],
      nextUid: 1,
      eventSeq: 0,
      outcome: null,
      content: { skills: sortKeys(skills), items: sortKeys(items) },
    } satisfies CombatState),
  ) as CombatState;
}

function clampHp(hp: number | undefined, maxHp: number): number {
  if (hp === undefined) return maxHp;
  if (!Number.isSafeInteger(hp) || hp < 1) throw new RangeError(`starting hp must be a positive integer, got ${hp}`);
  return Math.min(hp, maxHp);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(record).sort()) out[k] = record[k] as T;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// step / isFinished
// ---------------------------------------------------------------------------------------------------------------------

export interface StepResult {
  readonly state: CombatState;
  readonly events: CombatEvent[];
}

/**
 * Advances one tick. Pure at the boundary: `state` is not modified (a deep copy is stepped). The RNG lives in
 * `state.rng`; callers that keep a live `RngStreams` for speed may pass it as `rng` (it must match `state.rng`; the
 * returned state carries its updated snapshot). Never throws on player input. A finished combat stays finished:
 * stepping it returns an equal state and no events.
 */
export function step(state: CombatState, inputs: readonly CombatInput[], rng?: RngStreams): StepResult {
  if (state.outcome !== null) return { state, events: [] };
  const work = structuredClone(state);
  const events = stepInPlace(work, inputs, rng ?? RngStreams.fromState(work.rng));
  return { state: work, events };
}

export function isFinished(state: CombatState): CombatOutcome | null {
  return state.outcome;
}

/** Steps `state` in place (internal; used by `step` on a copy and by `runToEnd` on its own working state). */
export function stepInPlace(state: CombatState, inputs: readonly CombatInput[], rng: RngStreams): CombatEvent[] {
  const events: CombatEvent[] = [];
  if (state.outcome !== null) return events;
  const tick = state.tick + 1;
  state.tick = tick;
  const ctx = createCtx(state, rng, tick, events);

  if (tick === 1) {
    emit(ctx, {
      type: 'CombatStarted',
      engineVersion: state.engineVersion,
      heroes: state.actors.filter((a) => a.side === 'hero').map((a) => a.id),
      enemies: state.actors.filter((a) => a.side === 'enemy').map((a) => a.id),
    });
  }

  // 1. Inputs.
  for (const input of inputs) applyInput(ctx, input);

  // 2. Periodic effects, in application order.
  for (const e of [...state.effects]) {
    if ((e.type !== 'dot' && e.type !== 'hot') || e.nextAt > tick) continue;
    if (!state.effects.includes(e)) continue; // removed earlier this phase (death)
    const holder = ctx.byId.get(e.holderId);
    if (holder === undefined || !holder.alive) continue;
    e.nextAt += e.periodTicks;
    if (e.type === 'dot') dealDamage(ctx, e.sourceId, holder, e.perTick, e.school, e.origin, true);
    else heal(ctx, e.sourceId, holder, e.perTick, e.origin, true);
  }

  // 3. Ready actors.
  const ready = state.actors
    .filter((a) => a.alive && (a.windup !== null ? a.windup.resolveAtTick <= tick : a.nextActionTick <= tick))
    .sort((a, b) => b.stats.haste - a.stats.haste || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 4. Actions.
  for (const a of ready) {
    if (sideWiped(ctx)) break;
    if (!a.alive) continue;
    act(ctx, a);
  }

  // 5. Tick durations.
  for (const e of [...state.effects]) {
    if (e.unit !== 'ticks' || e.appliedTick >= tick || !state.effects.includes(e)) continue;
    consumeCharge(ctx, e);
  }

  // 6. End check.
  const outcome: CombatOutcome | null =
    living(ctx, 'hero').length === 0 ? 'defeat' : living(ctx, 'enemy').length === 0 ? 'victory' : null;
  if (outcome !== null) {
    state.outcome = outcome;
    emit(ctx, { type: 'CombatEnded', outcome });
  }
  state.rng = rng.state();
  return events;
}

function sideWiped(ctx: Ctx): boolean {
  return living(ctx, 'hero').length === 0 || living(ctx, 'enemy').length === 0;
}

function act(ctx: Ctx, a: ActorState): void {
  const { tick } = ctx;
  // Due windup.
  if (a.windup !== null) {
    const w = a.windup;
    a.windup = null;
    const skill = ctx.state.content.skills[w.skill] as Skill;
    let targets: readonly string[] | null = w.targetIds;
    const anyDead = w.targetIds.some((id) => ctx.byId.get(id)?.alive !== true);
    if (anyDead) targets = resolveTargets(ctx, a, skill, w.selector);
    if (targets !== null) resolveSkill(ctx, a, skill, targets);
    a.nextActionTick = tick + a.stats.actionIntervalTicks;
    return;
  }

  // Stunned: the action is skipped and the timer restarts.
  const stun = ctx.state.effects.find((e) => e.holderId === a.id && e.type === 'stun');
  if (stun !== undefined) {
    emit(ctx, { type: 'ActionSkipped', actorId: a.id, reason: 'stunned' });
    a.nextActionTick = tick + a.stats.actionIntervalTicks;
    if (stun.unit !== 'ticks') consumeCharge(ctx, stun);
    return;
  }

  const choice = choose(ctx, a);
  if (choice === null) return; // waits, still ready next tick

  if (choice.kind === 'consumable') {
    emit(ctx, { type: 'ActionStarted', actorId: a.id, action: { kind: 'consumable', item: choice.item }, targetIds: [a.id], source: choice.source });
    resolveConsumable(ctx, a, choice.item);
    a.nextActionTick = tick + a.stats.actionIntervalTicks;
    return;
  }

  const { skill, targetIds } = choice;
  emit(ctx, { type: 'ActionStarted', actorId: a.id, action: { kind: 'skill', skill: skill.id }, targetIds, source: choice.source });
  if (skill.cooldownTicks > 0) a.cooldowns[skill.id] = tick + skill.cooldownTicks;
  if (skill.windupTicks > 0) {
    a.windup = {
      skill: skill.id,
      targetIds,
      selector: choice.selector,
      startedTick: tick,
      resolveAtTick: tick + skill.windupTicks,
      source: choice.source,
    };
    emit(ctx, { type: 'TelegraphStarted', actorId: a.id, skill: skill.id, targetIds, resolveAtTick: a.windup.resolveAtTick });
    return;
  }
  resolveSkill(ctx, a, skill, targetIds);
  a.nextActionTick = tick + a.stats.actionIntervalTicks;
}

/** Queued manual input → automation rules (heroes with auto on) → enemy AI. */
function choose(ctx: Ctx, a: ActorState): Choice | null {
  if (a.queued !== null) {
    const q = a.queued;
    a.queued = null;
    if (q.kind === 'useConsumable') {
      if (consumableQty(a, q.item) > 0) return { kind: 'consumable', item: q.item, source: 'manual' };
      reject(ctx, a.id, q.kind, 'noConsumable');
    } else {
      const choice = skillChoice(ctx, a, q.skill, q.target, 'manual');
      if (choice !== null) return choice;
      reject(ctx, a.id, q.kind, (a.cooldowns[q.skill] ?? 0) > ctx.tick ? 'onCooldown' : 'invalidTarget');
    }
  }
  if (a.side === 'enemy') return enemyChoice(ctx, a);
  return a.auto ? automationChoice(ctx, a) : null;
}

/** Resolves a skill: effects in order, each on its recipients; then consumes `actions`/`attacks` charges. */
function resolveSkill(ctx: Ctx, a: ActorState, skill: Skill, targetIds: readonly string[]): void {
  const mark = ctx.state.nextUid;
  const targets = targetIds.map((id) => ctx.byId.get(id)).filter((t): t is ActorState => t !== undefined && t.alive);
  for (const effect of skill.effects) {
    const recipients = effect.to === 'self' ? [a] : targets;
    for (const r of recipients) applyEffect(ctx, a, r, effect, skill.id, 'skill');
  }
  a.actionsTaken += 1;
  const isAttack =
    (skill.targeting === 'enemy' || skill.targeting === 'allEnemies') &&
    skill.effects.some((e) => (e.type === 'damage' || e.type === 'dot') && e.to === 'target');
  afterAction(ctx, a, mark, isAttack ? targets : null);
}

function resolveConsumable(ctx: Ctx, a: ActorState, itemId: string): void {
  const mark = ctx.state.nextUid;
  const item = ctx.state.content.items[itemId] as ConsumableItem;
  const stack = a.consumables.find((c) => c.item === itemId);
  if (stack !== undefined) stack.qty -= 1;
  emit(ctx, { type: 'ConsumableUsed', actorId: a.id, item: itemId, remaining: stack?.qty ?? 0 });
  for (const effect of item.use) applyEffect(ctx, a, a, effect, itemId, 'item');
  a.actionsTaken += 1;
  afterAction(ctx, a, mark, null);
}

function afterAction(ctx: Ctx, a: ActorState, mark: number, attacked: readonly ActorState[] | null): void {
  if (a.alive) {
    for (const e of heldBefore(ctx, a.id, mark, (x) => x.unit === 'actions' && x.type !== 'stun')) consumeCharge(ctx, e);
  }
  if (attacked === null) return;
  if (a.alive) {
    for (const e of heldBefore(ctx, a.id, mark, (x) => x.unit === 'attacks' && x.type !== 'stun' && isHarmful(x))) {
      consumeCharge(ctx, e);
    }
  }
  for (const t of attacked) {
    if (!t.alive) continue;
    for (const e of heldBefore(ctx, t.id, mark, (x) => x.unit === 'attacks' && !isHarmful(x))) consumeCharge(ctx, e);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

function reject(ctx: Ctx, actorId: string, kind: string, reason: InputRejectReason): void {
  emit(ctx, { type: 'InputRejected', actorId, kind, reason });
}

/** Validates an untrusted input; queues/toggles or emits `InputRejected`. Never throws. */
function applyInput(ctx: Ctx, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return reject(ctx, '', '', 'malformed');
  const input = raw as Record<string, unknown>;
  const actorId = typeof input['actorId'] === 'string' ? input['actorId'] : '';
  const kind = typeof input['kind'] === 'string' ? input['kind'] : '';
  if (actorId === '' || kind === '') return reject(ctx, actorId, kind, 'malformed');
  const a = ctx.byId.get(actorId);
  if (a === undefined) return reject(ctx, actorId, kind, 'unknownActor');
  if (a.side !== 'hero') return reject(ctx, actorId, kind, 'notControllable');
  if (!a.alive) return reject(ctx, actorId, kind, 'actorDead');

  switch (kind) {
    case 'setAuto': {
      if (typeof input['auto'] !== 'boolean') return reject(ctx, actorId, kind, 'malformed');
      a.auto = input['auto'];
      emit(ctx, { type: 'AutoToggled', actorId, auto: a.auto });
      return;
    }
    case 'useSkill': {
      const skill = input['skill'];
      const target = input['target'];
      if (typeof skill !== 'string') return reject(ctx, actorId, kind, 'malformed');
      if (!a.skills.includes(skill)) return reject(ctx, actorId, kind, 'skillNotEquipped');
      if (target !== undefined && (typeof target !== 'string' || (!isSelector(target) && !ctx.byId.has(target)))) {
        return reject(ctx, actorId, kind, 'invalidTarget');
      }
      // Last input wins: a newer manual action replaces a queued one.
      a.queued = { kind: 'useSkill', skill, target: target ?? null };
      return;
    }
    case 'useConsumable': {
      const item = input['item'];
      if (typeof item !== 'string') return reject(ctx, actorId, kind, 'malformed');
      if (consumableQty(a, item) <= 0 || ctx.state.content.items[item] === undefined) {
        return reject(ctx, actorId, kind, 'noConsumable');
      }
      a.queued = { kind: 'useConsumable', item };
      return;
    }
    default:
      return reject(ctx, actorId, kind, 'unknownKind');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// runToEnd
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Supplies the inputs of the next tick from the current state (idle automation hooks, scripted manual play, balance
 * tools). It receives the engine's working state and must not mutate it.
 */
export type CombatPolicy = (state: Readonly<CombatState>) => readonly CombatInput[];

export const NO_INPUTS: CombatPolicy = () => [];

export interface RunResult {
  /** `timeout` when `maxTicks` elapsed without an outcome. */
  readonly outcome: CombatOutcome | 'timeout';
  readonly events: CombatEvent[];
  /** Ticks simulated. */
  readonly ticks: number;
  /** Final state (HP, consumables left, … for expeditions). */
  readonly state: CombatState;
}

/** Runs a combat to its end (or `maxTicks`) with inputs from `policy`. Same code path as `step`. */
export function runToEnd(
  setup: CombatSetup,
  seed: Seed,
  policy: CombatPolicy = NO_INPUTS,
  maxTicks: number = DEFAULT_MAX_TICKS,
): RunResult {
  const state = createCombat(setup, seed);
  const rng = RngStreams.fromState(state.rng);
  const events: CombatEvent[] = [];
  while (state.outcome === null && state.tick < maxTicks) {
    for (const e of stepInPlace(state, policy(state), rng)) events.push(e);
  }
  return { outcome: state.outcome ?? 'timeout', events, ticks: state.tick, state };
}
