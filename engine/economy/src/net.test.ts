import { describe, expect, it } from 'vitest';

import { ASSET_KINDS, ENGINE_CONTAINERS, assertLedgerDelta, assetKey, isUniqueMint, netDeltas, netHoldings, uniqueMint } from './index.ts';
import type { LedgerDelta } from './index.ts';

const gold = { kind: 'currency', currency: 'gold' } as const;
const herb = { kind: 'stack', item: 'herb' } as const;

describe('assetKey', () => {
  it('is canonical per kind', () => {
    expect(assetKey(gold)).toBe('currency:gold');
    expect(assetKey(herb)).toBe('stack:herb');
    expect(assetKey({ kind: 'unique', itemId: 'i1' })).toBe('unique:i1');
    expect(assetKey(uniqueMint('item:sword'))).toBe('unique_mint:item:sword');
    expect(ASSET_KINDS).toEqual(['stack', 'currency', 'unique', 'unique_mint']);
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

  it('enforces one instance per unique delta', () => {
    const one = { kind: 'unique', itemId: 'i1' } as const;
    expect(() => assertLedgerDelta({ actorId: 'a', asset: one, qty: 1, from: 'inventory', to: 'equipped' })).not.toThrow();
    expect(() => assertLedgerDelta({ actorId: 'a', asset: one, qty: -1 })).not.toThrow();
    expect(() => assertLedgerDelta({ actorId: 'a', asset: one, qty: 2 })).toThrow(RangeError);
  });

  it('accepts unique mints only as grants of at least one instance', () => {
    const sword = uniqueMint('item:sword');
    expect(isUniqueMint(sword)).toBe(true);
    expect(isUniqueMint(gold)).toBe(false);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: sword, qty: 2, to: 'inventory' })).not.toThrow();
    expect(() => assertLedgerDelta({ actorId: 'a', asset: sword, qty: 1 })).not.toThrow();
    expect(() => assertLedgerDelta({ actorId: 'a', asset: sword, qty: 0, to: 'inventory' })).toThrow(RangeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: sword, qty: -1, to: 'inventory' })).toThrow(RangeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: sword, qty: 1, from: 'inventory', to: 'escrow' })).toThrow(RangeError);
    expect(() => assertLedgerDelta({ actorId: 'a', asset: { kind: 'unique_mint', item: '' }, qty: 1 })).toThrow(TypeError);
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

describe('unique mints in net helpers', () => {
  it('count minted instances per item, separately from stacks of the same item', () => {
    const sword = uniqueMint('item:sword');
    const deltas: LedgerDelta[] = [
      { actorId: 'a', asset: sword, qty: 1, to: 'inventory' },
      { actorId: 'a', asset: { kind: 'stack', item: 'item:sword' }, qty: 3, to: 'inventory' },
      { actorId: 'a', asset: sword, qty: 2, to: 'inventory' },
    ];
    expect(netDeltas(deltas)).toEqual([
      { actorId: 'a', asset: { kind: 'stack', item: 'item:sword' }, container: 'inventory', qty: 3 },
      { actorId: 'a', asset: sword, container: 'inventory', qty: 3 },
    ]);
    expect(netHoldings(deltas).map((h) => [assetKey(h.asset), h.qty])).toEqual([
      ['stack:item:sword', 3],
      ['unique_mint:item:sword', 3],
    ]);
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
