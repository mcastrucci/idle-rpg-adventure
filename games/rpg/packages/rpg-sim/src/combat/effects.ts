/**
 * Effect resolution (docs/spec/combat-engine.md §4–§5): damage/heal formulas, durable effects with duration units,
 * stacking/refresh, shields, death and boss phase changes. Integer-only.
 *
 * Duration units (the "owner" of an effect is its holder, i.e. the actor carrying it):
 *   - `ticks`   — decremented at the end of every tick after the one it was applied in (an N-tick effect applied
 *                 during tick t is active for ticks t+1 … t+N and expires at the end of tick t+N).
 *   - `actions` — decremented after each action the holder resolves (skills and consumables). Stuns are decremented
 *                 by each action they make the holder skip.
 *   - `attacks` — decremented by each eligible attack: harmful effects (taunt, dot, negative stat_mod) count attacks the
 *                 holder **performs**; beneficial effects (shield, hot, positive stat_mod) count attacks the holder
 *                 **receives**; a stun counts the attacks/actions it makes the holder skip.
 *   An effect is never consumed by the action that applied it.
 *
 * Stacking (one rule per type; a "replace" expires the old instance with reason `replaced` and applies a new one):
 *   - taunt, stun: at most one per holder; a new one replaces the old regardless of source.
 *   - shield, dot, hot: one per (holder, source, origin); different sources/origins stack.
 *   - stat_mod: one per (holder, source, origin, stat); different ones stack additively (summed, order-independent).
 */
import { BP_SCALE, mulBp, mulDivFloor } from '@engine/sim-core';
import type { DamageSchool, Effect } from '@rpg/rpg-schema';

import { actor, emit } from './context.ts';
import type { Ctx } from './context.ts';
import { hpBp, recomputeStats } from './stats.ts';
import type { ActiveEffect, ActorState, EffectExpireReason } from './types.ts';

/** Skill effects scale with the caster's stats; consumable heals/shields scale with the user's max HP. */
export type Scaling = 'skill' | 'item';

type NewEffect = ActiveEffect extends infer E
  ? E extends ActiveEffect
    ? Omit<E, 'uid' | 'appliedTick' | 'remaining'>
    : never
  : never;

export function isHarmful(e: ActiveEffect): boolean {
  switch (e.type) {
    case 'dot':
    case 'stun':
    case 'taunt':
      return true;
    case 'stat_mod':
      return e.flat < 0 || e.deltaBp < 0;
    default:
      return false;
  }
}

