import { and, eq, sql } from 'drizzle-orm';
import type { LedgerDelta } from '@engine/economy';
import { ActorError, applyLedgerDeltas, getHoldings, itemInstances, ledgerBatches, requireSanctuaryMutation, actors } from '@engine/server-kit';
import type { ApplyLedgerOptions } from '@engine/server-kit';
import type { ActorTransaction, LoadedContent } from '@engine/server-kit';
import type { MerchantOffer, Item } from '@rpg/rpg-schema';
import { EQUIPMENT_SLOTS, createRpgPredicateRegistry } from '@rpg/rpg-schema';
import { evaluateCompletion, validateWorld } from '@engine/world';
import { z } from 'zod';

import { characters } from '../characters/schema.ts';
import { RPG_GAME_ID } from '../characters/service.ts';
import { buildStatSummary } from '../characters/stat-summary.ts';
import { readRpgEvalContext } from '../expeditions/progress.ts';

const UUID = z.uuid().transform(value => value.toLowerCase());
const Slot = z.enum(EQUIPMENT_SLOTS);
export const EquipPayloadSchema = z.strictObject({ actorId: UUID, itemId: UUID, slot: Slot });
export const UnequipPayloadSchema = z.strictObject({ actorId: UUID, itemId: UUID });
const Containers = z.enum(['inventory', 'storage']);
export const MovePayloadSchema = z.union([
  z.strictObject({ actorId: UUID, itemId: UUID, from: Containers, to: Containers }).refine(value => value.from !== value.to),
  z.strictObject({ actorId: UUID, item: z.string().regex(/^item:[a-z0-9_.]+$/), quantity: z.number().int().min(1).max(10_000), from: Containers, to: Containers }).refine(value => value.from !== value.to),
]);
export const BuyPayloadSchema = z.strictObject({ actorId: UUID, offerId: z.string().regex(/^offer:[a-z0-9_.]+$/), quantity: z.number().int().min(1).max(100) });
export const SellMaterialPayloadSchema = z.strictObject({ actorId: UUID, item: z.string().regex(/^item:[a-z0-9_.]+$/), quantity: z.number().int().min(1).max(10_000) });
export const ClaimStarterKitPayloadSchema = z.strictObject({ actorId: UUID });
export const STARTER_KIT_ITEMS = ['item:rusty_sword', 'item:padded_vest', 'item:wooden_buckler'] as const;
const STARTER_KIT_SOURCE = 'rpg_starter_kit';
const STARTER_KIT_SLOTS = ['weapon', 'chest', 'offhand'] as const;

export function validateStarterKitContent(content: LoadedContent): void {
  for (const [index, id] of STARTER_KIT_ITEMS.entries()) {
    const item = getItem(content, id);
    if (!item || item.kind !== 'equipment' || item.stackable || item.slot !== STARTER_KIT_SLOTS[index]) {
      throw new InventoryError('starter_kit_unavailable', 409);
    }
  }
}

export class InventoryError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 409) { super(code); this.code = code; this.statusCode = statusCode; }
}

