import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../database.ts';
import { actors } from './schema.ts';
import type { Actor, ActorActivity } from './schema.ts';

/** Pass an existing transaction so activity transitions and future ledger mutations commit atomically. */
export type ActorTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
export class ActorError extends Error {
  readonly code: 'not_found' | 'busy' | 'activity_conflict';
  readonly statusCode: 404 | 409;
  constructor(code: 'not_found' | 'busy' | 'activity_conflict', statusCode: 404 | 409) {
    super(code); this.code = code; this.statusCode = statusCode; this.name = 'ActorError';
  }
}
function validActivity(activity: ActorActivity): void {
  if (activity.state === 'none' ? activity.activityId !== null : !activity.activityId) {
    throw new TypeError('activity state/id mismatch');
  }
}

/** Locks are acquired in immutable ascending actor UUID order, regardless of caller party order. */
export async function lockActors(tx: ActorTransaction, actorIds: readonly string[]): Promise<Actor[]> {
  const ids = [...new Set(actorIds.map(id => id.toLowerCase()))].sort();
  if (ids.length === 0) return [];
  const rows = await tx.select().from(actors).where(inArray(actors.actorId, ids)).orderBy(asc(actors.actorId)).for('update');
  if (rows.length !== ids.length) throw new ActorError('not_found', 404);
  return rows;
}
export async function requireOwnedActor(tx: ActorTransaction, actorId: string, accountId: string, gameId?: string): Promise<Actor> {
  const [actor] = await lockActors(tx, [actorId]);
  if (!actor || actor.accountId !== accountId || (gameId !== undefined && actor.gameId !== gameId)) {
    throw new ActorError('not_found', 404);
  }
  return actor;
}
/** Inventory/loadout/rule edits must keep this row lock until their surrounding transaction commits. */
export async function requireSanctuaryMutation(tx: ActorTransaction, actorId: string, accountId: string, gameId?: string): Promise<Actor> {
  const actor = await requireOwnedActor(tx, actorId, accountId, gameId);
  if (actor.activityState !== 'none') throw new ActorError('busy', 409);
  return actor;
}
/**
 * Exact CAS includes previous activity identity, so stale settlement of expedition A cannot release expedition B.
 * Only idle→active and active→idle edges exist; active activities cannot be replaced in-place.
 */
export async function transitionActivity(tx: ActorTransaction, actorId: string, expected: ActorActivity, next: ActorActivity): Promise<Actor | null> {
  validActivity(expected); validActivity(next);
  if ((expected.state === 'none') === (next.state === 'none')) throw new TypeError('activity transitions must enter or leave Sanctuary');
  const [updated] = await tx.update(actors).set({ activityState: next.state, activityId: next.activityId,
    version: sql`${actors.version} + 1` }).where(and(eq(actors.actorId, actorId), eq(actors.activityState, expected.state),
    expected.activityId === null ? isNull(actors.activityId) : eq(actors.activityId, expected.activityId))).returning();
  return updated ?? null;
}
/** Public-facing activity operations must prove ownership inside this same transaction first. */
export function createActorService(tx: ActorTransaction) {
  return {
    lockActors: (actorIds: readonly string[]) => lockActors(tx, actorIds),
    requireOwnedActor: (actorId: string, accountId: string, gameId?: string) => requireOwnedActor(tx, actorId, accountId, gameId),
    requireSanctuaryMutation: (actorId: string, accountId: string, gameId?: string) => requireSanctuaryMutation(tx, actorId, accountId, gameId),
    transitionActivity: (actorId: string, expected: ActorActivity, next: ActorActivity) => transitionActivity(tx, actorId, expected, next),
  };
}
