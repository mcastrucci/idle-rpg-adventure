import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { assertLedgerDelta, netDeltas } from '@engine/economy';
import type { AssetRef, Container, LedgerDelta } from '@engine/economy';
import { lockActors } from '../actors/service.ts';
import type { ActorTransaction } from '../actors/service.ts';
import { assetBalances, itemInstances, ledgerBatches, ledgerEntries } from './schema.ts';

export interface LedgerSource { readonly type: string; readonly id: string }
export interface LedgerActivity { readonly state: 'live' | 'expedition'; readonly id: string }
export interface ApplyLedgerOptions {
  readonly activity?: LedgerActivity;
  /** Optional slot assignment for a unique item moved into equipped; included in the idempotency fingerprint. */
  readonly equipment?: { readonly actorId: string; readonly itemId: string; readonly slot: string };
}
export class LedgerError extends Error {
  readonly code: 'busy' | 'idempotency_conflict' | 'insufficient_funds' | 'item_not_owned' | 'invalid_source';
  constructor(code: LedgerError['code']) { super(code); this.name = 'LedgerError'; this.code = code; }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
function fingerprint(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function uuidFromKey(type: string, id: string, seq: number, unit: number): string {
  const hex = createHash('sha256').update(`${type}\0${id}\0${seq}\0${unit}`).digest('hex').slice(0, 32).split('');
  const variant = hex[16];
  if (variant === undefined) throw new Error('unexpected hash length');
  hex[12] = '5'; hex[16] = ((parseInt(variant, 16) & 3) | 8).toString(16);
  const out = hex.join(''); return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
function validSource(source: LedgerSource): void {
  if (!source || !/^[a-z][a-z0-9_]{0,63}$/.test(source.type) || !source.id || source.id.length > 200) throw new LedgerError('invalid_source');
}
function assetParts(asset: AssetRef): { kind: string; ref: string } {
  switch (asset.kind) {
    case 'stack': return { kind: 'stack', ref: asset.item };
    case 'currency': return { kind: 'currency', ref: asset.currency };
    case 'unique': return { kind: 'unique', ref: asset.itemId.toLowerCase() };
    case 'unique_mint': return { kind: 'unique_mint', ref: asset.item };
  }
  throw new TypeError('unknown asset kind');
}
function storedContainer(container: Container | null, activity?: LedgerActivity): string {
  if (container === null) return 'inventory';
  if (container === 'escrow') {
    if (!activity || activity.state !== 'expedition') throw new TypeError('escrow requires its owning expedition activity');
    return `escrow:${activity.id.toLowerCase()}`;
  }
  return container;
}
function canonicalDelta(d: LedgerDelta, activity?: LedgerActivity): LedgerDelta {
  assertLedgerDelta(d);
  for (const container of [d.from, d.to]) if (container?.toLowerCase().startsWith('escrow:')) throw new TypeError('escrow containers are scoped by the expedition activity');
  const asset = d.asset.kind === 'unique' ? { ...d.asset, itemId: d.asset.itemId.toLowerCase() } : d.asset;
  return { actorId: d.actorId.toLowerCase(), asset, qty: d.qty,
    ...(d.from === undefined ? {} : { from: storedContainer(d.from, activity) }),
    ...(d.to === undefined ? {} : { to: storedContainer(d.to, activity) }) };
}

/** Apply an ordered, idempotent batch inside the caller's authenticated command transaction. */
export async function applyLedgerDeltas(tx: ActorTransaction, source: LedgerSource, deltas: readonly LedgerDelta[], options: ApplyLedgerOptions = {}): Promise<{ applied: boolean }> {
  validSource(source);
  if (!Array.isArray(deltas)) throw new TypeError('deltas must be an array');
  const sourceType = source.type; const sourceId = source.id;
  // Zero changes have no ledger meaning; normalize them away before fingerprinting and assigning source seq values.
  const canonical = deltas.map(d => canonicalDelta(d, options.activity)).filter(d => d.qty !== 0);
  if (options.equipment) {
    const itemId = options.equipment.itemId.toLowerCase(); const actorId = options.equipment.actorId.toLowerCase();
    if (!options.equipment.slot || !canonical.some(d => d.actorId === actorId && d.asset.kind === 'unique' &&
      d.asset.itemId === itemId && d.qty === 1 && d.to === 'equipped')) {
      throw new TypeError('equipment metadata must match a unique item delta moved into equipped');
    }
  }
  const ids = [...new Set(canonical.map(d => d.actorId))].sort(compare);
  const locked = await lockActors(tx, ids);
  const equipment = options.equipment ? { ...options.equipment, actorId: options.equipment.actorId.toLowerCase(), itemId: options.equipment.itemId.toLowerCase() } : null;
  const batchFingerprint = fingerprint({ deltas: canonical, equipment });
  const inserted = await tx.insert(ledgerBatches).values({ sourceType, sourceId, fingerprint: batchFingerprint, entryCount: canonical.length })
    .onConflictDoNothing().returning({ sourceId: ledgerBatches.sourceId });
  if (inserted.length === 0) {
    const [stored] = await tx.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, sourceType), eq(ledgerBatches.sourceId, sourceId))).for('update');
    if (!stored || stored.fingerprint !== batchFingerprint || stored.entryCount !== canonical.length) throw new LedgerError('idempotency_conflict');
    return { applied: false };
  }
  for (const actor of locked) {
    if (actor.activityState === 'none') continue;
    if (options.activity?.state !== actor.activityState || options.activity.id.toLowerCase() !== actor.activityId) throw new LedgerError('busy');
  }
  const normalized: LedgerDelta[] = canonical;
  const net = netDeltas(normalized);
  for (let seq = 0; seq < canonical.length; seq++) {
    const d = canonical[seq];
    if (!d) throw new Error('missing normalized ledger delta');
    const a = assetParts(d.asset);
    await tx.insert(ledgerEntries).values({ actorId: d.actorId, assetKind: a.kind, assetRef: a.ref, qty: d.qty,
      fromContainer: d.from ?? null, toContainer: d.to ?? null, sourceType, sourceId, seq });
  }
  // Apply fungible materialized deltas atomically. The upsert predicate and CHECK both defend against overdraw.
  for (const change of net.filter(n => n.asset.kind === 'stack' || n.asset.kind === 'currency')) {
    const a = assetParts(change.asset);
    const result = change.qty < 0
      ? await tx.execute(sql`UPDATE asset_balances SET qty = qty + ${change.qty}
          WHERE actor_id = ${change.actorId}::uuid AND asset_kind = ${a.kind} AND asset_ref = ${a.ref}
            AND container = ${change.container ?? 'inventory'} AND qty + ${change.qty} >= 0 RETURNING qty`)
      : await tx.execute(sql`INSERT INTO asset_balances (actor_id, asset_kind, asset_ref, container, qty)
          VALUES (${change.actorId}::uuid, ${a.kind}, ${a.ref}, ${change.container ?? 'inventory'}, ${change.qty})
          ON CONFLICT (actor_id, asset_kind, asset_ref, container) DO UPDATE SET qty = asset_balances.qty + EXCLUDED.qty RETURNING qty`);
    if (result.rows.length === 0) throw new LedgerError('insufficient_funds');
  }
  for (const d of canonical) {
    if (d.asset.kind === 'unique_mint') {
      const target = d.to ?? 'inventory';
      for (let unit = 0; unit < d.qty; unit++) await tx.insert(itemInstances).values({ id: uuidFromKey(sourceType, sourceId, canonical.indexOf(d), unit),
        actorId: d.actorId, definition: d.asset.item, container: target, slot: target === 'equipped' ? 'unspecified' : null,
        rolls: {}, sourceType, sourceId, seq: canonical.indexOf(d), unit });
    } else if (d.asset.kind === 'unique') {
      const [owned] = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, d.actorId), eq(itemInstances.id, d.asset.itemId))).for('update');
      if (!owned) throw new LedgerError('item_not_owned');
      const source = d.qty > 0 ? (d.from ?? 'destroyed') : (d.to ?? (d.from === undefined ? 'inventory' : 'destroyed'));
      const destination = d.qty > 0 ? (d.to ?? (d.from === undefined ? 'inventory' : 'destroyed')) : (d.from ?? 'destroyed');
      if (owned.container !== source) throw new LedgerError('item_not_owned');
      await tx.update(itemInstances).set({ container: destination, slot: destination === 'equipped' ? owned.slot : null }).where(eq(itemInstances.id, d.asset.itemId));
    }
  }
  if (equipment) {
    const { actorId, itemId, slot } = equipment;
    const updated = await tx.update(itemInstances).set({ slot }).where(and(eq(itemInstances.actorId, actorId.toLowerCase()),
      eq(itemInstances.id, itemId.toLowerCase()), eq(itemInstances.container, 'equipped'))).returning({ id: itemInstances.id });
    if (updated.length !== 1) throw new LedgerError('item_not_owned');
  }
  return { applied: true };
}

