/**
 * Test-only dummy simulator ("coin collector"), deliberately generic: each segment every actor finds 0..max coins
 * (`finds` stream) into its run bag, then a `hazards` roll may end the run (`failed`); a run retreats once any actor
 * holds `retreatAtCoins`. Every third segment is a long stretch of weight 2 to exercise uneven weights.
 */

import type { LedgerDelta } from '@engine/economy';
import { BP_SCALE, RngStreams, mulDivFloor } from '@engine/sim-core';

import { defaultSettle } from '../timeline.ts';
import type { ExpeditionSimulator, Outcome, Segment } from '../types.ts';

export interface CoinConfig {
  readonly maxCoins: number;
  readonly hazardBp: number;
  readonly retreatAtCoins?: number;
}
export interface CoinActor {
  readonly id: string;
}
export type CoinEvent =
  | { readonly type: 'found'; readonly actorId: string; readonly coins: number }
  | { readonly type: 'hazard' }
  | { readonly type: 'retreat' };
export interface CoinState {
  readonly totals: Readonly<Record<string, number>>;
}
export interface CoinReport {
  readonly segments: number;
  readonly coins: number;
}

export const COIN = { kind: 'currency', currency: 'coin' } as const;

export function weightOf(index: number): number {
  return index % 3 === 2 ? 2 : 1;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

export const coinCollector: ExpeditionSimulator<CoinConfig, CoinActor, CoinEvent, CoinState, CoinReport> = {
  id: 'test.coin-collector',
  version: '1',
  parseConfig(input) {
    const o = input as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw new TypeError('config must be an object');
    if (!isInt(o['maxCoins'], 0, 1_000_000)) throw new TypeError('maxCoins');
    if (!isInt(o['hazardBp'], 0, BP_SCALE)) throw new TypeError('hazardBp');
    const retreat = o['retreatAtCoins'];
    if (retreat !== undefined && !isInt(retreat, 1, 1_000_000_000)) throw new TypeError('retreatAtCoins');
    return retreat === undefined
      ? { maxCoins: o['maxCoins'], hazardBp: o['hazardBp'] }
      : { maxCoins: o['maxCoins'], hazardBp: o['hazardBp'], retreatAtCoins: retreat };
  },
  canStart(ctx) {
    return ctx.actors.length > 0 ? { ok: true } : { ok: false, code: 'no_actors' };
  },
  budget(_config, durationMin, paceBp) {
    const b = mulDivFloor(durationMin, paceBp, 5 * BP_SCALE); // one segment per 5 minutes at pace ×1
    return b < 1 ? 1 : b;
  },
  simulate({ config, actors, seed, budget, from }) {
    const streams = RngStreams.fromSeed(seed);
    const sorted = [...actors].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const totals: Record<string, number> = { ...from?.state.totals };
    const segments: Segment<CoinEvent, CoinState>[] = [];
    let outcome: Outcome = 'completed';
    let index = from?.segment ?? 0;
    let used = 0;
    for (;;) {
      const weight = weightOf(index);
      if (used + weight > budget) break;
      used += weight;
      const events: CoinEvent[] = [];
      const deltas: LedgerDelta[] = [];
      for (const a of sorted) {
        const coins = streams.stream('finds').int(0, config.maxCoins);
        events.push({ type: 'found', actorId: a.id, coins });
        if (coins > 0) deltas.push({ actorId: a.id, asset: COIN, qty: coins, to: 'run_bag' });
        totals[a.id] = (totals[a.id] ?? 0) + coins;
      }
      const hazard = streams.stream('hazards').chanceBp(config.hazardBp);
      if (hazard) {
        events.push({ type: 'hazard' });
        outcome = 'failed';
      } else if (config.retreatAtCoins !== undefined && sorted.some((a) => (totals[a.id] ?? 0) >= (config.retreatAtCoins as number))) {
        events.push({ type: 'retreat' });
        outcome = 'retreated';
      }
      segments.push({ index, weight, events, deltas, stateAfter: { totals: { ...totals } } });
      index++;
      if (outcome !== 'completed') break;
    }
    return { segments, outcome };
  },
  settle: defaultSettle,
  summarize(timeline, cutoff) {
    let coins = 0;
    for (const d of defaultSettle(timeline, cutoff)) coins += d.qty;
    return { segments: cutoff + 1, coins };
  },
};
