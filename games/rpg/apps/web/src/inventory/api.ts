import { parseInventorySnapshotDto, parseMerchantCatalogDto } from '@rpg/protocol';
import type { InventorySlot, InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';

import type { ApiClient } from '../api/http.ts';
import { buildEnvelope, sendCommand } from '../api/commands.ts';
import type { CommandPayload, CommandRequest, SendCommandOptions } from '../api/commands.ts';

export function getInventory(api: ApiClient, actorId: string): Promise<InventorySnapshotDto> {
  return api.request<unknown>('GET', `/characters/${encodeURIComponent(actorId)}/inventory`).then(parseInventorySnapshotDto);
}

export function getMerchantCatalog(api: ApiClient): Promise<MerchantCatalogDto> {
  return api.request<unknown>('GET', '/merchant').then(parseMerchantCatalogDto);
}

type MovePayload = { readonly itemId: string; readonly from: 'inventory' | 'storage'; readonly to: 'inventory' | 'storage' } |
  { readonly item: string; readonly quantity: number; readonly from: 'inventory' | 'storage'; readonly to: 'inventory' | 'storage' };
function command(operation: 'inventory.equip' | 'inventory.unequip' | 'inventory.move' | 'inventory.buy' | 'inventory.claimStarterKit',
  actorId: string, payload: CommandPayload, newId?: () => string): CommandRequest<{ actorId: string; version: number }> {
  return { method: 'POST', path: `/characters/${encodeURIComponent(actorId)}/inventory/commands`,
    envelope: buildEnvelope(operation, { actorId, ...payload }, newId) };
}

export function equipInventoryCommand(actorId: string, itemId: string, slot: InventorySlot, newId?: () => string) {
  return command('inventory.equip', actorId, { itemId, slot }, newId);
}
export function unequipInventoryCommand(actorId: string, itemId: string, newId?: () => string) {
  return command('inventory.unequip', actorId, { itemId }, newId);
}
export function moveInventoryCommand(actorId: string, payload: MovePayload, newId?: () => string) {
  return command('inventory.move', actorId, payload as CommandPayload, newId);
}
export function buyInventoryCommand(actorId: string, offerId: string, quantity: number, newId?: () => string) {
  return command('inventory.buy', actorId, { offerId, quantity }, newId);
}
export function claimStarterKitCommand(actorId: string, newId?: () => string) {
  return command('inventory.claimStarterKit', actorId, {}, newId);
}

export function sendInventoryCommand(api: ApiClient, request: CommandRequest<{ actorId: string; version: number }>, options?: SendCommandOptions) {
  return sendCommand(api, request, options);
}
