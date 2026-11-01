/**
 * Test-only variant of the coin collector that escrows inputs: every actor brings `TORCHES` torches from its
 * `inventory` (escrowed at start) and burns one per segment while it has any left.
 */

import type { LedgerDelta } from '@engine/economy';

import type { ExpeditionSimulator, Segment } from '../types.ts';
import { coinCollector } from './coin-collector.ts';
import type { CoinActor, CoinConfig, CoinEvent, CoinReport, CoinState } from './coin-collector.ts';

export const TORCH = { kind: 'stack', item: 'item:torch' } as const;
export const TORCHES = 3;

export const torchCollector: ExpeditionSimulator<CoinConfig, CoinActor, CoinEvent, CoinState, CoinReport> = {
  ...coinCollector,
  id: 'test.torch_collector',
  escrow: (_config, actors) =>
    [...actors]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a): LedgerDelta => ({ actorId: a.id, asset: TORCH, qty: TORCHES, from: 'inventory', to: 'escrow' })),
  simulate(input) {
    const t = coinCollector.simulate(input);
    const segments = t.segments.map((s): Segment<CoinEvent, CoinState> => {
      const burns = s.index < TORCHES ? input.actors.map((a): LedgerDelta => ({ actorId: a.id, asset: TORCH, qty: 1, from: 'escrow' })) : [];
      return { ...s, deltas: [...s.deltas, ...burns] };
    });
    return { ...t, segments };
  },
};
