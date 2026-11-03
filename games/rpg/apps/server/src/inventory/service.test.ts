import { netDeltas } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { buildPurchaseDeltas, STARTER_KIT_ITEMS, validateStarterKitContent } from './service.ts';

describe('merchant purchase ledger batch', () => {
  it('debits gold and grants the purchased consumable in inventory', () => {
    const actorId = '5f4f9b4e-5aa3-4a2d-a357-e01626e87283';
    expect(netDeltas(buildPurchaseDeltas(actorId, 'item:minor_healing_potion', 1, 12))).toEqual([
      { actorId, asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: -12 },
      { actorId, asset: { kind: 'stack', item: 'item:minor_healing_potion' }, container: 'inventory', qty: 1 },
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
