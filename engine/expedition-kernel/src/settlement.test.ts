import { netHoldings } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { COIN, coinCollector } from './__tests__/coin-collector.ts';
import type { CoinActor, CoinConfig, CoinEvent, CoinReport, CoinState } from './__tests__/coin-collector.ts';
import { TORCHES, torchCollector } from './__tests__/torch-collector.ts';
import {
  SETTLE_NOT_ENDED,
  canCancel,
  checkSimulatorContract,
  defaultSettle,
  placeSegments,
  resolveSettlement,
  settleAt,
  settleWithEscrow,
} from './index.ts';
import type { ExpeditionSimulator, Timeline } from './index.ts';

type Sim = ExpeditionSimulator<CoinConfig, CoinActor, CoinEvent, CoinState, CoinReport>;

/** A torch collector that loses every coin on the natural end of a failed run (the penalty a cancel must not skip). */
const penalized: Sim = {
  ...torchCollector,
  id: 'test.penalized',
  settle(timeline, cutoff, reason) {
    const deltas = defaultSettle(timeline, cutoff);
    const fatal = reason === 'completed' && timeline.outcome === 'failed' && cutoff === timeline.segments.length - 1;
    return fatal ? deltas.filter((d) => d.asset.kind !== 'currency') : deltas;
  },
};

const actors: CoinActor[] = [{ id: 'a' }];
const config: CoinConfig = { maxCoins: 5, hazardBp: 3000 };

/** First seed whose run fails after at least `min` segments. */
function failedTimeline(min: number): { timeline: Timeline<CoinEvent, CoinState>; seed: number } {
  for (let seed = 1; seed < 10_000; seed++) {
    const timeline = penalized.simulate({ config, actors, seed, budget: 20 });
    if (timeline.outcome === 'failed' && timeline.segments.length >= min) return { timeline, seed };
  }
  throw new Error('no failing seed');
}

describe('resolveSettlement (cancel-after-end guard)', () => {
  const { timeline } = failedTimeline(3);
  const placed = placeSegments(timeline, 1_000, 20 * 60_000, 20);
  const last = timeline.segments.length - 1;

  it('settles a cancel before the end as cancelled at the reveal cutoff (never covering the last segment)', () => {
    const first = (placed.segments[0] as { revealAtMs: number }).revealAtMs;
    expect(resolveSettlement(placed, 1_000, 'cancel')).toEqual({ ok: true, requested: 'cancel', reason: 'cancelled', cutoff: -1, ended: false, converted: false });
    expect(resolveSettlement(placed, first, 'cancel')).toMatchObject({ ok: true, reason: 'cancelled', cutoff: 0 });
    const justBefore = resolveSettlement(placed, placed.endsAtMs - 1, 'cancel');
    expect(justBefore).toMatchObject({ ok: true, reason: 'cancelled', ended: false });
    expect(justBefore.ok && justBefore.cutoff).toBeLessThan(last);
    expect(canCancel(placed, placed.endsAtMs - 1)).toBe(true);
  });

  it('turns a cancel at or after the end into a completed settlement of the whole timeline', () => {
    for (const now of [placed.endsAtMs, placed.endsAtMs + 1, placed.plannedEndsAtMs + 60_000]) {
      expect(resolveSettlement(placed, now, 'cancel')).toEqual({ ok: true, requested: 'cancel', reason: 'completed', cutoff: last, ended: true, converted: true });
      expect(canCancel(placed, now)).toBe(false);
    }
    // The failed run ends early: after the actual end but before the planned end, a cancel is already a natural end.
    expect(placed.endsAtMs).toBeLessThan(placed.plannedEndsAtMs);
  });

  it('refuses complete before the end without leaking timestamps, and resolves member_left like cancel', () => {
    expect(resolveSettlement(placed, placed.endsAtMs - 1, 'complete')).toEqual({ ok: false, requested: 'complete', code: SETTLE_NOT_ENDED });
    expect(resolveSettlement(placed, placed.endsAtMs, 'complete')).toEqual({ ok: true, requested: 'complete', reason: 'completed', cutoff: last, ended: true, converted: false });
    expect(resolveSettlement(placed, placed.endsAtMs - 1, 'member_left')).toMatchObject({ ok: true, reason: 'member_left', converted: false });
    expect(resolveSettlement(placed, placed.endsAtMs, 'member_left')).toMatchObject({ ok: true, reason: 'completed', cutoff: last, converted: true });
  });

  it('handles empty timelines and rejects bad input', () => {
    const empty = placeSegments({ segments: [], outcome: 'retreated' }, 0, 1_000, 5);
    expect(resolveSettlement(empty, 0, 'cancel')).toMatchObject({ ok: true, reason: 'completed', cutoff: -1 });
    expect(() => resolveSettlement(placed, 1.5, 'cancel')).toThrow(RangeError);
    expect(() => resolveSettlement(placed, 0, 'abandon' as never)).toThrow(RangeError);
  });

  it('closes the exploit: a naive cancel covering the fatal segment would skip the penalty, the guard does not', () => {
    const coins = (deltas: readonly { asset: { kind: string } }[]) => deltas.filter((d) => d.asset.kind === 'currency').length;
    const naive = penalized.settle(timeline, last, 'cancelled');
    const natural = penalized.settle(timeline, last, 'completed');
    expect(coins(naive)).toBeGreaterThan(0);
    expect(coins(natural)).toBe(0);

    const result = settleAt(penalized, timeline, placed, placed.endsAtMs + 5, 'cancel', config, actors);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution).toMatchObject({ reason: 'completed', cutoff: last, converted: true });
    expect(result.settlement).toEqual(settleWithEscrow(penalized, timeline, last, 'completed', config, actors));
    expect(netHoldings(result.settlement.deltas).find((h) => h.asset.kind === COIN.kind)).toBeUndefined();
  });

  it('settleAt settles a real cancel with escrow returns and refuses an early complete', () => {
    const early = settleAt(penalized, timeline, placed, 1_000, 'cancel', config, actors);
    expect(early.ok && early.settlement.returned).toEqual([{ actorId: 'a', asset: { kind: 'stack', item: 'item:torch' }, qty: TORCHES, from: 'escrow', to: 'inventory' }]);
    expect(settleAt(penalized, timeline, placed, 1_000, 'complete', config, actors)).toEqual({ ok: false, requested: 'complete', code: SETTLE_NOT_ENDED });
    const other = placeSegments({ segments: [], outcome: 'completed' }, 0, 1_000, 20);
    expect(() => settleAt(penalized, timeline, other, 0, 'cancel', config, actors)).toThrow(/does not match/);
  });

  it('is covered by the contract checker for simulators with natural-end penalties', () => {
    expect(
      checkSimulatorContract(penalized, [{ config, actors, budget: 20, seeds: [1, 2, 3, 4, 5, 6, 7, 8] }], {
        settlement: { completed: 'custom', cancelled: 'default', member_left: 'default' },
      }),
    ).toEqual([]);
    expect(checkSimulatorContract(coinCollector, [{ config, actors, budget: 20, seeds: [1, 2, 3] }])).toEqual([]);
  });
});
