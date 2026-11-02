import { netHoldings } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { coinCollector } from './__tests__/coin-collector.ts';
import { TORCH, TORCHES, torchCollector } from './__tests__/torch-collector.ts';
import { escrowProblems, escrowReturns, settleWithEscrow, simulatorEscrow } from './index.ts';

const herb = { kind: 'stack', item: 'item:herb' } as const;
const config = { maxCoins: 4, hazardBp: 0 };
const actors = [{ id: 'b' }, { id: 'a' }];

describe('escrowProblems', () => {
  it('accepts moves into escrow from one explicit source per (actor, asset)', () => {
    expect(escrowProblems([{ actorId: 'a', asset: herb, qty: 2, from: 'inventory', to: 'escrow' }])).toEqual([]);
  });

  it('rejects malformed escrow deltas', () => {
    const bad: LedgerDelta[][] = [
      [{ actorId: 'a', asset: herb, qty: 0, from: 'inventory', to: 'escrow' }],
      [{ actorId: 'a', asset: herb, qty: 1, to: 'escrow' }],
      [{ actorId: 'a', asset: herb, qty: 1, from: 'escrow', to: 'escrow' }],
      [{ actorId: 'a', asset: herb, qty: 1, from: 'inventory', to: 'run_bag' }],
      [{ actorId: 'a', asset: herb, qty: 1.5, from: 'inventory', to: 'escrow' }],
      [
        { actorId: 'a', asset: herb, qty: 1, from: 'inventory', to: 'escrow' },
        { actorId: 'a', asset: herb, qty: 1, from: 'storage', to: 'escrow' },
      ],
    ];
    for (const deltas of bad) expect(escrowProblems(deltas)).not.toEqual([]);
  });

  it('rejects unique mints (nothing to escrow yet) and keeps them out of escrow at settlement', () => {
    const sword = { kind: 'unique_mint', item: 'item:sword' } as const;
    expect(escrowProblems([{ actorId: 'a', asset: sword, qty: 1, to: 'escrow' }]).join()).toMatch(/unique_mint/);
    expect(() => escrowReturns([], [{ actorId: 'a', asset: sword, qty: 1, to: 'escrow' }])).toThrow(/never escrowed/);
    expect(escrowReturns([], [{ actorId: 'a', asset: sword, qty: 2, to: 'inventory' }])).toEqual([]);
  });
});

describe('escrowReturns', () => {
  const escrow: LedgerDelta[] = [
    { actorId: 'a', asset: herb, qty: 2, from: 'inventory', to: 'escrow' },
    { actorId: 'a', asset: herb, qty: 1, from: 'inventory', to: 'escrow' },
    { actorId: 'b', asset: TORCH, qty: 3, from: 'storage', to: 'escrow' },
  ];

  it('returns escrowed − consumed to the source container', () => {
    const settled: LedgerDelta[] = [
      { actorId: 'a', asset: herb, qty: 1, from: 'escrow' },
      { actorId: 'b', asset: TORCH, qty: 3, from: 'escrow' },
      { actorId: 'a', asset: herb, qty: 5, to: 'run_bag' }, // unrelated to escrow
    ];
    expect(escrowReturns(escrow, settled)).toEqual([{ actorId: 'a', asset: herb, qty: 2, from: 'escrow', to: 'inventory' }]);
    expect(escrowReturns(escrow, [])).toEqual([
      { actorId: 'a', asset: herb, qty: 3, from: 'escrow', to: 'inventory' },
      { actorId: 'b', asset: TORCH, qty: 3, from: 'escrow', to: 'storage' },
    ]);
  });

  it('throws when settlement breaks escrow conservation', () => {
    expect(() => escrowReturns(escrow, [{ actorId: 'b', asset: TORCH, qty: 4, from: 'escrow' }])).toThrow(/only 3/);
    expect(() => escrowReturns(escrow, [{ actorId: 'c', asset: TORCH, qty: 1, from: 'escrow' }])).toThrow(/never escrowed/);
    expect(() => escrowReturns(escrow, [{ actorId: 'a', asset: herb, qty: 1, from: 'run_bag', to: 'escrow' }])).toThrow(/into escrow/);
  });
});

describe('settleWithEscrow', () => {
  it('returns unused escrow for every cutoff and keeps holdings consistent', () => {
    const t = torchCollector.simulate({ config, actors, seed: 9, budget: 12 });
    expect(t.segments.length).toBeGreaterThan(TORCHES);
    for (let cutoff = -1; cutoff < t.segments.length; cutoff++) {
      const s = settleWithEscrow(torchCollector, t, cutoff, 'cancelled', config, actors);
      const burned = Math.min(cutoff + 1, TORCHES);
      expect(s.escrowed).toHaveLength(2);
      expect(s.returned).toEqual(
        burned === TORCHES
          ? []
          : ['a', 'b'].map((id) => ({ actorId: id, asset: TORCH, qty: TORCHES - burned, from: 'escrow', to: 'inventory' })),
      );
      expect(s.deltas).toEqual([...s.settled, ...s.returned]);
      // Start (escrow) + settlement: net torch change per actor = −burned.
      const torches = netHoldings([...s.escrowed, ...s.deltas]).filter((h) => h.asset.kind === 'stack');
      expect(torches.map((h) => h.qty)).toEqual(burned === 0 ? [] : [-burned, -burned]);
    }
  });

  it('cancelling before the first segment returns everything, even for an empty timeline', () => {
    const empty = { segments: [], outcome: 'retreated' as const };
    const s = settleWithEscrow(torchCollector, empty, -1, 'cancelled', config, actors);
    expect(s.settled).toEqual([]);
    expect(s.returned.map((d) => d.qty)).toEqual([TORCHES, TORCHES]);
  });

  it('works for simulators without escrow', () => {
    const t = coinCollector.simulate({ config, actors, seed: 3, budget: 6 });
    expect(simulatorEscrow(coinCollector, config, actors)).toEqual([]);
    expect(settleWithEscrow(coinCollector, t, 1, 'completed', config, actors).returned).toEqual([]);
  });
});
