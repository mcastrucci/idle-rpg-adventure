import { asc, eq, sql } from 'drizzle-orm';
import type { LedgerDelta } from '@engine/economy';
import { actors, applyLedgerDeltas, getHoldings, requireSanctuaryMutation } from '@engine/server-kit';
import type { ActorTransaction, Clock, LoadedContent } from '@engine/server-kit';
import { validateWorld } from '@engine/world';
import { GOLD } from '@rpg/rpg-sim';
import { createRpgPredicateRegistry, ItemSchema } from '@rpg/rpg-schema';
import type { XpCurve } from '@rpg/rpg-schema';
import { totalXpFromLevelProgress } from '@rpg/rpg-stats';
import { z } from 'zod';

import { rpgXpCurve } from '../content.ts';
import { characters } from '../characters/schema.ts';
import { createCharacterService, RPG_GAME_ID } from '../characters/service.ts';
import { rpgActorObjectives, rpgAreaDiscoveries, rpgCompletedAreas } from '../expeditions/schema.ts';
import { recordAreaCompletion, recordDiscovery, recordObjective, resetRecordedProgress } from '../expeditions/progress.ts';

/** Ledger source type reserved for debug grants (data-model `source_type`). */
export const DEBUG_GRANT_SOURCE = 'debug_grant';
const contentId = z.string().min(1).max(160);
const actorId = z.uuid().transform(id => id.toLowerCase());

export const DebugGrantSchema = z.strictObject({
  actorId,
  gold: z.int().min(1).max(1_000_000_000).optional(),
  items: z.array(z.strictObject({ item: contentId, qty: z.int().min(1).max(10_000) })).min(1).max(20).optional(),
}).refine(value => value.gold !== undefined || value.items !== undefined, 'grant must not be empty');
export const DebugProgressionSchema = z.strictObject({ actorId, level: z.int().min(1).max(10_000), xp: z.int().min(0).max(2_147_483_647).default(0) });
export const DebugWorldProgressSchema = z.strictObject({
  actorId,
  completedAreas: z.array(contentId).max(50).optional(),
  discoveries: z.array(z.strictObject({ areaId: contentId, locationId: contentId })).max(200).optional(),
  objectives: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,159}$/)).max(50).optional(),
}).refine(value => value.completedAreas !== undefined || value.discoveries !== undefined || value.objectives !== undefined,
  'progress update must not be empty');
export const DebugWorldResetSchema = z.strictObject({ actorId, areaId: contentId.optional() });

/** Equipment definitions mint unique instances; this cap keeps one debug grant from flooding item_instances. */
const MAX_EQUIPMENT_PER_GRANT = 10;

export class DebugToolError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) { super(code); this.code = code; this.statusCode = statusCode; this.name = 'DebugToolError'; }
}

function xpCurve(content: LoadedContent): XpCurve {
  return rpgXpCurve(content.collections);
}

/**
 * Debug mutations run inside the shared command transaction (`runCommand`), after ownership was proven. Every
 * mutation locks the owned actor and requires Sanctuary (activity `none`), like other player-state edits.
 */