export function applyEffect(
  ctx: Ctx,
  source: ActorState,
  recipient: ActorState,
  effect: Effect,
  origin: string,
  scaling: Scaling,
): void {
  if (!recipient.alive) return;
  const healBase = scaling === 'skill' ? source.stats.healPower : recipient.stats.maxHp;
  switch (effect.type) {
    case 'damage':
      dealDamage(ctx, source.id, recipient, mulBp(source.stats.powerBySchool[effect.school], effect.coeffBp), effect.school, origin, false);
      return;
    case 'heal':
      heal(ctx, source.id, recipient, mulBp(healBase, effect.coeffBp), origin, false);
      return;
    case 'shield':
      addDurable(ctx, { type: 'shield', holderId: recipient.id, sourceId: source.id, origin, unit: effect.duration.unit, amount: mulBp(healBase, effect.coeffBp) }, effect.duration.value);
      return;
    case 'dot':
      addDurable(
        ctx,
        {
          type: 'dot',
          holderId: recipient.id,
          sourceId: source.id,
          origin,
          unit: effect.duration.unit,
          perTick: mulBp(source.stats.powerBySchool[effect.school], effect.coeffBp),
          school: effect.school,
          periodTicks: effect.periodTicks,
          nextAt: ctx.tick + effect.periodTicks,
        },
        effect.duration.value,
      );
      return;
    case 'hot':
      addDurable(
        ctx,
        {
          type: 'hot',
          holderId: recipient.id,
          sourceId: source.id,
          origin,
          unit: effect.duration.unit,
          perTick: mulBp(healBase, effect.coeffBp),
          periodTicks: effect.periodTicks,
          nextAt: ctx.tick + effect.periodTicks,
        },
        effect.duration.value,
      );
      return;
    case 'stat_mod':
      addDurable(
        ctx,
        {
          type: 'stat_mod',
          holderId: recipient.id,
          sourceId: source.id,
          origin,
          unit: effect.duration.unit,
          stat: effect.stat,
          deltaBp: effect.deltaBp ?? 0,
          flat: effect.flat ?? 0,
        },
        effect.duration.value,
      );
      recomputeStats(ctx.state, recipient);
      return;
    case 'taunt':
      if (recipient.id === source.id || recipient.side === source.side) return; // only opponents can be taunted
      addDurable(ctx, { type: 'taunt', holderId: recipient.id, sourceId: source.id, origin, unit: effect.duration.unit }, effect.duration.value);
      return;
    case 'stun':
      addDurable(ctx, { type: 'stun', holderId: recipient.id, sourceId: source.id, origin, unit: effect.duration.unit }, effect.duration.value);
      if (recipient.windup !== null) {
        emit(ctx, { type: 'ActionInterrupted', actorId: recipient.id, skill: recipient.windup.skill, reason: 'stunned' });
        recipient.windup = null;
        recipient.nextActionTick = ctx.tick + recipient.stats.actionIntervalTicks;
      }
      return;
    case 'cleanse': {
      const removed = ctx.state.effects.filter((e) => e.holderId === recipient.id && e.type !== 'taunt' && isHarmful(e));
      for (const e of removed) expireEffect(ctx, e, 'cleansed');
      emit(ctx, { type: 'Cleansed', sourceId: source.id, targetId: recipient.id, removed: removed.length });
      return;
    }
  }
}

function sameSlot(a: ActiveEffect, b: NewEffect): boolean {
  if (a.holderId !== b.holderId || a.type !== b.type) return false;
  if (b.type === 'taunt' || b.type === 'stun') return true;
  if (a.sourceId !== b.sourceId || a.origin !== b.origin) return false;
  return b.type !== 'stat_mod' || (a.type === 'stat_mod' && a.stat === b.stat);
}

function addDurable(ctx: Ctx, effect: NewEffect, value: number): void {
  for (const old of ctx.state.effects.filter((e) => sameSlot(e, effect))) expireEffect(ctx, old, 'replaced');
  const uid = ctx.state.nextUid;
  ctx.state.nextUid += 1;
  ctx.state.effects.push({ ...effect, uid, appliedTick: ctx.tick, remaining: value } as ActiveEffect);
  emit(ctx, {
    type: 'EffectApplied',
    effectUid: uid,
    effect: effect.type,
    sourceId: effect.sourceId,
    targetId: effect.holderId,
    origin: effect.origin,
    duration: { value, unit: effect.unit },
  });
}

export function expireEffect(ctx: Ctx, e: ActiveEffect, reason: EffectExpireReason): void {
  ctx.state.effects = ctx.state.effects.filter((x) => x.uid !== e.uid);
  emit(ctx, { type: 'EffectExpired', effectUid: e.uid, effect: e.type, targetId: e.holderId, reason });
  if (e.type === 'stat_mod') {
    const holder = actor(ctx, e.holderId);
    if (holder.alive) recomputeStats(ctx.state, holder);
  }
}

/** Decrements one charge of `e`; expires it at 0. */
export function consumeCharge(ctx: Ctx, e: ActiveEffect): void {
  e.remaining -= 1;
  if (e.remaining <= 0) expireEffect(ctx, e, 'duration');
}

/** Effects held by `holderId` applied before `mark` (uid) that satisfy `pred`, as a snapshot. */
export function heldBefore(ctx: Ctx, holderId: string, mark: number, pred: (e: ActiveEffect) => boolean): ActiveEffect[] {
  return ctx.state.effects.filter((e) => e.holderId === holderId && e.uid < mark && pred(e));
}

