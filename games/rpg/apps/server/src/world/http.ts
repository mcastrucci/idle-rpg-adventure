import { actors, checkOrigin, getHoldings, requireAccount } from '@engine/server-kit';
import type { ServerModule } from '@engine/server-kit';
import { validateWorld } from '@engine/world';
import type { Requirement } from '@engine/world';
import { createRpgPredicateRegistry, RpgAreaSchema } from '@rpg/rpg-schema';
import { parseWorldViewDto } from '@rpg/protocol';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { createExpeditionService } from '../expeditions/service.ts';
import { readRpgEvalContext } from '../expeditions/progress.ts';
import { characters } from '../characters/schema.ts';
import { publicCommandError } from '../character-commands.ts';
import { computeRpgWorldView, getRpgLiveStartAreas } from './access.ts';

const ActorParams = z.strictObject({ actorId: z.uuid().transform(id => id.toLowerCase()) });
const GENERIC_BOSS_LABEL = 'Mandatory boss';

/** Owner-scoped, read-only world map. Requirements and hidden content are evaluated on the server and never serialized. */
export const worldModule: ServerModule = {
  name: 'world', roles: ['api'],
  async register(app, context) {
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      checkOrigin(request, context.allowedOrigins);
    });
    app.get('/characters/:actorId/world', async (request, reply) => {
      try {
        const { accountId } = await requireAccount(request, context);
        const { actorId } = ActorParams.parse(request.params);
        const dto = await context.database.db.transaction(async tx => {
          const [owner] = await tx.select({ activityState: actors.activityState }).from(actors)
            .where(and(eq(actors.actorId, actorId), eq(actors.accountId, accountId), eq(actors.gameId, 'rpg')));
          if (!owner) return null;
          const [character] = await tx.select({ level: characters.level }).from(characters)
            .where(and(eq(characters.actorId, actorId), eq(characters.accountId, accountId)));
          if (!character) return null;
          const holdings = await getHoldings(tx, actorId);
          const evalContext = await readRpgEvalContext(tx, actorId, character.level, holdings);
          const parsed = validateWorld(context.content.world, createRpgPredicateRegistry());
          if (!parsed.ok) throw new Error('RPG content world failed runtime validation');
          const world = parsed.world;
          const rpgAreas = new Map((context.content.world as { areas: readonly unknown[] }).areas.map(raw => {
            const area = RpgAreaSchema.parse(raw);
            return [area.id, area] as const;
          }));
          const engineView = computeRpgWorldView(context.content, evalContext);
          const liveStartIds = new Set(getRpgLiveStartAreas(context.content).map(area => area.id));
          const visibleAreas = engineView.areas.filter(area => area.kind !== 'hub' && area.visibility !== 'hidden');
          const knownAreaIds = new Set([...visibleAreas.map(area => area.id), ...world.areas.filter(area => area.kind === 'hub').map(area => area.id)]);
          const hub = world.areas.find(area => area.kind === 'hub');
          if (!hub) throw new Error('RPG world has no hub');
          const rpgHub = rpgAreas.get(hub.id);
          if (!rpgHub) throw new Error('RPG hub failed runtime validation');

          // The existing idle-options service owns activity/completion validation. This projection copies only
          // available public activity IDs; it does not reproduce the start gate or return its economy data.
          const idleOptions = await createExpeditionService(tx, context.clock, context.content).options(accountId, actorId);
          const idleByArea = new Map(idleOptions.areas.map(area => [area.areaId, area.activities.filter(activity => activity.available).map(activity => activity.activityId)]));
          const free = owner.activityState === 'none';
          const dto = {
            hub: { id: hub.id, label: publicLabel(rpgHub), position: boundedPosition(rpgHub.mapPosition) },
            areas: visibleAreas.map(view => {
              const authored = rpgAreas.get(view.id);
              if (!authored) throw new Error(`world view references unknown area ${view.id}`);
              const mandatoryBosses = mandatoryBossStatus(authored.completion?.required, evalContext.game.defeatedEnemies,
                context.content.collections['enemies'] ?? []);
              const activities = view.visibility === 'known' ? idleByArea.get(view.id) ?? [] : [];
              const idleUnlocked = activities.length > 0;
              const completion = view.completion.hasRule ? {
                discovered: view.completion.discoveredInPool,
                required: view.completion.requiredCount,
                completed: view.completion.completed,
                mandatoryBosses: { required: mandatoryBosses.length,
                  defeated: mandatoryBosses.filter(boss => boss.defeated).length,
                  complete: mandatoryBosses.every(boss => boss.defeated), bosses: mandatoryBosses },
              } : null;
              const reasons = view.visibility === 'locked' ? [...new Set(view.reasons.map(publicReason))] : [];
              return {
                id: view.id, label: publicLabel(authored), visibility: view.visibility,
                position: boundedPosition(authored.mapPosition), lockedReasons: reasons,
                completion,
                danger: authored.recommendedLevel
                  ? { status: 'known' as const, minLevel: authored.recommendedLevel[0], maxLevel: authored.recommendedLevel[1] }
                  : { status: 'unknown' as const },
                idle: { unlocked: idleUnlocked, activities },
                actions: { enterLive: free && view.visibility === 'known' && liveStartIds.has(view.id),
                  startIdle: free && view.visibility === 'known' && idleUnlocked },
              };
            }),
            routes: engineView.routes.filter(route => route.visible && knownAreaIds.has(route.from) && knownAreaIds.has(route.to))
              .map(({ id, from, to }) => ({ id, from, to })),
          };
          return parseWorldViewDto(dto);
        }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
        if (dto === null) return reply.code(404).send({ error: 'not_found' });
        return dto;
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' });
        const known = publicCommandError(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });
  },
};

function publicLabel(entity: { readonly id: string; readonly nameKey?: string | undefined }): string {
  return entity.nameKey ?? entity.id;
}

function boundedPosition(position: { readonly x: number; readonly y: number } | undefined): { x: number; y: number } | null {
  if (!position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y) ||
      Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) return null;
  return { x: position.x, y: position.y };
}

