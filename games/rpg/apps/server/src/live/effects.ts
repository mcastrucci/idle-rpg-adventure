/**
 * Durable effects of the RPG live plugin (`LiveStep.effects`), applied by the PostgreSQL instance store inside the
 * fenced transaction of the checkpoint/close they belong to (`PostgresInstanceStoreHooks.onEffects`). A discovery is
 * therefore committed exactly when the checkpointed state that contains it is; a restore from an earlier checkpoint
 * may emit it again, which the `progress.ts` seams absorb (unique keys, `ON CONFLICT DO NOTHING`).
 */
import type { JsonValue } from '@engine/live-kernel';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { applyLedgerDeltas, getHoldings, ledgerBatches, lockActors } from '@engine/server-kit';
import type { ActorTransaction, PostgresInstanceStoreHooks } from '@engine/server-kit';
import type { LiveEffectsContext } from '@engine/server-kit';
import type { LedgerDelta } from '@engine/economy';
import { XpCurveSchema } from '@rpg/rpg-schema';
import { totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';

import { recordDiscovery } from '../expeditions/progress.ts';
import { applyConquestProgress } from '../conquest/service.ts';
import type { RpgCompletionSnapshot } from '../conquest/types.ts';
import { characters } from '../characters/schema.ts';

export type RpgLiveEffect =
  /** A participant present in the instance entered a location for the first time. */
  | { readonly type: 'discovery'; readonly actorId: string; readonly areaId: string; readonly locationId: string; readonly completion?: RpgCompletionSnapshot }
  /** A participant took part in a victorious boss fight. */
  | { readonly type: 'bossDefeated'; readonly actorId: string; readonly areaId: string; readonly enemyIds: readonly string[]; readonly completion?: RpgCompletionSnapshot }
  | { readonly type: 'lootGranted'; readonly actionId: string; readonly actorId: string; readonly items: readonly { readonly item: string; readonly qty: number; readonly kind: 'stack' | 'unique_mint' }[]; readonly gold: number }
  | { readonly type: 'consumableUsed'; readonly actionId: string; readonly actorId: string; readonly item: string; readonly qty: number }
  | { readonly type: 'xpGranted'; readonly actionId: string; readonly actorId: string; readonly xp: number; readonly xpToNext: readonly number[] };

function parseEffect(value: JsonValue): RpgLiveEffect {
  const effect = value as Partial<Record<string, unknown>> | null;
  const text = (key: string) => typeof effect?.[key] === 'string';
  if (effect?.['type'] === 'discovery' && text('actorId') && text('areaId') && text('locationId')) return effect as unknown as RpgLiveEffect;
  if (effect?.['type'] === 'bossDefeated' && text('actorId') && text('areaId') && Array.isArray(effect['enemyIds'])) {
    return effect as unknown as RpgLiveEffect;
  }
  if (effect?.['type'] === 'lootGranted' && text('actorId') && text('actionId') && Array.isArray(effect['items']) &&
      Number.isSafeInteger(effect['gold']) && (effect['gold'] as number) >= 0 && effect['items'].every((item) => item !== null &&
        typeof item === 'object' && typeof (item as Record<string, unknown>)['item'] === 'string' &&
        Number.isSafeInteger((item as Record<string, unknown>)['qty']) && ((item as Record<string, unknown>)['qty'] as number) > 0 &&
        ['stack', 'unique_mint'].includes(String((item as Record<string, unknown>)['kind'])))) {
    return effect as unknown as RpgLiveEffect;
  }
  if (effect?.['type'] === 'xpGranted' && text('actorId') && text('actionId') && Number.isSafeInteger(effect['xp']) &&
      (effect['xp'] as number) > 0 && Array.isArray(effect['xpToNext'])) return effect as unknown as RpgLiveEffect;
  if (effect?.['type'] === 'consumableUsed' && text('actorId') && text('actionId') && text('item') &&
      Number.isSafeInteger(effect['qty']) && (effect['qty'] as number) > 0) return effect as unknown as RpgLiveEffect;
  throw new Error('unknown RPG live effect');
}

/** `onEffects` hook: records progress and evaluates conquest only for the instance's currently present participants. */
export async function applyRpgLiveEffects(tx: ActorTransaction, instance: { readonly instanceId?: string; readonly participants: readonly { readonly actorId: string; readonly left?: boolean }[] },
  effects: readonly JsonValue[], nowMs: number, context: LiveEffectsContext = { type: 'checkpoint' }): Promise<void> {
  const clock = { nowMs: () => nowMs };
  const participants = new Set(instance.participants.filter((p) => !('left' in p) || p.left !== true).map((p) => p.actorId));
  const parsed = effects.map(parseEffect);
  const needsInstanceId = parsed.some((effect) => effect.type === 'lootGranted' || effect.type === 'xpGranted' || effect.type === 'consumableUsed');
  if (needsInstanceId && !instance.instanceId) throw new Error('live reward effect is missing its instance id');
  for (const effect of parsed) {
    const releasedDiscovery = context.type === 'release' && context.actorId === effect.actorId && effect.type === 'discovery';
    if (!participants.has(effect.actorId) && !releasedDiscovery) throw new Error('live effect for a non-participant');
  }
  // Multiple checkpoints may contend over an actor's final discovery and boss requirement. Acquire all actor locks in
  // the engine's global order before writing/evaluating, so the second evaluator observes the first commit.
  const locked = await lockActors(tx, parsed.map(effect => effect.actorId));
  const actorsById = new Map(locked.map((actor) => [actor.actorId, actor]));
  const activity = new Map(locked.map((actor) => [actor.actorId, actor.activityState === 'live' && actor.activityId === instance.instanceId ?
    { state: 'live' as const, id: instance.instanceId as string } : undefined]));
  for (const effect of parsed) {
    if (effect.type === 'lootGranted' || effect.type === 'xpGranted' || effect.type === 'consumableUsed') {
      const actor = actorsById.get(effect.actorId);
      const isInstanceOwner = actor?.activityState === 'live' && actor.activityId === instance.instanceId;
      const closedConsumption = context.type === 'close' && effect.type === 'consumableUsed' && actor?.activityState === 'none' && actor.activityId === null;
      if (!isInstanceOwner && !closedConsumption) throw new Error('live reward effect actor is not locked by this instance');
    }
    switch (effect.type) {
      case 'discovery':
        await recordDiscovery(tx, clock, effect.actorId, effect.areaId, effect.locationId);
        if (effect.completion) await applyConquestProgress(tx, clock, effect.actorId, effect.areaId, effect.completion);
        break;
      case 'bossDefeated':
        await applyConquestProgress(tx, clock, effect.actorId, effect.areaId, effect.completion, effect.enemyIds);
        break;
      case 'lootGranted': {
        const instanceId = requireInstanceId(instance);
        const actionKey = actionFingerprint(effect.actionId);
        const deltas: LedgerDelta[] = effect.items.map(({ item, qty, kind }) => ({ actorId: effect.actorId,
          asset: kind === 'unique_mint' ? { kind, item } : { kind, item }, qty, to: `run_bag:${instanceId}` }));
        if (effect.gold > 0) deltas.push({ actorId: effect.actorId, asset: { kind: 'currency', currency: 'gold' }, qty: effect.gold,
          to: `run_bag:${instanceId}` });
        if (deltas.length > 0) {
          const owner = activity.get(effect.actorId);
          await applyLedgerDeltas(tx, { type: 'rpg_live_reward', id: `${instanceId}:loot:${actionKey}:${effect.actorId}` }, deltas,
            owner === undefined ? {} : { activity: owner });
        }
        break;
      }
      case 'xpGranted': {
        const curve = XpCurveSchema.parse({ xpToNext: effect.xpToNext });
        const instanceId = requireInstanceId(instance);
        const sourceId = `${instanceId}:xp:${actionFingerprint(effect.actionId)}:${effect.actorId}`;
        const fingerprint = createHash('sha256').update(JSON.stringify({ actorId: effect.actorId, xp: effect.xp,
          xpToNext: curve.xpToNext })).digest('hex');
        const claimed = await tx.insert(ledgerBatches).values({ sourceType: 'rpg_live_xp', sourceId, fingerprint, entryCount: 0 })
          .onConflictDoNothing().returning({ sourceId: ledgerBatches.sourceId });
        if (claimed.length === 0) {
          const [previous] = await tx.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, 'rpg_live_xp'),
            eq(ledgerBatches.sourceId, sourceId))).for('update');
          if (!previous || previous.fingerprint !== fingerprint || previous.entryCount !== 0) throw new Error('live XP reward idempotency conflict');
          break;
        }
        const [character] = await tx.select().from(characters).where(eq(characters.actorId, effect.actorId)).for('update');
        if (!character) throw new Error('missing live character for XP reward');
        const total = totalXpFromLevelProgress(character.level, character.xp, curve) + effect.xp;
        const progress = xpProgress(total, curve);
        await tx.update(characters).set({ level: progress.level, xp: progress.xpIntoLevel }).where(eq(characters.actorId, effect.actorId));
        break;
      }
      case 'consumableUsed': {
        const instanceId = requireInstanceId(instance);
        const owner = activity.get(effect.actorId);
        await applyLedgerDeltas(tx, { type: 'rpg_live_consumption', id: `${instanceId}:${actionFingerprint(effect.actionId)}:${effect.actorId}` },
          [{ actorId: effect.actorId, asset: { kind: 'stack', item: effect.item }, qty: effect.qty, from: 'inventory' }],
          owner === undefined ? {} : { activity: owner });
        break;
      }
    }
  }
}

