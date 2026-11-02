import { netDeltas } from '@engine/economy';
import { describe, expect, it } from 'vitest';

import { buildPurchaseDeltas } from './service.ts';

describe('merchant purchase ledger batch', () => {
  it('debits gold and grants the purchased consumable in inventory', () => {
    const actorId = '5f4f9b4e-5aa3-4a2d-a357-e01626e87283';
    expect(netDeltas(buildPurchaseDeltas(actorId, 'item:minor_healing_potion', 1, 12))).toEqual([
      { actorId, asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: -12 },
      { actorId, asset: { kind: 'stack', item: 'item:minor_healing_potion' }, container: 'inventory', qty: 1 },
    ]);
  });
});
