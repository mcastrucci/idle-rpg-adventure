/** Mutable working context of one `step` (ADR-0004: pure at the boundary, internal mutation of a working copy). */
import type { RngStreams } from '@engine/sim-core';

import type { ActorId, ActorState, CombatEvent, CombatState, EventPayload } from './types.ts';

export interface Ctx {
  readonly state: CombatState;
  readonly rng: RngStreams;
  readonly events: CombatEvent[];
  readonly tick: number;
  readonly byId: ReadonlyMap<ActorId, ActorState>;
}

export function createCtx(state: CombatState, rng: RngStreams, tick: number, events: CombatEvent[]): Ctx {
  return { state, rng, events, tick, byId: new Map(state.actors.map((a) => [a.id, a])) };
}

export function emit(ctx: Ctx, payload: EventPayload): void {
  // `seq` and `tick` first so serialized events have a stable, readable key order.
  ctx.events.push({ seq: ctx.state.eventSeq, tick: ctx.tick, ...payload } as CombatEvent);
  ctx.state.eventSeq += 1;
}

export function actor(ctx: Ctx, id: ActorId): ActorState {
  const a = ctx.byId.get(id);
  if (a === undefined) throw new Error(`unknown actor ${id}`);
  return a;
}

/** Living actors on `side`, in actor-ID order. */
export function living(ctx: Ctx, side: ActorState['side']): ActorState[] {
  return ctx.state.actors.filter((a) => a.alive && a.side === side);
}

export function opposing(side: ActorState['side']): ActorState['side'] {
  return side === 'hero' ? 'enemy' : 'hero';
}