function actionFingerprint(actionId: string): string { return createHash('sha256').update(actionId).digest('hex'); }
function requireInstanceId(instance: { readonly instanceId?: string }): string {
  if (!instance.instanceId) throw new Error('live reward effect is missing its instance id');
  return instance.instanceId;
}

/** Composes the RPG effects hook with optional extra store hooks (tests, settlement). */
export function rpgLiveStoreHooks(extra: PostgresInstanceStoreHooks = {}, validateCreate?: PostgresInstanceStoreHooks['validateCreate']): PostgresInstanceStoreHooks {
  return {
    ...extra,
    validateCreate: async (tx, input) => { await extra.validateCreate?.(tx, input); await validateCreate?.(tx, input); },
    onEffects: async (tx, instance, effects, nowMs, context) => {
      await applyRpgLiveEffects(tx, instance, effects, nowMs, context);
      await extra.onEffects?.(tx, instance, effects, nowMs, context);
    },
    onClose: async (tx, instance, input) => {
      if (input.outcome === 'returned') await bankReturnedRunBag(tx, instance, input.result);
      await extra.onClose?.(tx, instance, input);
    },
    onParticipantReleased: async (tx, instance, actorId) => {
      await extra.onParticipantReleased?.(tx, instance, actorId);
    },
  };
}

