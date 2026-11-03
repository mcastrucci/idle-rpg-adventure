import { ActivityConflictError } from '@engine/live-kernel';
import { eq } from 'drizzle-orm';
import type { PreparedInstanceCreate } from '@engine/live-kernel';
import { checkOrigin, getHoldings, requireAccount, requireOwnedActor, runCommand } from '@engine/server-kit';
import type { ServerModule } from '@engine/server-kit';
import { ItemSchema } from '@rpg/rpg-schema';
import { parseLiveCurrent, parseLiveOptions, parseLiveStartRequest, parseLiveStartResponse } from '@rpg/protocol';
import { z } from 'zod';

import { publicCommandError } from '../character-commands.ts';
import { characters } from '../characters/schema.ts';
import { readRpgEvalContext } from '../expeditions/progress.ts';
import { rpgLiveEntries } from '../telemetry/schema.ts';
import { isRpgAreaAccessible, RpgAreaLockedError } from '../world/access.ts';
import type { RpgLiveHost } from './index.ts';
import { prepareRpgLiveStart } from './index.ts';

const ActorParamsSchema = z.strictObject({ actorId: z.uuid().transform((id) => id.toLowerCase()) });
const REGION_ONE = 'area:region_1';

/** Owner-scoped solo live entry routes. The client chooses only the authored region and carried supplies. */
export function createLiveEntryModule(live: RpgLiveHost): ServerModule {
  return {
    name: 'live-entry', roles: ['api'],
    async register(app, context) {
      app.addHook('onRequest', async (request, reply) => {
        reply.header('cache-control', 'no-store');
        checkOrigin(request);
      });
      app.get('/live/options/:actorId', async (request, reply) => {
        try {
          const { accountId } = await requireAccount(request, context);
          const { actorId } = ActorParamsSchema.parse(request.params);
          const [areas, supplies] = await context.database.db.transaction(async (tx) => {
            const actor = await requireOwnedActor(tx, actorId, accountId, 'rpg');
            if (actor.activityState !== 'none') throw new Error('live_actor_busy');
            const holdings = await getHoldings(tx, actorId);
            const [character] = await tx.select({ level: characters.level }).from(characters).where(eq(characters.actorId, actorId));
            if (!character) throw new Error('region_1_start_unavailable');
            const progress = await readRpgEvalContext(tx, actorId, character.level, holdings);
            const itemDefinitions = new Map((context.content.collections['items'] ?? []).map((raw) => {
              const item = ItemSchema.parse(raw); return [item.id, item] as const;
            }));
            const stock = new Map<string, number>();
            for (const holding of holdings) {
              if (holding.container === 'inventory' && holding.asset.kind === 'stack') {
                const itemId = holding.asset.item;
                if (itemDefinitions.get(itemId as `item:${string}`)?.kind === 'consumable') stock.set(itemId, (stock.get(itemId) ?? 0) + holding.qty);
              }
            }
            const world = context.content.world as { areas?: readonly { id: string; kind: string; startLocation?: string; nameKey?: string }[] };
            const region = world.areas?.find((area) => area.id === REGION_ONE && area.kind === 'explorable' && area.startLocation);
            if (!region?.startLocation) throw new Error('region_1_start_unavailable');
            const areas = isRpgAreaAccessible(context.content, progress, region.id)
              ? [{ id: region.id, label: region.nameKey ?? region.id, startLocationId: region.startLocation }]
              : [];
            return [areas,
              [...stock.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([item, availableQty]) => ({
                item, label: itemDefinitions.get(item as `item:${string}`)?.nameKey ?? item, availableQty,
              }))] as const;
          });
          return parseLiveOptions({ actorId, areas, supplies });
        } catch (error) { return sendEntryError(error, reply); }
      });

      app.post('/live/start', { bodyLimit: 16 * 1024 }, async (request, reply) => {
        let created: { readonly prepared: PreparedInstanceCreate; readonly lease: Awaited<ReturnType<RpgLiveHost['createInTransaction']>> } | undefined;
        try {
          const { accountId } = await requireAccount(request, context);
          const start = parseLiveStartRequest(request.body);
          // Reauthorize before the shared idempotency lookup, including on replay after the first run has ended.
          await context.database.db.transaction(async (tx) => { await requireOwnedActor(tx, start.actorId, accountId, 'rpg'); });
          if (start.areaId !== REGION_ONE) return reply.code(400).send({ error: 'unknown_live_region' });
          const response = await runCommand(context.database, context.clock, accountId,
            { commandId: start.commandId, operation: 'live.start', payload: { actorId: start.actorId, areaId: start.areaId, supplies: start.supplies } },
            async (tx) => {
              const prepared = await prepareRpgLiveStart(tx, live, accountId, { actorId: start.actorId, areaId: start.areaId, supplies: start.supplies });
              const lease = await live.createInTransaction(tx, prepared.input);
              await tx.insert(rpgLiveEntries).values({ instanceId: prepared.input.instanceId, actorId: start.actorId,
                areaId: start.areaId, startedAt: new Date(prepared.input.nowMs) });
              created = { prepared, lease };
              return { status: 200, body: { instanceId: lease.instanceId } };
            });
          if (created) live.host().adoptCreated(created.prepared, created.lease);
          else if (response.status === 200 && response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body)) {
            const instanceId = (response.body as Record<string, unknown>)['instanceId'];
            if (typeof instanceId === 'string' && !live.host().has(instanceId)) await live.host().recover(instanceId);
          }
          if (response.status < 200 || response.status >= 300) return reply.code(response.status).send(response.body);
          return reply.code(response.status).send(parseLiveStartResponse(response.body));
        } catch (error) { return sendEntryError(error, reply); }
      });

      app.get('/live/current/:actorId', async (request, reply) => {
        try {
          const { accountId } = await requireAccount(request, context);
          const { actorId } = ActorParamsSchema.parse(request.params);
          const actor = await context.database.db.transaction(async (tx) => {
            const owned = await requireOwnedActor(tx, actorId, accountId, 'rpg');
            return { state: owned.activityState, id: owned.activityId };
          });
          if (actor.state !== 'live' || actor.id === null) return parseLiveCurrent({ current: null });
          try {
            const current = live.host().currentView(actor.id, actorId, accountId);
            return parseLiveCurrent({ current: { instanceId: actor.id, actorId, view: current.view, participants: current.participants } });
          } catch { return reply.code(409).send({ error: 'instance_unavailable' }); }
        } catch (error) { return sendEntryError(error, reply); }
      });
    },
  };
}

function sendEntryError(error: unknown, reply: { code(status: number): { send(body: unknown): unknown } }): unknown {
  if (error instanceof RpgAreaLockedError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_command' });
  if (error instanceof RangeError) return reply.code(400).send({ error: 'invalid_live_start' });
  if (error instanceof ActivityConflictError) return reply.code(409).send({ error: 'activity_conflict' });
  if (error instanceof Error && error.message === 'live_actor_busy') return reply.code(409).send({ error: 'busy' });
  const known = publicCommandError(error);
  if (known) return reply.code(known.status).send(known.body);
  throw error;
}