export function createDebugService(tx: ActorTransaction, clock: Clock, content: LoadedContent) {
  return {
    async grant(accountId: string, commandId: string, input: z.output<typeof DebugGrantSchema>) {
      await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const items = new Map((content.collections['items'] ?? []).map(value => { const item = ItemSchema.parse(value); return [item.id as string, item] as const; }));
      const deltas: LedgerDelta[] = [];
      if (input.gold !== undefined) deltas.push({ actorId: input.actorId, asset: GOLD, qty: input.gold });
      let equipment = 0;
      for (const { item, qty } of input.items ?? []) {
        const definition = items.get(item);
        if (!definition) throw new DebugToolError('unknown_item');
        if (definition.kind === 'equipment') {
          equipment += qty;
          if (equipment > MAX_EQUIPMENT_PER_GRANT) throw new DebugToolError('too_many_unique_items');
          deltas.push({ actorId: input.actorId, asset: { kind: 'unique_mint', item }, qty });
        } else {
          deltas.push({ actorId: input.actorId, asset: { kind: 'stack', item }, qty });
        }
      }
      // The ledger also deduplicates by source; the account-scoped command ID is the idempotency key.
      const source = { type: DEBUG_GRANT_SOURCE, id: `${accountId}:${commandId}` };
      const { applied } = await applyLedgerDeltas(tx, source, deltas);
      return { actorId: input.actorId, source, applied, granted: deltas.map(({ asset, qty }) => ({ asset, qty })),
        holdings: await getHoldings(tx, input.actorId) };
    },

    /** Sets stored `(level, xp within level)`. Attributes and unspent points are untouched (open decision #13). */
    async setProgression(accountId: string, input: z.output<typeof DebugProgressionSchema>) {
      await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const curve = xpCurve(content);
      try { totalXpFromLevelProgress(input.level, input.xp, curve); }
      catch { throw new DebugToolError('invalid_progression'); }
      await tx.update(characters).set({ level: input.level, xp: input.xp }).where(eq(characters.actorId, input.actorId));
      await tx.update(actors).set({ version: sql`${actors.version} + 1` }).where(eq(actors.actorId, input.actorId));
      return createCharacterService(tx, content).read(accountId, input.actorId);
    },

    /** Writes through the trusted progress seams; it does not evaluate conquest rules (#47). */
    async recordWorldProgress(accountId: string, input: z.output<typeof DebugWorldProgressSchema>) {
      await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const world = parseWorld(content);
      const areas = new Map(world.areas.map(area => [area.id as string, new Set<string>(area.locations)]));
      const enemies = new Set((content.collections['enemies'] ?? []).map(value => (value as { id: string }).id));
      for (const areaId of input.completedAreas ?? []) if (!areas.has(areaId)) throw new DebugToolError('unknown_area');
      for (const { areaId, locationId } of input.discoveries ?? []) {
        if (!areas.get(areaId)?.has(locationId)) throw new DebugToolError('unknown_location');
      }
      for (const key of input.objectives ?? []) {
        if (key.startsWith('defeated:') && !enemies.has(key.slice('defeated:'.length))) throw new DebugToolError('unknown_enemy');
      }
      for (const { areaId, locationId } of input.discoveries ?? []) await recordDiscovery(tx, clock, input.actorId, areaId, locationId);
      for (const areaId of input.completedAreas ?? []) await recordAreaCompletion(tx, clock, input.actorId, areaId);
      for (const key of input.objectives ?? []) await recordObjective(tx, clock, input.actorId, key);
      return readWorldProgress(tx, input.actorId);
    },

    async resetWorldProgress(accountId: string, input: z.output<typeof DebugWorldResetSchema>) {
      await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      if (input.areaId !== undefined && !parseWorld(content).areas.some(area => area.id === input.areaId)) throw new DebugToolError('unknown_area');
      await resetRecordedProgress(tx, input.actorId, input.areaId);
      return readWorldProgress(tx, input.actorId);
    },
  };
}

function parseWorld(content: LoadedContent) {
  const result = validateWorld(content.world, createRpgPredicateRegistry());
  if (!result.ok) throw new Error('RPG content world failed runtime validation');
  return result.world;
}

async function readWorldProgress(tx: ActorTransaction, actorId: string) {
  // Sequential: one transaction client must not run concurrent queries.
  const discoveries = await tx.select({ areaId: rpgAreaDiscoveries.areaId, locationId: rpgAreaDiscoveries.locationId }).from(rpgAreaDiscoveries)
    .where(eq(rpgAreaDiscoveries.actorId, actorId)).orderBy(asc(rpgAreaDiscoveries.areaId), asc(rpgAreaDiscoveries.locationId));
  const completed = await tx.select({ areaId: rpgCompletedAreas.areaId }).from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId)).orderBy(asc(rpgCompletedAreas.areaId));
  const objectives = await tx.select({ key: rpgActorObjectives.objectiveKey }).from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, actorId)).orderBy(asc(rpgActorObjectives.objectiveKey));
  return { actorId, completedAreas: completed.map(row => row.areaId), discoveries, objectives: objectives.map(row => row.key) };
}
