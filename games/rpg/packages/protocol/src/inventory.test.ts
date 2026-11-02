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
});
