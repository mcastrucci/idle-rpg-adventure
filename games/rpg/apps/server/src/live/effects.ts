/**
 * Durable effects of the RPG live plugin (`LiveStep.effects`), applied by the PostgreSQL instance store inside the
 * fenced transaction of the checkpoint/close they belong to (`PostgresInstanceStoreHooks.onEffects`). A discovery is
 * therefore committed exactly when the checkpointed state that contains it is; a restore from an earlier checkpoint
 * may emit it again, which the `progress.ts` seams absorb (unique keys, `ON CONFLICT DO NOTHING`).
 */
import type { JsonValue } from '@engine/live-kernel';
import type { ActorTransaction, PostgresInstanceStoreHooks } from '@engine/server-kit';

import { recordDiscovery } from '../expeditions/progress.ts';

export type RpgLiveEffect =
  /** A participant present in the instance entered a location for the first time. */
  | { readonly type: 'discovery'; readonly actorId: string; readonly areaId: string; readonly locationId: string }
  /** A participant took part in a victorious boss fight. */
  | { readonly type: 'bossDefeated'; readonly actorId: string; readonly areaId: string; readonly enemyIds: readonly string[] };

function parseEffect(value: JsonValue): RpgLiveEffect {
  const effect = value as Partial<Record<string, unknown>> | null;
  const text = (key: string) => typeof effect?.[key] === 'string';
  if (effect?.['type'] === 'discovery' && text('actorId') && text('areaId') && text('locationId')) return effect as unknown as RpgLiveEffect;
  if (effect?.['type'] === 'bossDefeated' && text('actorId') && text('areaId') && Array.isArray(effect['enemyIds'])) {
    return effect as unknown as RpgLiveEffect;
  }
  throw new Error('unknown RPG live effect');
}

/** `onEffects` hook: records discoveries through the trusted progress seam, only for the instance's participants. */
export async function applyRpgLiveEffects(tx: ActorTransaction, instance: { readonly participants: readonly { readonly actorId: string }[] },
  effects: readonly JsonValue[], nowMs: number): Promise<void> {
  const clock = { nowMs: () => nowMs };
  const participants = new Set(instance.participants.map((p) => p.actorId));
  for (const raw of effects) {
    const effect = parseEffect(raw);
    if (!participants.has(effect.actorId)) throw new Error('live effect for a non-participant');
    switch (effect.type) {
      case 'discovery':
        await recordDiscovery(tx, clock, effect.actorId, effect.areaId, effect.locationId);
        break;
      case 'bossDefeated':
        // Conquest hook (#47): record the boss defeat (`defeated:<enemy>` objective) and evaluate conquest in this
        // same transaction. Intentionally not recorded here; #38 only emits the effect.
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
