import { evaluateCompletion } from '@engine/world';
import { getHoldings } from '@engine/server-kit';
import type { ActorTransaction, Clock } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';

import { readRpgEvalContext } from '../expeditions/progress.ts';
import { rpgActorObjectives, rpgCompletedAreas, rpgRegionConqueredEvents } from '../expeditions/schema.ts';
import { characters } from '../characters/schema.ts';
import type { RpgCompletionSnapshot } from './types.ts';

/**
 * Records live boss credit and evaluates personal conquest in the same fenced checkpoint transaction. Completion uses
 * the engine's generic rule evaluator and the content snapshot pinned to the live instance that produced the effect.
 */
export async function applyConquestProgress(tx: ActorTransaction, clock: Clock, actorId: string, areaId: string,
  snapshot: RpgCompletionSnapshot | undefined, defeatedEnemyIds: readonly string[] = []): Promise<void> {
  for (const enemyId of new Set(defeatedEnemyIds)) {
    await tx.insert(rpgActorObjectives).values({ actorId, objectiveKey: `defeated:${enemyId}`, recordedAt: new Date(clock.nowMs()) }).onConflictDoNothing();
  }
  if (!snapshot || snapshot.area.id !== areaId || snapshot.area.completion === undefined) return;

  const [[character], holdings] = await Promise.all([
    tx.select({ level: characters.level }).from(characters).where(eq(characters.actorId, actorId)),
    getHoldings(tx, actorId),
  ]);
  if (!character) throw new Error(`missing RPG character for conquest actor ${actorId}`);
  const context = await readRpgEvalContext(tx, actorId, character.level, holdings);
  const status = evaluateCompletion(snapshot.area, snapshot.locations, context, createRpgPredicateRegistry());
  if (!status.completed || status.recorded) return;

  const conqueredAt = new Date(clock.nowMs());
  const [completion] = await tx.insert(rpgCompletedAreas).values({ actorId, areaId, completedAt: conqueredAt })
    .onConflictDoNothing().returning({ actorId: rpgCompletedAreas.actorId });
  if (!completion) return;
  await tx.insert(rpgRegionConqueredEvents).values({ actorId, areaId, occurredAt: conqueredAt }).onConflictDoNothing();
}
