/**
 * Durable effects of the RPG live plugin (`LiveStep.effects`), applied by the PostgreSQL instance store inside the
 * fenced transaction of the checkpoint/close they belong to (`PostgresInstanceStoreHooks.onEffects`). A discovery is
 * therefore committed exactly when the checkpointed state that contains it is; a restore from an earlier checkpoint
 * may emit it again, which the `progress.ts` seams absorb (unique keys, `ON CONFLICT DO NOTHING`).
 */
import type { JsonValue } from '@engine/live-kernel';
import { lockActors } from '@engine/server-kit';
import type { ActorTransaction, PostgresInstanceStoreHooks } from '@engine/server-kit';

import { recordDiscovery } from '../expeditions/progress.ts';
import { applyConquestProgress } from '../conquest/service.ts';
import type { RpgCompletionSnapshot } from '../conquest/types.ts';

export type RpgLiveEffect =
  /** A participant present in the instance entered a location for the first time. */
  | { readonly type: 'discovery'; readonly actorId: string; readonly areaId: string; readonly locationId: string; readonly completion?: RpgCompletionSnapshot }
  /** A participant took part in a victorious boss fight. */
  | { readonly type: 'bossDefeated'; readonly actorId: string; readonly areaId: string; readonly enemyIds: readonly string[]; readonly completion?: RpgCompletionSnapshot };

function parseEffect(value: JsonValue): RpgLiveEffect {
  const effect = value as Partial<Record<string, unknown>> | null;
  const text = (key: string) => typeof effect?.[key] === 'string';
  if (effect?.['type'] === 'discovery' && text('actorId') && text('areaId') && text('locationId')) return effect as unknown as RpgLiveEffect;
  if (effect?.['type'] === 'bossDefeated' && text('actorId') && text('areaId') && Array.isArray(effect['enemyIds'])) {
    return effect as unknown as RpgLiveEffect;
  }
  throw new Error('unknown RPG live effect');
}

/** `onEffects` hook: records progress and evaluates conquest only for the instance's currently present participants. */
export async function applyRpgLiveEffects(tx: ActorTransaction, instance: { readonly participants: readonly { readonly actorId: string; readonly left?: boolean }[] },
  effects: readonly JsonValue[], nowMs: number): Promise<void> {
  const clock = { nowMs: () => nowMs };
  const participants = new Set(instance.participants.filter((p) => !('left' in p) || p.left !== true).map((p) => p.actorId));
  const parsed = effects.map(parseEffect);
  for (const effect of parsed) {
    if (!participants.has(effect.actorId)) throw new Error('live effect for a non-participant');
  }
  // Multiple checkpoints may contend over an actor's final discovery and boss requirement. Acquire all actor locks in
  // the engine's global order before writing/evaluating, so the second evaluator observes the first commit.
  await lockActors(tx, parsed.map(effect => effect.actorId));
  for (const effect of parsed) {
    switch (effect.type) {
      case 'discovery':
        await recordDiscovery(tx, clock, effect.actorId, effect.areaId, effect.locationId);
        if (effect.completion) await applyConquestProgress(tx, clock, effect.actorId, effect.areaId, effect.completion);
        break;
      case 'bossDefeated':
        await applyConquestProgress(tx, clock, effect.actorId, effect.areaId, effect.completion, effect.enemyIds);
        break;
    }
  }
}

/** Composes the RPG effects hook with optional extra store hooks (tests, settlement). */
export function rpgLiveStoreHooks(extra: PostgresInstanceStoreHooks = {}): PostgresInstanceStoreHooks {
  return {
    ...extra,
    onEffects: async (tx, instance, effects, nowMs) => {
      await applyRpgLiveEffects(tx, instance, effects, nowMs);
      await extra.onEffects?.(tx, instance, effects, nowMs);
    },
  };
}
