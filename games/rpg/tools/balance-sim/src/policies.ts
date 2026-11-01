/**
 * Scripted "attentive live" player (a `CombatPolicy` for `runToEnd`). Automation stays on; the script only queues the
 * manual inputs an attentive player adds on top of their rules:
 *
 * - **Pre-empting telegraphs.** It predicts each enemy's next action from public state (boss rotation position, AI
 *   priority list, cooldowns) and queues `guard` at the hero's *last* ready tick strictly before the telegraphed hit
 *   resolves (design §3.3: "queue guard right after the second basic"). Inputs resolve at the hero's next ready tick
 *   (A8 / Q-B5), so the script never reacts faster than the engine allows. Enemies act before heroes on equal
 *   initiative (actor-ID order), hence "strictly before".
 * - **Cleansing.** If a damage-over-time effect sits on the hero and the cleanse skill is ready, it queues the cleanse.
 *
 * Simplifications (documented in the README): one hero; an enemy's AI is predicted with the conditions the Region 1
 * enemies use (`skillReady`, `selfHpBelowBp`, `enemiesAtLeast`, `allyHpBelowBp`); with several enemies another
 * enemy's ordinary hit may still consume the guard first.
 */
import type { AiCondition } from '@rpg/rpg-schema';
import type { ActorState, CombatInput, CombatPolicy, CombatState } from '@rpg/rpg-sim';

export interface AttentivePolicyOptions {
  readonly heroId: string;
  /** Skill queued to absorb a telegraphed hit (only if equipped). */
  readonly guard?: string | undefined;
  /** Skill queued while a DoT is on the hero (only if equipped). */
  readonly cleanse?: string | undefined;
}

function readyAt(a: ActorState, skill: string, tick: number): boolean {
  return a.skills.includes(skill) && (a.cooldowns[skill] ?? 0) <= tick;
}

function aiHolds(state: CombatState, e: ActorState, when: AiCondition, tick: number): boolean {
  if (when.selfHpBelowBp !== undefined && !(e.hp * 10_000 < when.selfHpBelowBp * e.stats.maxHp)) return false;
  if (when.skillReady !== undefined && !readyAt(e, when.skillReady, tick)) return false;
  const foes = state.actors.filter((x) => x.alive && x.side !== e.side);
  if (when.enemiesAtLeast !== undefined && foes.length < when.enemiesAtLeast) return false;
  if (when.allyHpBelowBp !== undefined) {
    const limit = when.allyHpBelowBp;
    if (!state.actors.some((x) => x.alive && x.side === e.side && x.hp * 10_000 < limit * x.stats.maxHp)) return false;
  }
  return true;
}

/** Predicted next skill of an idle (not winding up) enemy at its next ready tick. */
function predictNextSkill(state: CombatState, e: ActorState, tick: number): string | null {
  if (e.boss !== null) {
    const phase = e.boss.phases[e.boss.phaseIndex];
    const skill = phase?.rotation[e.boss.rotationIndex % phase.rotation.length];
    if (skill !== undefined && readyAt(e, skill, tick)) return skill;
  }
  for (const rule of e.ai) {
    if (aiHolds(state, e, rule.when, tick) && readyAt(e, rule.do.useSkill, tick)) return rule.do.useSkill;
  }
  return null;
}

/** Earliest tick at which a telegraphed enemy action (current or predicted next) resolves, or `null`. */
export function nextTelegraphResolveTick(state: CombatState, t: number): number | null {
  let best: number | null = null;
  for (const e of state.actors) {
    if (!e.alive || e.side !== 'enemy') continue;
    let resolve: number | null = null;
    if (e.windup !== null) {
      resolve = e.windup.resolveAtTick;
    } else {
      const at = Math.max(e.nextActionTick, t);
      const skill = predictNextSkill(state, e, at);
      const windup = skill === null ? 0 : (state.content.skills[skill]?.windupTicks ?? 0);
      if (windup > 0) resolve = at + windup;
    }
    if (resolve !== null && (best === null || resolve < best)) best = resolve;
  }
  return best;
}

export function attentiveLivePolicy(opts: AttentivePolicyOptions): CombatPolicy {
  return (state) => {
    const hero = state.actors.find((a) => a.id === opts.heroId);
    if (hero === undefined || !hero.alive) return [];
    const t = state.tick + 1;
    const heroAt = Math.max(hero.nextActionTick, t);
    const interval = hero.stats.actionIntervalTicks;
    const inputs: CombatInput[] = [];
    const queue = (skill: string): void => {
      if (hero.queued?.kind === 'useSkill' && hero.queued.skill === skill) return;
      inputs.push({ actorId: hero.id, kind: 'useSkill', skill });
    };

    const guard = opts.guard;
    if (guard !== undefined && readyAt(hero, guard, heroAt)) {
      const guarded = state.effects.some((e) => e.holderId === hero.id && e.origin === guard);
      const resolve = nextTelegraphResolveTick(state, t);
      if (!guarded && resolve !== null && heroAt < resolve && heroAt + interval >= resolve) {
        queue(guard);
        return inputs;
      }
    }

    const cleanse = opts.cleanse;
    if (cleanse !== undefined && readyAt(hero, cleanse, heroAt)) {
      const dotted = state.effects.some((e) => e.holderId === hero.id && e.type === 'dot');
      if (dotted) queue(cleanse);
    }
    return inputs;
  };
}