export function dealDamage(
  ctx: Ctx,
  sourceId: string,
  target: ActorState,
  raw: number,
  school: DamageSchool,
  origin: string,
  periodic: boolean,
): void {
  if (!target.alive) return;
  const { tuning } = ctx.state;
  const mitigation = school === 'physical' ? target.stats.armor : target.stats.resist;
  let amount = mulDivFloor(raw, BP_SCALE, BP_SCALE + mitigation * tuning.armorKBp);
  let crit = false;
  if (!periodic) {
    // Always one draw per direct hit, so the stream position does not depend on the odds.
    crit = ctx.rng.stream('combat').chanceBp(actor(ctx, sourceId).stats.critBp);
    if (crit) amount = mulBp(amount, tuning.critMultBp);
  }
  amount = Math.max(1, amount);

  // Shields absorb in application order; depleted ones expire right after the damage event.
  let absorbed = 0;
  const depleted: ActiveEffect[] = [];
  for (const shield of ctx.state.effects) {
    if (absorbed === amount) break;
    if (shield.holderId !== target.id || shield.type !== 'shield') continue;
    const take = Math.min(shield.amount, amount - absorbed);
    shield.amount -= take;
    absorbed += take;
    if (shield.amount === 0) depleted.push(shield);
  }
  const hpLoss = Math.min(target.hp, amount - absorbed);
  target.hp -= hpLoss;
  emit(ctx, {
    type: 'DamageDealt',
    sourceId,
    targetId: target.id,
    origin,
    school,
    amount: hpLoss,
    absorbed,
    crit,
    periodic,
    hpAfter: target.hp,
  });
  for (const shield of depleted) expireEffect(ctx, shield, 'depleted');
  if (target.hp === 0) die(ctx, target, sourceId);
  else if (target.boss !== null) checkPhase(ctx, target);
}

export function heal(ctx: Ctx, sourceId: string, target: ActorState, amount: number, origin: string, periodic: boolean): void {
  if (!target.alive) return;
  const gained = Math.min(amount, target.stats.maxHp - target.hp);
  target.hp += gained;
  emit(ctx, { type: 'Healed', sourceId, targetId: target.id, origin, amount: gained, periodic, hpAfter: target.hp });
}

/** Death: interrupts a windup, drops the actor's effects (silently) and expires taunts it was the source of. */
export function die(ctx: Ctx, a: ActorState, killerId: string): void {
  a.alive = false;
  a.hp = 0;
  a.queued = null;
  if (a.windup !== null) {
    emit(ctx, { type: 'ActionInterrupted', actorId: a.id, skill: a.windup.skill, reason: 'died' });
    a.windup = null;
  }
  emit(ctx, { type: 'ActorDied', actorId: a.id, killerId });
  ctx.state.effects = ctx.state.effects.filter((e) => e.holderId !== a.id);
  for (const e of ctx.state.effects.filter((x) => x.type === 'taunt' && x.sourceId === a.id)) {
    expireEffect(ctx, e, 'sourceDied');
  }
}

/** Boss phases only advance: the deepest phase whose `fromHpBp` is ≥ the current HP share. */
export function checkPhase(ctx: Ctx, a: ActorState): void {
  const boss = a.boss;
  if (boss === null) return;
  const share = hpBp(a);
  let next = boss.phaseIndex;
  for (let i = boss.phaseIndex + 1; i < boss.phases.length; i++) {
    const phase = boss.phases[i];
    if (phase !== undefined && share <= phase.fromHpBp) next = i;
  }
  if (next === boss.phaseIndex) return;
  boss.phaseIndex = next;
  boss.rotationIndex = 0;
  emit(ctx, { type: 'PhaseChanged', actorId: a.id, phase: next, fromHpBp: boss.phases[next]?.fromHpBp ?? 0 });
}
