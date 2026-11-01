/**
 * Automation rules (combat-engine §6) and enemy AI (§7). One evaluator serves live auto mode, disconnected participants
 * and idle: conditions are read from the actor's perspective ("ally"/"enemy" relative to the actor), rules are tried
 * top-down and the first rule whose conditions hold **and** whose action is currently executable fires.
 *
 * Targeting:
 *   - `self` skills target the caster; `allAllies`/`allEnemies` hit every living actor of that side (actor-ID order).
 *   - `enemy` skills: a taunted actor must target its taunter; otherwise the selector (default `lowestHpEnemy`).
 *   - `ally` skills: selector `self` or `lowestHpAlly` (default `lowestHpAlly`).
 *   - "Lowest/highest HP" compares the HP share (bp of max HP), ties broken by actor ID ascending.
 *   - `telegraphingEnemy` picks the opponent whose windup resolves first (ties: actor ID); no match ⇒ rule skipped.
 *   - A selector that does not fit the skill's targeting makes the rule not match.
 */
import { TARGET_SELECTORS } from '@rpg/rpg-schema';
import type { AiCondition, RuleCondition, Skill, TargetSelector } from '@rpg/rpg-schema';

import { living, opposing } from './context.ts';
import { isCleansable } from './effects.ts';
import type { Ctx } from './context.ts';
import { hpBp } from './stats.ts';
import type { ActionSource, ActorState } from './types.ts';

export type Choice =
  | {
      readonly kind: 'skill';
      readonly skill: Skill;
      readonly targetIds: readonly string[];
      readonly selector: TargetSelector | null;
      readonly source: ActionSource;
    }
  | { readonly kind: 'consumable'; readonly item: string; readonly source: ActionSource };

export function isSelector(v: string): v is TargetSelector {
  return (TARGET_SELECTORS as readonly string[]).includes(v);
}

export function skillReady(ctx: Ctx, a: ActorState, skillId: string): boolean {
  return a.skills.includes(skillId) && (a.cooldowns[skillId] ?? 0) <= ctx.tick;
}

export function consumableQty(a: ActorState, item: string): number {
  return a.consumables.find((c) => c.item === item)?.qty ?? 0;
}

function byHpShare(order: 1 | -1) {
  return (x: ActorState, y: ActorState): number => {
    const d = (hpBp(x) - hpBp(y)) * order;
    return d !== 0 ? d : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  };
}

function pick(list: ActorState[], cmp: (x: ActorState, y: ActorState) => number): ActorState | null {
  let best: ActorState | null = null;
  for (const a of list) if (best === null || cmp(a, best) < 0) best = a;
  return best;
}

