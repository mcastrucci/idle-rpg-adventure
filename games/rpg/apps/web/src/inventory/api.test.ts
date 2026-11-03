import { describe, expect, it } from 'vitest';

import { buyInventoryCommand, claimStarterKitCommand, equipInventoryCommand, moveInventoryCommand, sellMaterialCommand, unequipInventoryCommand } from './api.ts';

const actorId = 'a2f4acdd-23a5-47b3-9fc6-dc2bf87d61e6';
const itemId = 'c20ce3a7-cf7a-44bc-8d82-6a4370c3a02c';
const commandId = 'c9c8e4eb-65ae-4822-b4b1-d2c05be3969d';

describe('inventory command builders', () => {
  it('targets the inventory command route with existing server operation payloads', () => {
    const makeId = () => commandId;
    expect(equipInventoryCommand(actorId, itemId, 'weapon', makeId).envelope).toMatchObject({ command_id: commandId,
      operation: 'inventory.equip', payload: { actorId, itemId, slot: 'weapon' } });
    expect(unequipInventoryCommand(actorId, itemId, makeId).envelope).toMatchObject({ operation: 'inventory.unequip', payload: { actorId, itemId } });
    expect(moveInventoryCommand(actorId, { item: 'item:minor_healing_potion', quantity: 2, from: 'inventory', to: 'storage' }, makeId).envelope)
      .toMatchObject({ operation: 'inventory.move', payload: { actorId, item: 'item:minor_healing_potion', quantity: 2, from: 'inventory', to: 'storage' } });
    expect(buyInventoryCommand(actorId, 'offer:minor_healing_potion', 1, makeId).envelope)
      .toMatchObject({ operation: 'inventory.buy', payload: { actorId, offerId: 'offer:minor_healing_potion', quantity: 1 } });
    expect(sellMaterialCommand(actorId, 'item:boar_hide', 3, makeId)).toMatchObject({ method: 'POST', path: `/characters/${actorId}/inventory/commands`,
      envelope: { command_id: commandId, operation: 'inventory.sellMaterial', payload: { actorId, item: 'item:boar_hide', quantity: 3 } } });
    expect(claimStarterKitCommand(actorId, makeId)).toMatchObject({ method: 'POST', path: `/characters/${actorId}/inventory/commands`,
      envelope: { command_id: commandId, operation: 'inventory.claimStarterKit', payload: { actorId } } });
  });
});