/** Convert engine failure keys to parameter-free reason categories; never leak requirement operands or hidden IDs. */
function publicReason(reason: string): string {
  if (reason === 'world.noRouteFromReachableArea') return reason;
  if (reason.startsWith('requires.areaCompleted:')) return 'requires.areaCompleted';
  if (reason.startsWith('requires.discovered:')) return 'requires.discovered';
  if (reason.startsWith('requires.flag:')) return 'requires.flag';
  if (reason.startsWith('requires.hasItem:')) return 'requires.hasItem';
  if (reason.startsWith('requires.game.levelAtLeast')) return 'requires.game.levelAtLeast';
  if (reason.startsWith('requires.game.defeated:')) return 'requires.game.defeated';
  if (reason.startsWith('requires.not:')) return 'requires.not';
  if (reason.startsWith('requires.')) return 'requires.other';
  return 'requires.other';
}

interface EnemyLabel { readonly id?: unknown; readonly nameKey?: unknown }
function mandatoryBossStatus(required: Requirement | undefined, defeatedEnemies: ReadonlySet<string>, enemies: readonly unknown[]) {
  if (required === undefined) return [] as { label: string; defeated: boolean }[];
  const ids = mandatoryDefeatedEnemyIds(required);
  const enemyLabels = new Map(enemies.flatMap(raw => {
    if (raw === null || typeof raw !== 'object') return [];
    const enemy = raw as EnemyLabel;
    return typeof enemy.id === 'string' ? [[enemy.id, typeof enemy.nameKey === 'string' ? enemy.nameKey : undefined] as const] : [];
  }));
  return ids.map(id => {
    const isDefeated = defeatedEnemies.has(id);
    return { label: isDefeated ? enemyLabels.get(id) ?? GENERIC_BOSS_LABEL : GENERIC_BOSS_LABEL, defeated: isDefeated };
  });
}

/** A defeated predicate is mandatory only if every satisfying branch requires it. Negated leaves are excluded. */
export function mandatoryDefeatedEnemyIds(requirement: Requirement): string[] {
  const node = requirement as unknown as Record<string, unknown>;
  if (node['game'] === 'defeated' && typeof node['enemy'] === 'string') return [node['enemy']];
  const all = node['all'];
  if (Array.isArray(all)) return [...new Set(all.flatMap(child => isRequirement(child) ? mandatoryDefeatedEnemyIds(child) : []))];
  const any = node['any'];
  if (Array.isArray(any)) {
    const branches = any.map(child => isRequirement(child) ? new Set(mandatoryDefeatedEnemyIds(child)) : new Set<string>());
    const first = branches[0];
    return first ? [...first].filter(id => branches.every(branch => branch.has(id))) : [];
  }
  return [];
}

function isRequirement(input: unknown): input is Requirement {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