function telegraphing(ctx: Ctx, a: ActorState): ActorState | null {
  return pick(
    living(ctx, opposing(a.side)).filter((e) => e.windup !== null),
    (x, y) => (x.windup?.resolveAtTick ?? 0) - (y.windup?.resolveAtTick ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
}

/** The living opponent `a` is forced to attack (taunt), if any. */
export function tauntTarget(ctx: Ctx, a: ActorState): ActorState | null {
  const taunt = ctx.state.effects.find((e) => e.holderId === a.id && e.type === 'taunt');
  if (taunt === undefined) return null;
  const src = ctx.byId.get(taunt.sourceId);
  return src !== undefined && src.alive ? src : null;
}

/**
 * Resolves targets for `skill`. `target` is an actor ID, a selector or `null` (default selector).
 * Returns `null` when no valid target exists.
 */
export function resolveTargets(ctx: Ctx, a: ActorState, skill: Skill, target: string | null): string[] | null {
  const allies = living(ctx, a.side);
  const enemies = living(ctx, opposing(a.side));
  switch (skill.targeting) {
    case 'self':
      return target === null || target === 'self' || target === a.id ? [a.id] : null;
    case 'allAllies':
      return allies.map((x) => x.id);
    case 'allEnemies':
      return enemies.length > 0 ? enemies.map((x) => x.id) : null;
    case 'enemy': {
      const forced = tauntTarget(ctx, a);
      if (forced !== null) return [forced.id];
      const sel = target ?? 'lowestHpEnemy';
      let t: ActorState | null;
      if (sel === 'lowestHpEnemy') t = pick(enemies, byHpShare(1));
      else if (sel === 'highestHpEnemy') t = pick(enemies, byHpShare(-1));
      else if (sel === 'telegraphingEnemy') t = telegraphing(ctx, a);
      else if (isSelector(sel)) t = null;
      else t = enemies.find((x) => x.id === sel) ?? null;
      return t === null ? null : [t.id];
    }
    case 'ally': {
      const sel = target ?? 'lowestHpAlly';
      let t: ActorState | null;
      if (sel === 'self') t = a;
      else if (sel === 'lowestHpAlly') t = pick(allies, byHpShare(1));
      else if (isSelector(sel)) t = null;
      else t = allies.find((x) => x.id === sel) ?? null;
      return t === null ? null : [t.id];
    }
  }
}

/** Conditions are ANDed; an empty condition always holds. */
export function conditionHolds(ctx: Ctx, a: ActorState, when: RuleCondition | AiCondition): boolean {
  if (when.selfHpBelowBp !== undefined && !(hpBp(a) < when.selfHpBelowBp)) return false;
  if (when.allyHpBelowBp !== undefined) {
    const limit = when.allyHpBelowBp;
    if (!living(ctx, a.side).some((x) => hpBp(x) < limit)) return false;
  }
  if (when.selfHasHarmfulEffect === true && !ctx.state.effects.some((e) => e.holderId === a.id && isCleansable(e))) {
    return false;
  }
  if ('enemyTelegraphing' in when && when.enemyTelegraphing === true && telegraphing(ctx, a) === null) return false;
  if (when.skillReady !== undefined && !skillReady(ctx, a, when.skillReady)) return false;
  if (when.enemiesAtLeast !== undefined && living(ctx, opposing(a.side)).length < when.enemiesAtLeast) return false;
  if ('hasConsumable' in when && when.hasConsumable !== undefined && consumableQty(a, when.hasConsumable) <= 0) return false;
  return true;
}

/** A skill choice if `skillId` is equipped, ready and has a target. */
export function skillChoice(
  ctx: Ctx,
  a: ActorState,
  skillId: string,
  target: string | null,
  source: ActionSource,
): Choice | null {
  const skill = ctx.state.content.skills[skillId];
  if (skill === undefined || !skillReady(ctx, a, skillId)) return null;
  const targetIds = resolveTargets(ctx, a, skill, target);
  if (targetIds === null) return null;
  return { kind: 'skill', skill, targetIds, selector: target !== null && isSelector(target) ? target : null, source };
}

/** Hero automation: first matching executable rule, or `null` (the actor waits and is re-evaluated next tick). */
export function automationChoice(ctx: Ctx, a: ActorState): Choice | null {
  for (const rule of a.rules) {
    if (!conditionHolds(ctx, a, rule.when)) continue;
    const action = rule.do;
    if ('useConsumable' in action) {
      if (consumableQty(a, action.useConsumable) > 0 && ctx.state.content.items[action.useConsumable] !== undefined) {
        return { kind: 'consumable', item: action.useConsumable, source: 'auto' };
      }
      continue;
    }
    const choice = skillChoice(ctx, a, action.useSkill, action.target ?? null, 'auto');
    if (choice !== null) return choice;
  }
  return null;
}

/**
 * Enemy AI: bosses first try the current phase's rotation skill (advancing the rotation when it fires); if it is not
 * ready or has no target, the AI priority list applies (same evaluator as automation rules).
 */
export function enemyChoice(ctx: Ctx, a: ActorState): Choice | null {
  const boss = a.boss;
  if (boss !== null) {
    const phase = boss.phases[boss.phaseIndex];
    const skillId = phase?.rotation[boss.rotationIndex % phase.rotation.length];
    if (phase !== undefined && skillId !== undefined) {
      const choice = skillChoice(ctx, a, skillId, null, 'ai');
      if (choice !== null) {
        boss.rotationIndex = (boss.rotationIndex + 1) % phase.rotation.length;
        return choice;
      }
    }
  }
  for (const rule of a.ai) {
    if (!conditionHolds(ctx, a, rule.when)) continue;
    const choice = skillChoice(ctx, a, rule.do.useSkill, rule.do.target ?? null, 'ai');
    if (choice !== null) return choice;
  }
  return null;
}
