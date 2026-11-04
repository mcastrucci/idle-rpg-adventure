/**
 * Frozen settlement, progression, and report semantics for persisted simulator version rpg-idle@2.0.0+rpg-sim@1.1.0.
 *
 * Settlement (`settle(timeline, cutoff, reason)`, rewards-and-persistence §4, idle-simulation §6–§7, provisional):
 * - `cancelled` / `member_left`: exactly `defaultSettle` — the revealed segments' bag grants and consumable use
 *   (open decision #6: revealed encounters granted in full, unused consumables returned by the kernel).
 * - `completed` (natural end) with outcome `completed`/`retreated`, or a cutoff before the fatal segment: the same
 *   deltas, merged per (actor, asset, from, to).
 * - `completed` covering the fatal segment of a `failed` timeline: consumable use is kept, and per (actor, asset) the
 *   bag grants (gold and items) are reduced by `lost = ⌊total × deathBagLossBp / 10000⌋` (50 %: the odd unit stays
 *   with the player), i.e. `kept = total − lost`.
 * Unused escrow is returned by the kernel (`settleWithEscrow`), never by `settle`.
 */
import { assetKey } from '@engine/economy';
import type { AssetRef, LedgerDelta } from '@engine/economy';
import { assertCutoff, defaultSettle } from '@engine/expedition-kernel';
import type { SettleReason, Timeline } from '@engine/expedition-kernel';
import { mulBp } from '@engine/sim-core';

import { isGrant, mergeDeltas } from './deltas.ts';
import type { RpgIdleTuning } from './simulate.ts';
import type {
  DeathLog,
  EncounterMember,
  HpSummary,
  RpgActorProgress,
  RpgIdleEvent,
  RpgIdleReport,
  RpgIdleState,
  RpgProgressV2,
} from './types.ts';

type IdleTimeline = Timeline<RpgIdleEvent, RpgIdleState>;

/** True when segments `0..cutoff` include the fatal encounter of a failed timeline. */
export function coversDeathV2(timeline: IdleTimeline, cutoff: number): boolean {
  return timeline.outcome === 'failed' && cutoff === timeline.segments.length - 1;
}

/** Applies the death bag loss to merged deltas (grants only; consumption untouched). */
export function applyBagLossV2(deltas: readonly LedgerDelta[], lossBp: number): LedgerDelta[] {
  const out: LedgerDelta[] = [];
  for (const d of deltas) {
    if (!isGrant(d) || d.qty <= 0) {
      out.push(d);
      continue;
    }
    const kept = d.qty - mulBp(d.qty, lossBp);
    if (kept > 0) out.push({ ...d, qty: kept });
  }
  return out;
}

export function settleIdleV2(tuning: RpgIdleTuning, timeline: IdleTimeline, cutoff: number, reason: SettleReason): LedgerDelta[] {
  const base = defaultSettle(timeline, cutoff);
  if (reason !== 'completed') return base;
  const merged = mergeDeltas(base);
  return coversDeathV2(timeline, cutoff) ? applyBagLossV2(merged, tuning.deathBagLossBp) : merged;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => cmp(a, b)));
}

function add(m: Map<string, number>, key: string, qty: number): void {
  m.set(key, (m.get(key) ?? 0) + qty);
}

/**
 * XP/progression of segments `0..cutoff` for the server's settlement hook (XP is not a ledger asset, ADR-0007). Every
 * hero seen in the timeline is listed (sorted). On a death, the server applies
 * `applyXpLoss(totalXp + xpEarned, deathXpLossBp, curve)` (`@rpg/rpg-stats`) to each hero with `died` — XP earned on
 * the expedition is added first, then the penalty (rewards §4: "XP earned kept before penalty").
 */
export function rpgProgressV2(timeline: IdleTimeline, cutoff: number, reason: SettleReason): RpgProgressV2 {
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
  const applyDeathPenalty = anyDeath && reason === 'completed';
  return { actors, died: anyDeath, applyDeathPenalty, deathXpLossBp: applyDeathPenalty ? 1_000 : 0 };
}

/**
 * Estimate metrics of the idle simulators (kernel 0.3 `estimate(…, { metrics: rpgIdleMetrics })`): XP is not a ledger
 * asset, so it is aggregated through this extractor — per hero `xp:<actorId>` = `xpEarned` of the whole timeline
 * (gross: the death XP penalty depends on the hero's total XP and is applied by the server), and `died:<actorId>` = 1
 * when the hero died (its p-values show how often).
 */
export function rpgIdleMetricsV2(timeline: IdleTimeline): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of rpgProgressV2(timeline, timeline.segments.length - 1, 'completed').actors) {
    out[`xp:${a.actorId}`] = a.xpEarned;
    if (a.died) out[`died:${a.actorId}`] = 1;
  }
  return out;
}

/** Report data for segments `0..cutoff` (summary + death log). */
export function summarizeIdleV2(timeline: IdleTimeline, cutoff: number): RpgIdleReport {
  assertCutoff(timeline as Timeline<unknown, unknown>, cutoff);
  const covered = timeline.segments.slice(0, cutoff + 1);
  const kills = new Map<string, number>();
  const xp = new Map<string, number>();
  const loot = new Map<string, number>();
  const used = new Map<string, number>();
  const hp = new Map<string, { maxHp: number; start: number | null; lowest: number | null; end: number | null }>();
  let encounters = 0;
  let victories = 0;
  let gold = 0;
  let retreat: RpgIdleReport['retreat'] = null;
  let deathLog: DeathLog | null = null;
  for (const s of covered) {
    let group: readonly EncounterMember[] = [];
    for (const e of s.events) {
      switch (e.type) {
        case 'encounter':
          encounters++;
          if (e.result === 'victory') victories++;
          group = e.enemies;
          break;
        case 'kill':
          add(kills, e.enemy, 1);
          for (const id of e.credited) add(xp, id, e.xp);
          break;
        case 'loot':
          add(loot, e.item, e.qty);
          break;
        case 'gold':
          gold += e.qty;
          break;
        case 'consumable':
          add(used, e.item, e.qty);
          break;
        case 'hp': {
          const h = hp.get(e.actorId) ?? { maxHp: e.maxHp, start: null, lowest: null, end: null };
          if (h.start === null) h.start = e.before;
          h.lowest = h.lowest === null || e.afterCombat < h.lowest ? e.afterCombat : h.lowest;
          h.end = e.hp;
          hp.set(e.actorId, h);
          break;
        }
        case 'death':
          deathLog = { actorId: e.actorId, encounter: s.index, enemies: group, causes: e.causes };
          break;
        case 'retreat':
          retreat = e.reason;
          break;
      }
    }
  }
  const whole = cutoff === timeline.segments.length - 1;
  const hpSummary: HpSummary[] = [...hp.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([actorId, h]) => ({ actorId, maxHp: h.maxHp, start: h.start, lowest: h.lowest, end: h.end }));
  return {
    segments: covered.length,
    encounters,
    victories,
    outcome: whole ? timeline.outcome : null,
    kills: sorted(kills),
    xp: sorted(xp),
    gold,
    loot: sorted(loot),
    consumablesUsed: sorted(used),
    hp: hpSummary,
    retreat,
    deathLog,
  };
}

/** Net bag of a delta list per asset key (used by reports and tests). */
export function bagTotals(deltas: readonly LedgerDelta[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const d of deltas) if (isGrant(d)) add(m, assetKey(d.asset as AssetRef), d.qty);
  return sorted(m);
}