/** Equip or move one owned unique item without changing its instance UUID or roll data. */
export async function moveUniqueItem(tx: ActorTransaction, source: LedgerSource, actorId: string, itemId: string,
  from: Container, to: Container, slot?: string, options: ApplyLedgerOptions = {}): Promise<{ applied: boolean }> {
  return applyLedgerDeltas(tx, source, [{ actorId, asset: { kind: 'unique', itemId }, qty: 1, from, to }],
    to === 'equipped' && slot ? { ...options, equipment: { actorId, itemId, slot } } : options);
}

export interface Holding { readonly asset: AssetRef; readonly container: string; readonly qty: number; readonly itemId?: string; readonly definition?: string; readonly slot?: string | null; readonly rolls?: unknown }
export async function getHoldings(tx: ActorTransaction, actorId: string): Promise<Holding[]> {
  const actor = actorId.toLowerCase();
  const balances = await tx.select().from(assetBalances).where(eq(assetBalances.actorId, actor));
  const items = await tx.select().from(itemInstances).where(eq(itemInstances.actorId, actor));
  const out: Holding[] = balances.filter(b => b.qty > 0).map(b => ({ asset: b.assetKind === 'currency' ? { kind: 'currency', currency: b.assetRef } : { kind: 'stack', item: b.assetRef }, container: b.container, qty: b.qty }));
  out.push(...items.filter(i => i.container !== 'destroyed').map(i => ({ asset: { kind: 'unique', itemId: i.id } as const, container: i.container, qty: 1, itemId: i.id, definition: i.definition, slot: i.slot, rolls: i.rolls })));
  return out.sort((a, b) => compare(JSON.stringify([a.container, a.asset]), JSON.stringify([b.container, b.asset])));
}

