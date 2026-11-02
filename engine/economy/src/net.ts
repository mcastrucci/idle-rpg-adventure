/** Pure aggregation helpers over {@link LedgerDelta} lists (used by estimates, reveal aggregates and tests). */

import { assertInt } from '@engine/sim-core';

import type { AssetRef, Container, LedgerDelta } from './types.ts';

/** Canonical string key of an asset, e.g. `currency:gold`, `stack:herb`, `unique:it_42`, `unique_mint:item:sword`. */
export function assetKey(asset: AssetRef): string {
  switch (asset.kind) {
    case 'stack':
      return `stack:${asset.item}`;
    case 'currency':
      return `currency:${asset.currency}`;
    case 'unique':
      return `unique:${asset.itemId}`;
    case 'unique_mint':
      return `unique_mint:${asset.item}`;
  }
}

/** Net change of one asset in one container of one actor. `container: null` = the ledger's default container. */
export interface NetDelta {
  readonly actorId: string;
  readonly asset: AssetRef;
  readonly container: Container | null;
  /** Signed safe integer, never 0. */
  readonly qty: number;
}

/** Net change of one asset for one actor across all containers (moves between containers cancel out). */
export interface NetHolding {
  readonly actorId: string;
  readonly asset: AssetRef;
  /** Signed safe integer, never 0. */
  readonly qty: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addChecked(a: number, b: number): number {
  const sum = a + b;
  assertInt(sum, 'net quantity');
  return sum;
}

/**
 * Throws unless `delta` is well-formed: non-empty actor, known asset kind with a non-empty ID, safe-integer `qty`,
 * non-empty containers; a `unique` delta moves exactly one instance (`qty` ±1); a `unique_mint` delta is a grant of
 * `qty ≥ 1` new instances without `from`.
 */
export function assertLedgerDelta(delta: LedgerDelta): void {
  if (typeof delta.actorId !== 'string' || delta.actorId === '') throw new TypeError('delta.actorId must be a non-empty string');
  assertInt(delta.qty, 'delta.qty');
  const asset = delta.asset as unknown as Record<string, unknown> | null;
  const idField = asset === null || typeof asset !== 'object' ? undefined : ASSET_ID_FIELD[String(asset['kind'])];
  if (idField === undefined || asset === null) throw new TypeError('delta.asset has an unknown kind');
  if (typeof asset[idField] !== 'string' || asset[idField] === '') {
    throw new TypeError(`delta.asset.${idField} must be a non-empty string`);
  }
  for (const c of [delta.from, delta.to]) {
    if (c !== undefined && (typeof c !== 'string' || c === '')) throw new TypeError('containers must be non-empty strings');
  }
  if (asset['kind'] === 'unique' && delta.qty !== 1 && delta.qty !== -1) throw new RangeError('a unique delta moves exactly one instance (qty ±1)');
  if (asset['kind'] === 'unique_mint') {
    if (delta.qty < 1) throw new RangeError('a unique_mint delta mints at least one instance (qty >= 1)');
    if (delta.from !== undefined) throw new RangeError('a unique_mint delta is a grant (no from)');
  }
}

const ASSET_ID_FIELD: Readonly<Record<string, string>> = { stack: 'item', currency: 'currency', unique: 'itemId', unique_mint: 'item' };

/** `{ kind: 'unique_mint', item }`: new unique instances of item definition `item` (grant `qty` instances). */
export function uniqueMint(item: string): AssetRef {
  return { kind: 'unique_mint', item };
}

/** True for assets that are minted as new unique instances (`unique_mint`). */
export function isUniqueMint(asset: AssetRef): asset is Extract<AssetRef, { kind: 'unique_mint' }> {
  return asset.kind === 'unique_mint';
}

/**
 * Aggregates deltas per `(actorId, asset, container)`: `from` loses `qty`, `to` gains `qty`, a delta with neither
 * changes the default container (`null`). Zero results are dropped. Output is sorted by actorId, asset key, then
 * container (`null` first), so it is deterministic regardless of input order.
 */
export function netDeltas(deltas: readonly LedgerDelta[]): NetDelta[] {
  const acc = new Map<string, { actorId: string; asset: AssetRef; container: Container | null; qty: number }>();
  const add = (d: LedgerDelta, container: Container | null, qty: number): void => {
    const key = JSON.stringify([d.actorId, assetKey(d.asset), container]);
    const entry = acc.get(key);
    if (entry === undefined) acc.set(key, { actorId: d.actorId, asset: d.asset, container, qty: addChecked(0, qty) });
    else entry.qty = addChecked(entry.qty, qty);
  };
  for (const d of deltas) {
    assertLedgerDelta(d);
    if (d.from === undefined && d.to === undefined) {
      add(d, null, d.qty);
      continue;
    }
    if (d.from !== undefined) add(d, d.from, -d.qty);
    if (d.to !== undefined) add(d, d.to, d.qty);
  }
  return [...acc.values()]
    .filter((e) => e.qty !== 0)
    .sort(
      (a, b) =>
        cmp(a.actorId, b.actorId) ||
        cmp(assetKey(a.asset), assetKey(b.asset)) ||
        (a.container === b.container ? 0 : a.container === null ? -1 : b.container === null ? 1 : cmp(a.container, b.container)),
    )
    .map((e) => ({ actorId: e.actorId, asset: e.asset, container: e.container, qty: e.qty }));
}

/**
 * Net change in holdings per `(actorId, asset)`, summed over every container: moves between containers cancel out,
 * grants count positive, consumption negative. Zero results are dropped; sorted by actorId then asset key.
 */
export function netHoldings(deltas: readonly LedgerDelta[]): NetHolding[] {
  const acc = new Map<string, { actorId: string; asset: AssetRef; qty: number }>();
  for (const n of netDeltas(deltas)) {
    const key = JSON.stringify([n.actorId, assetKey(n.asset)]);
    const entry = acc.get(key);
    if (entry === undefined) acc.set(key, { actorId: n.actorId, asset: n.asset, qty: n.qty });
    else entry.qty = addChecked(entry.qty, n.qty);
  }
  return [...acc.values()]
    .filter((e) => e.qty !== 0)
    .sort((a, b) => cmp(a.actorId, b.actorId) || cmp(assetKey(a.asset), assetKey(b.asset)));
}
