import { describe, expect, it } from 'vitest';

import { parseInventorySnapshotDto, parseMerchantCatalogDto } from './inventory.ts';

const actorId = 'a2f4acdd-23a5-47b3-9fc6-dc2bf87d61e6';
const snapshot = {
  actorId, holdings: [{ asset: { kind: 'unique', itemId: 'c20ce3a7-cf7a-44bc-8d82-6a4370c3a02c' }, container: 'inventory', qty: 1,
    itemId: 'c20ce3a7-cf7a-44bc-8d82-6a4370c3a02c', definition: 'item:rusty_sword', slot: null, rolls: { power: 7 } }],
  actorVersion: 4, activityState: 'none', level: 1, attributes: { STR: 5, AGI: 5, INT: 5, VIT: 5, SPI: 5 }, completedAreas: [],
  catalog: { contentHash: 'a'.repeat(64), items: [{ id: 'item:rusty_sword', kind: 'equipment', nameKey: 'item.rusty_sword', slot: 'weapon', stats: { power: 2 }, stackable: false }] },
};

describe('inventory protocol DTOs', () => {
  it('parses and freezes only the published inventory projection', () => {
    const parsed = parseInventorySnapshotDto(snapshot);
    expect(parsed.actorId).toBe(actorId);
    expect(parsed.catalog.items[0]?.stats).toEqual({ power: 2 });
    expect(parsed.holdings[0]?.rolls).toEqual({ power: 7 });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts optional starter kit status and validates it when present', () => {
    expect(parseInventorySnapshotDto(snapshot).starterKit).toBeUndefined();
    expect(parseInventorySnapshotDto({ ...snapshot, starterKit: { claimed: false, items: ['item:rusty_sword'] } }).starterKit)
      .toEqual({ claimed: false, items: ['item:rusty_sword'] });
    expect(() => parseInventorySnapshotDto({ ...snapshot, starterKit: { claimed: 'no', items: [] } })).toThrow('invalid starter kit state');
    expect(() => parseInventorySnapshotDto({ ...snapshot, starterKit: { claimed: false, items: [4] } })).toThrow('invalid starter kit state');
  });

  it('accepts an optional additive stat summary and rejects malformed ones', () => {
    const itemId = 'c20ce3a7-cf7a-44bc-8d82-6a4370c3a02c';
    const summary = { level: 1, items: [{ itemId, definition: 'item:rusty_sword', nameKey: 'item.rusty_sword', slot: 'weapon' }],
      rows: [{ key: 'physicalPower', base: 2, equipment: 3, total: 5, contributions: [{ itemId, value: 3 }] },
        { key: 'actionIntervalTicks', base: 10, equipment: -1, total: 9, contributions: [] }] };
    expect(parseInventorySnapshotDto(snapshot).statSummary).toBeUndefined();
    const parsed = parseInventorySnapshotDto({ ...snapshot, statSummary: summary }).statSummary;
    expect(parsed?.rows[0]).toEqual(summary.rows[0]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseInventorySnapshotDto({ ...snapshot, statSummary: { ...summary, extra: 1 } })).toThrow();
    expect(() => parseInventorySnapshotDto({ ...snapshot, statSummary: { ...summary, rows: [{ ...summary.rows[0], key: 'bogus' }] } })).toThrow('invalid stat summary row');
    expect(() => parseInventorySnapshotDto({ ...snapshot, statSummary: { ...summary, rows: [{ ...summary.rows[0], contributions: [{ itemId: 'other', value: 1 }] }] } }))
      .toThrow('invalid stat summary contribution');
  });

  it('rejects unknown or secret catalog fields', () => {
    const unsafe = structuredClone(snapshot) as { catalog: { items: Record<string, unknown>[]; contentHash: string } };
    const firstItem = unsafe.catalog.items[0];
    if (!firstItem) throw new Error('inventory fixture has no catalog item');
    firstItem['use'] = [{ effect: 'secret' }];
    expect(() => parseInventorySnapshotDto(unsafe)).toThrow();
  });

  it('rejects non-equipment stat semantics in the catalog', () => {
    const malformed = structuredClone(snapshot) as { catalog: { items: Record<string, unknown>[]; contentHash: string } };
    malformed.catalog.items[0] = { id: 'item:minor_healing_potion', kind: 'consumable', stackable: true, stats: { power: 1 } };
    expect(() => parseInventorySnapshotDto(malformed)).toThrow('invalid non-equipment fields');
  });

  it('rejects unique holdings whose quantity or instance identity conflicts', () => {
    const wrongId = structuredClone(snapshot) as { holdings: { qty: number; itemId: string }[] };
    const uniqueWithWrongId = wrongId.holdings[0];
    if (!uniqueWithWrongId) throw new Error('inventory fixture has no unique holding');
    uniqueWithWrongId.itemId = 'cd90c47f-c3b2-4db3-b20a-b8135caf114b';
    expect(() => parseInventorySnapshotDto(wrongId)).toThrow('unique holding identity mismatch');
    const wrongQuantity = structuredClone(snapshot) as { holdings: { qty: number; itemId: string }[] };
    const uniqueWithWrongQuantity = wrongQuantity.holdings[0];
    if (!uniqueWithWrongQuantity) throw new Error('inventory fixture has no unique holding');
    uniqueWithWrongQuantity.qty = 2;
    expect(() => parseInventorySnapshotDto(wrongQuantity)).toThrow('unique holding identity mismatch');
  });

  it('validates merchant price and recorded area gate fields', () => {
    expect(parseMerchantCatalogDto({ merchants: [{ id: 'merchant:region_1', offers: [{ id: 'offer:healing_potion', item: 'item:minor_healing_potion',
      buyPrice: { currency: 'gold', amount: 40 }, stock: 'infinite', requiresCompletedArea: 'area:region_1' }] }] }).merchants[0]?.offers[0])
      .toMatchObject({ buyPrice: { currency: 'gold', amount: 40 }, requiresCompletedArea: 'area:region_1' });
    expect(() => parseMerchantCatalogDto({ merchants: [{ id: 'merchant:region_1', secret: 'bundle', offers: [] }] })).toThrow();
    expect(() => parseMerchantCatalogDto({ merchants: [{ id: 'merchant:region_1', offers: [{ id: 'offer:bad', item: 'item:minor_healing_potion',
      buyPrice: { currency: 'gold', amount: 0 }, stock: 'infinite' }] }] })).toThrow('invalid merchant offer');
  });

  it('keeps old merchant catalogs valid and exactly validates optional sorted sell offers', () => {
    const legacy = { merchants: [{ id: 'merchant:region_1', offers: [] }] };
    expect(parseMerchantCatalogDto(legacy)).toEqual(legacy);
    expect(parseMerchantCatalogDto({ ...legacy, sellOffers: [
      { item: 'item:amber_resin', unitPrice: { currency: 'gold', amount: 3 } },
    ] }).sellOffers).toEqual([{ item: 'item:amber_resin', unitPrice: { currency: 'gold', amount: 3 } }]);
    for (const sellOffers of [null, [{}], [{ item: 'item:x', unitPrice: { currency: 'silver', amount: 1 } }],
      [{ item: 'item:x', unitPrice: { currency: 'gold', amount: 0 } }],
      [{ item: 'item:x', unitPrice: { currency: 'gold', amount: 2_147_483_648 } }],
      [{ item: 'item:x', unitPrice: { currency: 'gold', amount: 1 }, secret: true }],
      [{ item: 'item:x', unitPrice: { currency: 'gold', amount: 1 } }, { item: 'item:x', unitPrice: { currency: 'gold', amount: 2 } }],
    ]) expect(() => parseMerchantCatalogDto({ ...legacy, sellOffers })).toThrow();
  });
});
