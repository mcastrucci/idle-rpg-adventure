/**
 * Ledger delta shapes of the idle simulators (ADR-0007: simulators emit data, only the ledger applies it).
 *
 * - Bag items: `{ asset: stack(item), qty, to: 'inventory' }` (grant). Equipment drops use the same stack shape; the
 *   ledger materialises non-stackable items into instances (see README, findings).
 * - Gold: `{ asset: currency('gold'), qty }` without containers (the ledger's default container for currencies).
 * - Consumables used: `{ asset: stack(item), qty, from: 'escrow' }` (burn from escrow).
 * - Escrow at start: `{ asset: stack(item), qty, from: 'inventory', to: 'escrow' }`.
 */
import { assetKey } from '@engine/economy';
import type { AssetRef, LedgerDelta } from '@engine/economy';
import { ESCROW_CONTAINER } from '@engine/expedition-kernel';

/** Where bag items are granted and where escrowed consumables come from / return to. */
export const INVENTORY = 'inventory';
export const ESCROW = ESCROW_CONTAINER;
/** Currency content ID of gold (data-model `currency_balances.currency`). */
export const GOLD_CURRENCY = 'gold';

export const stack = (item: string): AssetRef => ({ kind: 'stack', item });
export const GOLD: AssetRef = { kind: 'currency', currency: GOLD_CURRENCY };

/** True for a pure grant (nothing taken from a container): bag items and gold. */
export function isGrant(d: LedgerDelta): boolean {
  return d.from === undefined;
}

/**
 * Sums deltas with the same (actor, asset, from, to), in order of first appearance; drops zero sums. Net holdings and
 * container changes are unchanged, so it is a valid compaction for segments and settlements.
 */
export function mergeDeltas(deltas: readonly LedgerDelta[]): LedgerDelta[] {
  const acc = new Map<string, { d: LedgerDelta; qty: number }>();
  for (const d of deltas) {
    const key = JSON.stringify([d.actorId, assetKey(d.asset), d.from ?? null, d.to ?? null]);
    const e = acc.get(key);
    if (e === undefined) acc.set(key, { d, qty: d.qty });
    else e.qty += d.qty;
  }
  const out: LedgerDelta[] = [];
  for (const { d, qty } of acc.values()) {
    if (qty === 0) continue;
    out.push({
      actorId: d.actorId,
      asset: d.asset,
      qty,
      ...(d.from === undefined ? {} : { from: d.from }),
      ...(d.to === undefined ? {} : { to: d.to }),
    });
  }
  return out;
}
