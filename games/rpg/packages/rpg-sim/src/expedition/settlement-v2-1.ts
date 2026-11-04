/**
 * Frozen progression semantics for persisted simulator version rpg-idle@2.1.0+rpg-sim@1.1.0 (#129). Never edit; append a
 * new version module instead.
 *
 * `rpg-idle@2.1.0` changes exactly one thing relative to 2.0.0: the XP channel. The timeline, bag settlement
 * (`settleIdleV2`), summary (`summarizeIdleV2`) and estimate metrics (`rpgIdleMetricsV2`) are byte-for-byte those of
 * 2.0.0 (re-used from `settlement-v2.ts`; golden timeline hashes are unchanged). The death XP penalty is no longer a flat
 * rate the simulator reports (`deathXpLossBp`, 10% of the next level's requirement): the server applies the level-scaled
 * `applyDeathXpLoss(totalXp + xpEarned, curve)` of `@rpg/rpg-stats` to every hero with `died` when
 * `applyDeathPenalty` is set, using the open-ended curve whose `tailGrowthBp` is persisted in the expedition snapshot.
 */
import { assertCutoff } from '@engine/expedition-kernel';
import type { SettleReason, Timeline } from '@engine/expedition-kernel';

import type { RpgActorProgress, RpgIdleEvent, RpgIdleState, RpgProgress } from './types.ts';

type IdleTimeline = Timeline<RpgIdleEvent, RpgIdleState>;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function add(m: Map<string, number>, key: string, qty: number): void {
  m.set(key, (m.get(key) ?? 0) + qty);
}

function sorted(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => cmp(a, b)));
}

/**
 * XP/progression of segments `0..cutoff` (frozen copy of the 2.0.0 logic minus the flat `deathXpLossBp`). Every hero seen
 * in the timeline is listed (sorted); `applyDeathPenalty` is true when a death is covered and `reason === 'completed'`.
 */
export function rpgProgressV2_1(timeline: IdleTimeline, cutoff: number, reason: SettleReason): RpgProgress {
  assertCutoff(timeline as Timeline<unknown, unknown>, cutoff);
  const xp = new Map<string, number>();
  const kills = new Map<string, Map<string, number>>();
  const died = new Set<string>();
  const seen = new Set<string>();
  for (const s of timeline.segments.slice(0, cutoff + 1)) {
    for (const e of s.events) {
      if (e.type === 'kill') {
        for (const id of e.credited) {
          seen.add(id);
          add(xp, id, e.xp);
          const k = kills.get(id) ?? new Map<string, number>();
          add(k, e.enemy, 1);
          kills.set(id, k);
        }
      } else if (e.type === 'hp') {
        seen.add(e.actorId);
      } else if (e.type === 'death') {
        seen.add(e.actorId);
        died.add(e.actorId);
      }
    }
  }
  const actors: RpgActorProgress[] = [...seen].sort(cmp).map((actorId) => ({
    actorId,
    xpEarned: xp.get(actorId) ?? 0,
    kills: sorted(kills.get(actorId) ?? new Map()),
    died: died.has(actorId),
  }));
  const anyDeath = died.size > 0;
  return { actors, died: anyDeath, applyDeathPenalty: anyDeath && reason === 'completed' };
}