async function bankReturnedRunBag(tx: ActorTransaction, instance: { readonly instanceId: string }, resultValue: JsonValue): Promise<void> {
  const result = resultValue as { heroes?: unknown } | null;
  if (!result || !Array.isArray(result.heroes)) return;
  const eligible = new Set(result.heroes.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const hero = value as { actorId?: unknown; hp?: unknown; present?: unknown };
    return typeof hero.actorId === 'string' && hero.present !== false && hero.hp !== 0 ? [hero.actorId] : [];
  }));
  const deltas: LedgerDelta[] = [];
  for (const actorId of [...eligible].sort()) {
    const holdings = await getHoldings(tx, actorId);
    for (const holding of holdings.filter((entry) => entry.container === `run_bag:${instance.instanceId}`)) {
      if (holding.asset.kind === 'unique') {
        deltas.push({ actorId, asset: holding.asset, qty: 1, from: `run_bag:${instance.instanceId}`, to: 'inventory' });
      } else {
        deltas.push({ actorId, asset: holding.asset, qty: holding.qty,
          from: `run_bag:${instance.instanceId}`, to: 'inventory' });
      }
    }
  }
  if (deltas.length > 0) await applyLedgerDeltas(tx, { type: 'rpg_live_return', id: instance.instanceId }, deltas);
}