/** Verify materialized totals against the append-only ledger for a set of actors. */
export async function checkLedgerInvariants(tx: ActorTransaction, actorIds: readonly string[] = [], activeExpeditionIds: readonly string[] = []): Promise<string[]> {
  const filters = actorIds.length ? sql`WHERE actor_id = ANY(${actorIds.map(v => v.toLowerCase())}::uuid[])` : sql``;
  const q = await tx.execute(sql`WITH changes AS (
    SELECT actor_id, asset_kind, asset_ref, COALESCE(to_container, 'inventory') AS container, qty AS delta
      FROM ledger_entries WHERE to_container IS NOT NULL OR (from_container IS NULL AND to_container IS NULL)
    UNION ALL
    SELECT actor_id, asset_kind, asset_ref, COALESCE(from_container, 'inventory'), -qty
      FROM ledger_entries WHERE from_container IS NOT NULL
  ), totals AS (SELECT actor_id, asset_kind, asset_ref, container, SUM(delta)::integer AS qty FROM changes GROUP BY 1,2,3,4),
  expected AS (SELECT actor_id, asset_kind, asset_ref, container, qty FROM totals WHERE asset_kind IN ('stack','currency') AND qty <> 0),
  actual AS (SELECT actor_id, asset_kind, asset_ref, container, qty FROM asset_balances WHERE qty <> 0),
  mismatch AS ((SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
  SELECT 'balance mismatch' AS issue FROM mismatch ${filters}`);
  const issues = q.rows.map(() => 'balance mismatch');
  const batchMismatch = await tx.execute(sql`SELECT 1 FROM ledger_batches b LEFT JOIN
    (SELECT source_type, source_id, COUNT(*)::integer AS n FROM ledger_entries GROUP BY 1,2) e USING (source_type,source_id)
    WHERE COALESCE(e.n,0) <> b.entry_count LIMIT 1`);
  if (batchMismatch.rows.length) issues.push('ledger batch entry count mismatch');
  const entryRows = actorIds.length
    ? await tx.select().from(ledgerEntries).where(inArray(ledgerEntries.actorId, actorIds.map(v => v.toLowerCase()))).orderBy(asc(ledgerEntries.entryNo))
    : await tx.select().from(ledgerEntries).orderBy(asc(ledgerEntries.entryNo));
  const expectedUnique = new Map<string, { actorId: string; definition: string; container: string; sourceType: string; sourceId: string; seq: number; unit: number }>();
  for (const entry of entryRows) {
    if (entry.assetKind === 'unique_mint') {
      for (let unit = 0; unit < entry.qty; unit++) {
        const id = uuidFromKey(entry.sourceType, entry.sourceId, entry.seq, unit);
        expectedUnique.set(id, { actorId: entry.actorId, definition: entry.assetRef, container: entry.toContainer ?? 'inventory',
          sourceType: entry.sourceType, sourceId: entry.sourceId, seq: entry.seq, unit });
      }
    } else if (entry.assetKind === 'unique') {
      const expected = expectedUnique.get(entry.assetRef.toLowerCase());
      if (!expected || expected.actorId !== entry.actorId) { issues.push('unique ledger references an unminted instance'); continue; }
      const source = entry.qty > 0 ? (entry.fromContainer ?? 'destroyed') : (entry.toContainer ?? (entry.fromContainer === null ? 'inventory' : 'destroyed'));
      const destination = entry.qty > 0 ? (entry.toContainer ?? (entry.fromContainer === null ? 'inventory' : 'destroyed'))
        : (entry.fromContainer ?? 'destroyed');
      if (expected.container !== source) issues.push('unique ledger source container mismatch');
      else expected.container = destination;
    }
  }
  const currentUnique = actorIds.length
    ? await tx.select().from(itemInstances).where(inArray(itemInstances.actorId, actorIds.map(v => v.toLowerCase())))
    : await tx.select().from(itemInstances);
  if (expectedUnique.size !== currentUnique.length) issues.push('unique instance count differs from mint history');
  for (const item of currentUnique) {
    const expected = expectedUnique.get(item.id);
    if (!expected || expected.actorId !== item.actorId || expected.definition !== item.definition || expected.container !== item.container ||
      expected.sourceType !== item.sourceType || expected.sourceId !== item.sourceId || expected.seq !== item.seq || expected.unit !== item.unit) {
      issues.push('unique instance differs from mint and ownership history'); break;
    }
  }
  const actorFilter = actorIds.length ? sql`AND i.actor_id = ANY(${actorIds.map(v => v.toLowerCase())}::uuid[])` : sql``;
  const orphanItem = await tx.execute(sql`SELECT 1 FROM item_instances i WHERE NOT EXISTS (
      SELECT 1 FROM ledger_entries l WHERE l.source_type=i.source_type AND l.source_id=i.source_id AND l.seq=i.seq AND l.asset_kind='unique_mint'
    ) ${actorFilter} LIMIT 1`);
  if (orphanItem.rows.length) issues.push('unique instance has no mint ledger entry');
  const orphanEscrow = await tx.execute(sql`SELECT 1 FROM (
      SELECT container, actor_id FROM asset_balances WHERE qty > 0 UNION ALL SELECT container, actor_id FROM item_instances WHERE container <> 'destroyed'
    ) owned WHERE owned.container LIKE 'escrow:%' AND substring(owned.container from 8) <> ALL(${activeExpeditionIds.map(v => v.toLowerCase())}::text[])
    ${actorIds.length ? sql`AND owned.actor_id = ANY(${actorIds.map(v => v.toLowerCase())}::uuid[])` : sql``} LIMIT 1`);
  if (orphanEscrow.rows.length) issues.push('orphan expedition escrow');
  return issues;
}