function items(content: LoadedContent): readonly Item[] { return (content.collections.items ?? []) as unknown as readonly Item[]; }
function merchants(content: LoadedContent): readonly { id: string; offers: readonly MerchantOffer[] }[] {
  return (content.collections.merchants ?? []) as unknown as readonly { id: string; offers: readonly MerchantOffer[] }[];
}
function getItem(content: LoadedContent, itemId: string): Item | undefined { return items(content).find(item => item.id === itemId); }
function itemOffer(content: LoadedContent, offerId: string): MerchantOffer | undefined {
  const matches = merchants(content).flatMap(merchant => merchant.offers.filter(row => row.id === offerId));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Purchase batch convention: positive qty debited from a container; grants are positive qty to a container. */
export function buildPurchaseDeltas(actorId: string, itemId: string, quantity: number, price: number): LedgerDelta[] {
  const deltas: LedgerDelta[] = [
    { actorId, asset: { kind: 'currency', currency: 'gold' }, qty: price, from: 'inventory' },
    { actorId, asset: { kind: 'stack', item: itemId }, qty: quantity, to: 'inventory' },
  ];
  return deltas;
}

/** Material sale batch debits only inventory stacks and credits only inventory gold. */
export function buildMaterialSaleDeltas(actorId: string, itemId: string, quantity: number, proceeds: number): LedgerDelta[] {
  return [
    { actorId, asset: { kind: 'stack', item: itemId }, qty: quantity, from: 'inventory' },
    { actorId, asset: { kind: 'currency', currency: 'gold' }, qty: proceeds, to: 'inventory' },
  ];
}

export async function inventorySnapshot(tx: ActorTransaction, accountId: string, actorId: string, content: LoadedContent) {
  // Read-only snapshot: ownership is enforced in SQL without the mutation lock used by requireOwnedActor.
  const [actor] = await tx.select({ actorId: actors.actorId, version: actors.version, activityState: actors.activityState })
    .from(actors).where(and(eq(actors.actorId, actorId.toLowerCase()), eq(actors.accountId, accountId), eq(actors.gameId, RPG_GAME_ID)));
  if (!actor) throw new ActorError('not_found', 404);
  const holdings = await getHoldings(tx, actor.actorId);
  const [character] = await tx.select().from(characters).where(eq(characters.actorId, actor.actorId));
  if (!character) throw new InventoryError('not_found', 404);
  const progress = await readRpgEvalContext(tx, actor.actorId, character.level, holdings);
  const [starterKitBatch] = await tx.select({ sourceId: ledgerBatches.sourceId }).from(ledgerBatches)
    .where(and(eq(ledgerBatches.sourceType, STARTER_KIT_SOURCE), eq(ledgerBatches.sourceId, actor.actorId)));
  const catalogItems = items(content);
  const statSummary = buildStatSummary(character.level, character.attributes as never, holdings, content);
  return { actorId: actor.actorId, holdings, actorVersion: actor.version, activityState: actor.activityState,
    level: character.level, attributes: character.attributes, completedAreas: [...progress.actor.completedAreas],
    catalog: { contentHash: content.contentHash, items: catalogItems.map(item => ({ id: item.id, kind: item.kind,
      ...(item.nameKey === undefined ? {} : { nameKey: item.nameKey }),
      ...(item.kind === 'equipment' ? { slot: item.slot } : {}),
      ...('levelRequired' in item && item.levelRequired !== undefined ? { levelRequired: item.levelRequired } : {}),
      ...(item.kind === 'equipment' && item.stats && Object.keys(item.stats).length ? { stats: item.stats } : {}),
      stackable: item.stackable })) },
    starterKit: { claimed: Boolean(starterKitBatch), items: [...STARTER_KIT_ITEMS] },
    ...(statSummary === undefined ? {} : { statSummary }) };
}

/** Public offer catalog is an explicit content allowlist; purchase gates are re-evaluated from persisted progress. */
export function merchantCatalog(content: LoadedContent) {
  return { merchants: merchants(content).map(merchant => ({ id: merchant.id,
    offers: merchant.offers.map(offer => ({ id: offer.id, item: offer.item, buyPrice: offer.buyPrice,
      stock: offer.stock, ...(offer.requiresCompletedArea ? { requiresCompletedArea: offer.requiresCompletedArea } : {}) })) })),
    sellOffers: items(content).filter(item => item.kind === 'material' && item.stackable && Number.isSafeInteger(item.value) && item.value > 0 && item.value <= 2_147_483_647)
      .map(item => ({ item: item.id, unitPrice: { currency: 'gold' as const, amount: item.value } }))
      .sort((a, b) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0) };
}

export function createInventoryService(tx: ActorTransaction, content: LoadedContent) {
  async function mutate(accountId: string, commandId: string, actorId: string, batch: Parameters<typeof applyLedgerDeltas>[2], equipment?: ApplyLedgerOptions['equipment']) {
    const actor = await requireSanctuaryMutation(tx, actorId, accountId, RPG_GAME_ID);
    await applyLedgerDeltas(tx, { type: 'rpg_command', id: `${accountId}:${commandId}` }, batch, equipment ? { equipment } : {});
    const [versioned] = await tx.update(actors).set({ version: sql`${actors.version} + 1` }).where(eq(actors.actorId, actor.actorId)).returning({ version: actors.version });
    if (!versioned) throw new InventoryError('not_found', 404);
    return { actorId: actor.actorId, version: versioned.version };
  }
  return {
    async claimStarterKit(accountId: string, actorId: string) {
      const actor = await requireSanctuaryMutation(tx, actorId, accountId, RPG_GAME_ID);
      const [existingBatch] = await tx.select({ sourceId: ledgerBatches.sourceId }).from(ledgerBatches)
        .where(and(eq(ledgerBatches.sourceType, STARTER_KIT_SOURCE), eq(ledgerBatches.sourceId, actor.actorId)));
      if (!existingBatch) validateStarterKitContent(content);
      const deltas: LedgerDelta[] = STARTER_KIT_ITEMS.map(item => ({
        actorId: actor.actorId, asset: { kind: 'unique_mint', item }, qty: 1, to: 'inventory',
      }));
      const { applied } = await applyLedgerDeltas(tx, { type: STARTER_KIT_SOURCE, id: actor.actorId }, deltas);
      if (!applied) return { actorId: actor.actorId, version: actor.version };
      const [versioned] = await tx.update(actors).set({ version: sql`${actors.version} + 1` }).where(eq(actors.actorId, actor.actorId)).returning({ version: actors.version });
      if (!versioned) throw new InventoryError('not_found', 404);
      return { actorId: actor.actorId, version: versioned.version };
    },
    async equip(accountId: string, commandId: string, input: z.output<typeof EquipPayloadSchema>) {
      const actor = await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const [character] = await tx.select().from(characters).where(eq(characters.actorId, actor.actorId));
      const [owned] = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, actor.actorId), eq(itemInstances.id, input.itemId))).for('update');
      if (!owned || owned.container !== 'inventory') throw new InventoryError('item_not_owned');
      const definition = getItem(content, owned.definition);
      if (!definition || definition.kind !== 'equipment') throw new InventoryError('invalid_equipment', 400);
      if (definition.slot !== input.slot) throw new InventoryError('invalid_slot', 400);
      if (!character || (definition.levelRequired ?? 1) > character.level) throw new InventoryError('level_required');
      const [equipped] = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, actor.actorId), eq(itemInstances.container, 'equipped'), eq(itemInstances.slot, input.slot))).for('update');
      if (equipped?.id === owned.id) return { actorId: actor.actorId, version: actor.version };
      const batch = [
        ...(equipped ? [{ actorId: actor.actorId, asset: { kind: 'unique' as const, itemId: equipped.id }, qty: 1, from: 'equipped', to: 'inventory' }] : []),
        { actorId: actor.actorId, asset: { kind: 'unique' as const, itemId: owned.id }, qty: 1, from: 'inventory', to: 'equipped' },
      ];
      return mutate(accountId, commandId, actor.actorId, batch, { actorId: actor.actorId, itemId: owned.id, slot: input.slot });
    },
    async unequip(accountId: string, commandId: string, input: z.output<typeof UnequipPayloadSchema>) {
      const actor = await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const [owned] = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, actor.actorId), eq(itemInstances.id, input.itemId))).for('update');
      if (!owned || owned.container !== 'equipped') throw new InventoryError('item_not_owned');
      return mutate(accountId, commandId, actor.actorId, [{ actorId: actor.actorId, asset: { kind: 'unique', itemId: owned.id }, qty: 1, from: 'equipped', to: 'inventory' }]);
    },
    async move(accountId: string, commandId: string, input: z.output<typeof MovePayloadSchema>) {
      const actor = await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      if ('itemId' in input) {
        const [owned] = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, actor.actorId), eq(itemInstances.id, input.itemId))).for('update');
        if (!owned || owned.container !== input.from) throw new InventoryError('item_not_owned');
        return mutate(accountId, commandId, actor.actorId, [{ actorId: actor.actorId, asset: { kind: 'unique', itemId: owned.id }, qty: 1, from: input.from, to: input.to }]);
      }
      const definition = getItem(content, input.item);
      if (definition && (!('stackable' in definition) || !definition.stackable)) throw new InventoryError('item_not_owned');
      return mutate(accountId, commandId, actor.actorId, [{ actorId: actor.actorId, asset: { kind: 'stack', item: input.item }, qty: input.quantity, from: input.from, to: input.to }]);
    },
    async buy(accountId: string, commandId: string, input: z.output<typeof BuyPayloadSchema>) {
      const actor = await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const offer = itemOffer(content, input.offerId);
      if (!offer) throw new InventoryError('offer_not_found', 404);
      const definition = getItem(content, offer.item);
      if (!definition || definition.kind !== 'consumable' || !definition.stackable) throw new InventoryError('invalid_offer', 400);
      const price = offer.buyPrice.amount * input.quantity;
      if (!Number.isSafeInteger(price) || price > 2_147_483_647) throw new InventoryError('invalid_offer', 400);
      if (offer.requiresCompletedArea) {
        const [character] = await tx.select().from(characters).where(eq(characters.actorId, actor.actorId));
        if (!character) throw new InventoryError('not_found', 404);
        const worldResult = validateWorld(content.world, createRpgPredicateRegistry());
        if (!worldResult.ok) throw new Error('RPG content world failed runtime validation');
        const area = worldResult.world.areas.find(row => row.id === offer.requiresCompletedArea);
        if (!area) throw new InventoryError('invalid_offer', 400);
        const evalContext = await readRpgEvalContext(tx, actor.actorId, character.level, await getHoldings(tx, actor.actorId));
        const status = evaluateCompletion(area, worldResult.world.locations, evalContext, createRpgPredicateRegistry());
        if (!status.recorded) throw new InventoryError('conquest_required');
      }
      return mutate(accountId, commandId, actor.actorId, buildPurchaseDeltas(actor.actorId, offer.item, input.quantity, price));
    },
    async sellMaterial(accountId: string, commandId: string, input: z.output<typeof SellMaterialPayloadSchema>) {
      const actor = await requireSanctuaryMutation(tx, input.actorId, accountId, RPG_GAME_ID);
      const definition = getItem(content, input.item);
      if (!definition || definition.kind !== 'material' || !definition.stackable || !Number.isSafeInteger(definition.value) || definition.value <= 0) {
        throw new InventoryError('invalid_sell_item', 400);
      }
      const proceeds = definition.value * input.quantity;
      if (!Number.isSafeInteger(proceeds) || proceeds <= 0 || proceeds > 2_147_483_647) throw new InventoryError('invalid_sell_quantity', 400);
      const currentGold = (await getHoldings(tx, actor.actorId)).find(holding => holding.asset.kind === 'currency' && holding.asset.currency === 'gold' && holding.container === 'inventory')?.qty ?? 0;
      if (currentGold + proceeds > 2_147_483_647) throw new InventoryError('gold_overflow');
      return mutate(accountId, commandId, actor.actorId, buildMaterialSaleDeltas(actor.actorId, input.item, input.quantity, proceeds));
    },
  };
}
