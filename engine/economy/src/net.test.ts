import { describe, expect, it } from 'vitest';

import { ENGINE_CONTAINERS, assertLedgerDelta, assetKey, netDeltas, netHoldings } from './index.ts';
import type { LedgerDelta } from './index.ts';

const gold = { kind: 'currency', currency: 'gold' } as const;
const herb = { kind: 'stack', item: 'herb' } as const;

describe('assetKey', () => {
  it('is canonical per kind', () => {
    expect(assetKey(gold)).toBe('currency:gold');
    expect(assetKey(herb)).toBe('stack:herb');
    expect(assetKey({ kind: 'unique', itemId: 'i1' })).toBe('unique:i1');
  });
});

describe('ENGINE_CONTAINERS', () => {
  it('lists the engine-standard containers', () => {
    expect(ENGINE_CONTAINERS).toEqual(['equipped', 'inventory', 'storage', 'run_bag', 'escrow', 'corpse']);
  });
});

describe('assertLedgerDelta', () => {
  it('rejects malformed deltas', () => {
    expect(() => assertLedgerDelta({ actorId: 'a', asset: gold, qty: 1.5 })).toThrow(RangeError);
    expect(() => assertLedgerDelta({ actorId: '', asset: gold, qty: 1 })).toThrow(TypeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: { kind: 'nope' } as never, qty: 1 })).toThrow(TypeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: { kind: 'stack', item: '' }, qty: 1 })).toThrow(TypeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: gold, qty: 1, to: '' })).toThrow(TypeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: gold, qty: -3, to: 'my_game_box' })).not.toThrow();
  });
});

describe('netDeltas', () => {
  it('aggregates per actor, asset and container, sorted and without zeros', () => {
    const deltas: LedgerDelta[] = [
      { actorId: 'b', asset: gold, qty: 5, to: 'run_bag' },
      { actorId: 'a', asset: herb, qty: 2, from: 'inventory', to: 'escrow' },
      { actorId: 'a', asset: herb, qty: 1, from: 'escrow' },
      { actorId: 'a', asset: gold, qty: 3 },
      { actorId: 'b', asset: gold, qty: -5, to: 'run_bag' },
      { actorId: 'a', asset: gold, qty: 4, to: 'run_bag' },
    ];
    expect(netDeltas(deltas)).toEqual([
      { actorId: 'a', asset: gold, container: null, qty: 3 },
      { actorId: 'a', asset: gold, container: 'run_bag', qty: 4 },
      { actorId: 'a', asset: herb, container: 'escrow', qty: 1 },
      { actorId: 'a', asset: herb, container: 'inventory', qty: -2 },
    ]);
  });

  it('is independent of input order', () => {
    const deltas: LedgerDelta[] = [
      { actorId: 'x', asset: herb, qty: 1, to: 'storage' },
      { actorId: 'x', asset: gold, qty: 2, to: 'inventory' },
      { actorId: 'w', asset: gold, qty: 7 },
    ];
    expect(netDeltas([...deltas].reverse())).toEqual(netDeltas(deltas));
  });

  it('throws on overflow', () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(() => netDeltas([{ actorId: 'a', asset: gold, qty: big }, { actorId: 'a', asset: gold, qty: 1 }])).toThrow(RangeError);
  });
});

describe('netHoldings', () => {
  it('cancels moves between containers', () => {
    const deltas: LedgerDelta[] = [
      { actorId: 'a', asset: herb, qty: 3, from: 'inventory', to: 'escrow' },
      { actorId: 'a', asset: herb, qty: 1, from: 'escrow' },
      { actorId: 'a', asset: gold, qty: 10, to: 'run_bag' },
      { actorId: 'a', asset: gold, qty: 10, from: 'run_bag', to: 'inventory' },
    ];
    expect(netHoldings(deltas)).toEqual([
      { actorId: 'a', asset: gold, qty: 10 },
      { actorId: 'a', asset: herb, qty: -1 },
    ]);
  });
});
