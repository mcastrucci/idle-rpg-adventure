import { and, eq } from 'drizzle-orm';
import { createActorWorldState } from '@engine/world';
import type { EvalContext } from '@engine/world';
import type { AssetRef } from '@engine/economy';
import type { RpgGameContext } from '@rpg/rpg-schema';
import type { ActorTransaction, Clock } from '@engine/server-kit';

import { rpgActorObjectives, rpgAreaDiscoveries, rpgCompletedAreas } from './schema.ts';

/** World state read from server-recorded exploration/conquest; request payloads never populate it. */
export async function readRpgEvalContext(tx: ActorTransaction, actorId: string, level: number,
  holdings: readonly { asset: AssetRef; container: string; qty: number }[] = []): Promise<EvalContext<RpgGameContext>> {
  const [discoveries, completed, objectives] = await Promise.all([
    tx.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, actorId)),
    tx.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId)),
    tx.select().from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, actorId)),
  ]);
  const discovered: Record<`area:${string}`, (`loc:${string}`)[]> = {};
  for (const item of discoveries) (discovered[item.areaId as `area:${string}`] ??= []).push(item.locationId as `loc:${string}`);
  const objectiveKeys = objectives.map(row => row.objectiveKey);
  const defeatedEnemies = objectiveKeys.flatMap(key => key.startsWith('defeated:') ? [key.slice('defeated:'.length)] : []);
  const items: Record<string, number> = {};
  for (const holding of holdings) if (holding.container === 'inventory' && holding.asset.kind === 'stack') {
    items[holding.asset.item] = (items[holding.asset.item] ?? 0) + holding.qty;
  }
  return {
    actor: createActorWorldState({ discovered, completedAreas: completed.map(row => row.areaId as `area:${string}`), objectives: objectiveKeys, items }),
    game: { defeatedEnemies: new Set(defeatedEnemies), level },
  };
}

/** Trusted server-side write seams for conquest, discovery and story systems. No HTTP handler accepts these values. */
export async function recordDiscovery(tx: ActorTransaction, clock: Clock, actorId: string, areaId: string, locationId: string): Promise<void> {
  await tx.insert(rpgAreaDiscoveries).values({ actorId, areaId, locationId, discoveredAt: new Date(clock.nowMs()) }).onConflictDoNothing();
}
export async function recordObjective(tx: ActorTransaction, clock: Clock, actorId: string, objectiveKey: string): Promise<void> {
  await tx.insert(rpgActorObjectives).values({ actorId, objectiveKey, recordedAt: new Date(clock.nowMs()) }).onConflictDoNothing();
}
/** Trusted reset seam (debug tools). With `areaId`, removes that area's discoveries/completion; otherwise everything. */
export async function resetRecordedProgress(tx: ActorTransaction, actorId: string, areaId?: string): Promise<void> {
  if (areaId === undefined) {
    await tx.delete(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, actorId));
    await tx.delete(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId));
    await tx.delete(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, actorId));
    return;
  }
  await tx.delete(rpgAreaDiscoveries).where(and(eq(rpgAreaDiscoveries.actorId, actorId), eq(rpgAreaDiscoveries.areaId, areaId)));
  await tx.delete(rpgCompletedAreas).where(and(eq(rpgCompletedAreas.actorId, actorId), eq(rpgCompletedAreas.areaId, areaId)));
}
export async function recordAreaCompletion(tx: ActorTransaction, clock: Clock, actorId: string, areaId: string): Promise<void> {
  await tx.insert(rpgCompletedAreas).values({ actorId, areaId, completedAt: new Date(clock.nowMs()) }).onConflictDoNothing();
}
