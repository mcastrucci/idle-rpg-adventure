/**
 * Durable effects of the RPG live plugin (`LiveStep.effects`), applied by the PostgreSQL instance store inside the
 * fenced transaction of the checkpoint/close they belong to (`PostgresInstanceStoreHooks.onEffects`). A discovery is
 * therefore committed exactly when the checkpointed state that contains it is; a restore from an earlier checkpoint
 * may emit it again, which the `progress.ts` seams absorb (unique keys, `ON CONFLICT DO NOTHING`).
 */
import { LiveEffectRejectedError } from '@engine/live-kernel';
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
import { liveDeaths } from './death-schema.ts';
import type { RpgLiveState } from './game.ts';

export type RpgLiveEffect =
  /** A participant present in the instance entered a location for the first time. */
  | { readonly type: 'discovery'; readonly actorId: string; readonly areaId: string; readonly locationId: string; readonly completion?: RpgCompletionSnapshot }
  /** A participant took part in a victorious boss fight. */
  | { readonly type: 'bossDefeated'; readonly actorId: string; readonly areaId: string; readonly enemyIds: readonly string[]; readonly completion?: RpgCompletionSnapshot }
  | { readonly type: 'lootGranted'; readonly actionId: string; readonly actorId: string; readonly items: readonly { readonly item: string; readonly qty: number; readonly kind: 'stack' | 'unique_mint' }[]; readonly gold: number }
  | { readonly type: 'consumableUsed'; readonly actionId: string; readonly actorId: string; readonly item: string; readonly qty: number }
  | { readonly type: 'xpGranted'; readonly actionId: string; readonly actorId: string; readonly xp: number; readonly xpToNext: readonly number[] }
  | { readonly type: 'heroDied'; readonly actorId: string; readonly areaId: string; readonly locationId: string;
      readonly causes: readonly { readonly sourceId: string; readonly label: string; readonly damage: number }[]; readonly xpToNext: readonly number[] }
  | { readonly type: 'corpseRecovered'; readonly actorId: string; readonly corpseId: string; readonly areaId: string; readonly locationId: string };

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
  if (effect?.['type'] === 'heroDied' && text('actorId') && text('areaId') && text('locationId') && Array.isArray(effect['causes']) && Array.isArray(effect['xpToNext'])) return effect as unknown as RpgLiveEffect;
  if (effect?.['type'] === 'corpseRecovered' && text('actorId') && text('corpseId') && text('areaId') && text('locationId')) return effect as unknown as RpgLiveEffect;
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
    if (effect.type === 'lootGranted' || effect.type === 'xpGranted' || effect.type === 'consumableUsed' || effect.type === 'heroDied' || effect.type === 'corpseRecovered') {
      const actor = actorsById.get(effect.actorId);
      const isInstanceOwner = actor?.activityState === 'live' && actor.activityId === instance.instanceId;
      const closedConsumption = context.type === 'close' && effect.type === 'consumableUsed' && actor?.activityState === 'none' && actor.activityId === null;
      const closedDeath = context.type === 'close' && effect.type === 'heroDied' && actor?.activityState === 'none' && actor.activityId === null;
      if (!isInstanceOwner && !closedConsumption && !closedDeath) throw new Error('live reward effect actor is not locked by this instance');
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
      case 'heroDied': await settleHeroDeath(tx, instance, effect, nowMs, context); break;
      case 'corpseRecovered': await recoverCorpse(tx, instance, effect, nowMs); break;
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

const CORPSE_TTL_MS = 24 * 60 * 60 * 1000;
async function settleHeroDeath(tx: ActorTransaction, instance: { readonly instanceId?: string }, effect: Extract<RpgLiveEffect, { type: 'heroDied' }>, nowMs: number, context: LiveEffectsContext): Promise<void> {
  const instanceId = requireInstanceId(instance); const actorId = effect.actorId.toLowerCase();
  const sourceId = `${instanceId}:death:${actorId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify({ actorId, areaId: effect.areaId, locationId: effect.locationId,
    causes: effect.causes, xpToNext: effect.xpToNext })).digest('hex');
  const claimed = await tx.insert(ledgerBatches).values({ sourceType: 'rpg_live_death', sourceId, fingerprint, entryCount: 0 })
    .onConflictDoNothing().returning({ sourceId: ledgerBatches.sourceId });
  if (claimed.length === 0) {
    const [previous] = await tx.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, 'rpg_live_death'), eq(ledgerBatches.sourceId, sourceId))).for('update');
    if (!previous || previous.fingerprint !== fingerprint || previous.entryCount !== 0) throw new Error('live death idempotency conflict');
    return;
  }
  const [character] = await tx.select().from(characters).where(eq(characters.actorId, actorId)).for('update');
  if (!character) throw new Error('missing live character for death');
  const curve = XpCurveSchema.parse({ xpToNext: effect.xpToNext });
  const xpBeforeTotal = totalXpFromLevelProgress(character.level, character.xp, curve);
  const xpLost = Math.min(xpBeforeTotal, Math.floor((curve.xpToNext[character.level - 1] ?? 0) / 10));
  const after = xpProgress(Math.max(0, xpBeforeTotal - xpLost), curve);
  await tx.update(characters).set({ level: after.level, xp: after.xpIntoLevel }).where(eq(characters.actorId, actorId));

  const active = await tx.select().from(liveDeaths).where(and(eq(liveDeaths.actorId, actorId), eq(liveDeaths.status, 'active'))).for('update');
  for (const previous of active) {
    const status = previous.expiresAt.getTime() <= nowMs ? 'expired' : 'invalidated';
    await sinkCorpse(tx, actorId, previous.deathId, context.type === 'close' ? undefined : { state: 'live', id: instanceId });
    await tx.update(liveDeaths).set({ status }).where(eq(liveDeaths.deathId, previous.deathId));
  }
  const deathId = uuidFromDigest(`${instanceId}:${actorId}:death`);
  const holdings = await getHoldings(tx, actorId);
  const runBag = holdings.filter(holding => holding.container === `run_bag:${instanceId}`);
  const bagSnapshot = snapshotHoldings(runBag);
  const deltas: LedgerDelta[] = runBag.map(holding => ({ actorId, asset: holding.asset,
    qty: holding.asset.kind === 'unique' ? 1 : holding.qty, from: `run_bag:${instanceId}`, to: `corpse:${deathId}` }));
  if (deltas.length) await applyLedgerDeltas(tx, { type: 'rpg_live_corpse', id: `${deathId}:create` }, deltas,
    context.type === 'close' ? {} : { activity: { state: 'live', id: instanceId } });
  await tx.insert(liveDeaths).values({ deathId, actorId, instanceId, areaId: effect.areaId, locationId: effect.locationId,
    occurredAt: new Date(nowMs), expiresAt: new Date(nowMs + CORPSE_TTL_MS), status: 'active',
    xpBeforeLevel: character.level, xpBeforeIntoLevel: character.xp, xpBeforeTotal, xpLost, xpAfterLevel: after.level,
    xpAfterIntoLevel: after.xpIntoLevel, xpAfterTotal: Math.max(0, xpBeforeTotal - xpLost),
    causes: effect.causes.slice(0, 3), bagSnapshot });
}

async function recoverCorpse(tx: ActorTransaction, instance: { readonly instanceId?: string; readonly checkpoint?: JsonValue },
  effect: Extract<RpgLiveEffect, { type: 'corpseRecovered' }>, nowMs: number): Promise<void> {
  const instanceId = requireInstanceId(instance); const actorId = effect.actorId.toLowerCase();
  const checkpoint = instance.checkpoint as { state?: unknown } | undefined;
  const state = checkpoint?.state as RpgLiveState | undefined;
  const hero = state?.heroes.find(candidate => candidate.actorId === actorId);
  if (!hero?.corpses.some(corpse => corpse.id === effect.corpseId && corpse.areaId === effect.areaId && corpse.locationId === effect.locationId) ||
      state?.area !== effect.areaId || state.location !== effect.locationId) throw new LiveEffectRejectedError('corpse_unavailable');
  const [corpse] = await tx.select().from(liveDeaths).where(and(eq(liveDeaths.deathId, effect.corpseId), eq(liveDeaths.actorId, actorId))).for('update');
  if (!corpse || corpse.status !== 'active' || corpse.expiresAt.getTime() <= nowMs || corpse.areaId !== effect.areaId || corpse.locationId !== effect.locationId) {
    throw new LiveEffectRejectedError('corpse_unavailable');
  }
  const holdings = await getHoldings(tx, actorId);
  const deltas: LedgerDelta[] = holdings.filter(holding => holding.container === `corpse:${corpse.deathId}`).map(holding => ({
    actorId, asset: holding.asset, qty: holding.asset.kind === 'unique' ? 1 : holding.qty,
    from: `corpse:${corpse.deathId}`, to: `run_bag:${instanceId}`,
  }));
  if (deltas.length) await applyLedgerDeltas(tx, { type: 'rpg_live_corpse_recovery', id: `${corpse.deathId}:${instanceId}` }, deltas,
    { activity: { state: 'live', id: instanceId } });
  await tx.update(liveDeaths).set({ status: 'recovered' }).where(eq(liveDeaths.deathId, corpse.deathId));
}

async function sinkCorpse(tx: ActorTransaction, actorId: string, deathId: string, activity?: { state: 'live'; id: string }): Promise<void> {
  const holdings = await getHoldings(tx, actorId);
  const deltas: LedgerDelta[] = holdings.filter(holding => holding.container === `corpse:${deathId}`).map(holding => ({
    actorId, asset: holding.asset, qty: holding.asset.kind === 'unique' ? 1 : holding.qty,
    from: `corpse:${deathId}`, to: 'destroyed',
  }));
  if (deltas.length) await applyLedgerDeltas(tx, { type: 'rpg_live_corpse_sink', id: deathId }, deltas, activity ? { activity } : {});
}
export async function expireRpgCorpse(tx: ActorTransaction, actorId: string, deathId: string): Promise<void> {
  await sinkCorpse(tx, actorId, deathId);
  await tx.update(liveDeaths).set({ status: 'expired' }).where(and(eq(liveDeaths.deathId, deathId), eq(liveDeaths.actorId, actorId), eq(liveDeaths.status, 'active')));
}

function snapshotHoldings(holdings: Awaited<ReturnType<typeof getHoldings>>): { stacks: { item: string; qty: number }[]; gold: number;
  uniques: { itemId: string; definition: string; slot: string | null; rolls: unknown }[] } {
  const stacks = holdings.flatMap(holding => holding.asset.kind === 'stack' ? [{ item: holding.asset.item, qty: holding.qty }] : []);
  const gold = holdings.reduce((sum, holding) => sum + (holding.asset.kind === 'currency' && holding.asset.currency === 'gold' ? holding.qty : 0), 0);
  const uniques = holdings.flatMap(holding => holding.asset.kind === 'unique' && holding.itemId ? [{ itemId: holding.itemId,
    definition: holding.definition ?? '', slot: holding.slot ?? null, rolls: holding.rolls ?? {} }] : []);
  return { stacks, gold, uniques };
}

function uuidFromDigest(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16);
  const joined = hex.join(''); return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
