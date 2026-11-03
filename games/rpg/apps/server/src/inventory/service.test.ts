import { netDeltas } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { buildMaterialSaleDeltas, buildPurchaseDeltas, merchantCatalog, STARTER_KIT_ITEMS, validateStarterKitContent } from './service.ts';

describe('merchant purchase ledger batch', () => {
  it('debits gold and grants the purchased consumable in inventory', () => {
    const actorId = '5f4f9b4e-5aa3-4a2d-a357-e01626e87283';
    expect(netDeltas(buildPurchaseDeltas(actorId, 'item:minor_healing_potion', 1, 12))).toEqual([
      { actorId, asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: -12 },
      { actorId, asset: { kind: 'stack', item: 'item:minor_healing_potion' }, container: 'inventory', qty: 1 },
    ]);
  });
});

describe('material sale ledger batch and offers', () => {
  it('debits the requested banked stack and credits authored-value gold in the same inventory batch', () => {
    const actorId = '5f4f9b4e-5aa3-4a2d-a357-e01626e87283';
    expect(netDeltas(buildMaterialSaleDeltas(actorId, 'item:amber_resin', 3, 9))).toEqual([
      { actorId, asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: 9 },
      { actorId, asset: { kind: 'stack', item: 'item:amber_resin' }, container: 'inventory', qty: -3 },
    ]);
  });

  it('lists only positive, representable, stackable material values in stable item order', () => {
    const content = { collections: { merchants: [], items: [
      { id: 'item:z_resin', kind: 'material', value: 3, stackable: true },
      { id: 'item:a_scrap', kind: 'material', value: 1, stackable: true },
      { id: 'item:equipment', kind: 'equipment', value: 4, stackable: false },
      { id: 'item:zero', kind: 'material', value: 0, stackable: true },
      { id: 'item:unique', kind: 'material', value: 5, stackable: false },
      { id: 'item:oversize', kind: 'material', value: 2_147_483_648, stackable: true },
    ] } } as never;
    expect(merchantCatalog(content).sellOffers).toEqual([
      { item: 'item:a_scrap', unitPrice: { currency: 'gold', amount: 1 } },
      { item: 'item:z_resin', unitPrice: { currency: 'gold', amount: 3 } },
    ]);
  });
});

describe('starter kit content gate', () => {
  const valid = { collections: { items: [
    { id: STARTER_KIT_ITEMS[0], kind: 'equipment', stackable: false, slot: 'weapon' },
    { id: STARTER_KIT_ITEMS[1], kind: 'equipment', stackable: false, slot: 'chest' },
    { id: STARTER_KIT_ITEMS[2], kind: 'equipment', stackable: false, slot: 'offhand' },
  ] } } as never;

  it('requires all three exact equipment definitions with expected slots', () => {
    expect(() => validateStarterKitContent(valid)).not.toThrow();
    expect(() => validateStarterKitContent({ collections: { items: [] } } as never)).toThrow('starter_kit_unavailable');
    expect(() => validateStarterKitContent({ collections: { items: [
      { id: STARTER_KIT_ITEMS[0], kind: 'equipment', stackable: true, slot: 'weapon' },
      { id: STARTER_KIT_ITEMS[1], kind: 'equipment', stackable: false, slot: 'chest' },
      { id: STARTER_KIT_ITEMS[2], kind: 'equipment', stackable: false, slot: 'offhand' },
    ] } } as never)).toThrow('starter_kit_unavailable');
  });
});
