import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors } from '../actors/schema.ts';
import { accounts } from '../auth/schema.ts';
import { parseServerConfig } from '../config.ts';
import { createDatabase } from '../database.ts';
import type { Database } from '../database.ts';
import { applyLedgerDeltas, checkLedgerInvariants, getHoldings, moveUniqueItem } from './service.ts';
import type { ActorTransaction } from '../actors/service.ts';
import { itemInstances, ledgerEntries } from './schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL ledger integration tests');

describe.skipIf(!adminUrl)('economy ledger against real PostgreSQL', () => {
  let admin: Database; let database: Database; let peer: Database;
  const databaseName = `ledger_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const config = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: '/unused', LOG_LEVEL: 'silent' });
    admin = createDatabase(config);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(config.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...config, databaseUrl: url.toString() });
    peer = createDatabase({ ...config, databaseUrl: url.toString() });
    await database.migrate();
  }, 30_000);
  afterAll(async () => {
    await peer?.close(); await database?.close();
    if (admin) { try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await admin.close(); } }
  });
  async function actor(activity: 'none' | 'expedition' = 'none', activityId: string | null = null): Promise<string> {
    const accountId = randomUUID(); const actorId = randomUUID();
    await database.db.insert(accounts).values({ id: accountId, createdAt: new Date() });
    await database.db.insert(actors).values({ actorId, accountId, gameId: 'ledger_test', activityState: activity, activityId });
    return actorId;
  }
  const transact = <T>(db: Database, fn: (tx: ActorTransaction) => Promise<T>): Promise<T> => db.db.transaction(fn);
  const holdings = async (id: string) => transact(database, tx => getHoldings(tx, id));
  it('serializes last-unit consumption across pools and never commits a negative balance', async () => {
    const id = await actor();
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: randomUUID() }, [
      { actorId: id, asset: { kind: 'stack', item: 'potion' }, qty: 1, to: 'inventory' },
    ]));
    const consume = (db: Database, sourceId: string) => transact(db, tx => applyLedgerDeltas(tx,
      { type: 'test_consume', id: sourceId }, [{ actorId: id, asset: { kind: 'stack', item: 'potion' }, qty: 1, from: 'inventory' }]));
    const outcomes = await Promise.allSettled([consume(database, randomUUID()), consume(peer, randomUUID())]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(x => x.status === 'rejected')).toHaveLength(1);
    expect((await holdings(id)).filter(h => h.asset.kind === 'stack')).toEqual([]);
    expect(await database.pool.query('SELECT qty FROM asset_balances WHERE actor_id=$1 AND asset_kind=$2', [id, 'stack'])).toMatchObject({ rows: [{ qty: 0 }] });
    expect(await transact(database, tx => checkLedgerInvariants(tx, [id]))).toEqual([]);
  });
  it('replays a batch once and rejects reuse of its source key with a different payload', async () => {
    const id = await actor(); const source = { type: 'fixture_grant', id: randomUUID() };
    const delta = [{ actorId: id, asset: { kind: 'currency', currency: 'gold' } as const, qty: 12, to: 'inventory' }];
    expect(await transact(database, tx => applyLedgerDeltas(tx, source, delta))).toEqual({ applied: true });
    expect(await transact(peer, tx => applyLedgerDeltas(tx, source, delta))).toEqual({ applied: false });
    const changed = delta.map(d => ({ ...d, qty: 13 }));
    await expect(transact(peer, tx => applyLedgerDeltas(tx, source, changed))).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await holdings(id)).find(h => h.asset.kind === 'currency')?.qty).toBe(12);
    expect(await database.db.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, source.id))).toHaveLength(1);
  });
  it('serializes concurrent retries of one source key and applies only one grant', async () => {
    const id = await actor(); const source = { type: 'fixture_race', id: randomUUID() };
    const delta = [{ actorId: id, asset: { kind: 'stack', item: 'fiber' } as const, qty: 3 }];
    const results = await Promise.all([database, peer, database, peer].map(db => transact(db, tx => applyLedgerDeltas(tx, source, delta))));
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect((await holdings(id)).find(h => h.asset.kind === 'stack')?.qty).toBe(3);
    expect(await database.db.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, source.id))).toHaveLength(1);
  });
  it('mints stable unique identities once and preserves definitions and rolls through equip moves', async () => {
    const id = await actor(); const source = { type: 'expedition_settlement', id: randomUUID() };
    const drop = [{ actorId: id, asset: { kind: 'unique_mint', item: 'iron_sabre' } as const, qty: 2, to: 'inventory' }];
    await transact(database, tx => applyLedgerDeltas(tx, source, drop));
    await transact(peer, tx => applyLedgerDeltas(tx, source, drop));
    const minted = (await holdings(id)).filter(h => h.asset.kind === 'unique');
    expect(minted).toHaveLength(2);
    const equippedId = minted[0]?.itemId;
    if (!equippedId) throw new Error('expected minted item instance');
    await database.db.update(itemInstances).set({ rolls: { attack: 7 } }).where(eq(itemInstances.id, equippedId));
    const equipSource = { type: 'equip', id: randomUUID() };
    await transact(database, tx => moveUniqueItem(tx, equipSource, id, equippedId, 'inventory', 'equipped', 'weapon'));
    const item = (await holdings(id)).find(h => h.itemId === equippedId);
    expect(item).toMatchObject({ container: 'equipped', definition: 'iron_sabre', slot: 'weapon', rolls: { attack: 7 } });
    await expect(transact(database, tx => moveUniqueItem(tx, equipSource, id, equippedId, 'inventory', 'equipped', 'body')))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(transact(database, tx => applyLedgerDeltas(tx, { type: 'unsafe_metadata', id: randomUUID() }, [], {
      equipment: { actorId: randomUUID(), itemId: equippedId, slot: 'head' },
    }))).rejects.toThrow('equipment metadata must match');
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'unique_consume', id: randomUUID() }, [
      { actorId: id, asset: { kind: 'unique', itemId: equippedId }, qty: 1, from: 'equipped' },
    ]));
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'unique_restore', id: randomUUID() }, [
      { actorId: id, asset: { kind: 'unique', itemId: equippedId }, qty: -1, from: 'equipped' },
    ]));
    expect((await holdings(id)).find(h => h.itemId === equippedId)).toMatchObject({ container: 'equipped', rolls: { attack: 7 } });
    expect(await transact(database, tx => checkLedgerInvariants(tx, [id]))).toEqual([]);
  });
  it('scopes expedition escrow to its explicit activity id and returns it atomically', async () => {
    const expeditionId = randomUUID(); const id = await actor();
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'fixture', id: randomUUID() }, [
      { actorId: id, asset: { kind: 'stack', item: 'ration' }, qty: 2, to: 'inventory' },
    ]));
    await database.db.update(actors).set({ activityState: 'expedition', activityId: expeditionId }).where(eq(actors.actorId, id));
    const activity = { state: 'expedition' as const, id: expeditionId };
    await expect(transact(database, tx => applyLedgerDeltas(tx, { type: 'uncoordinated', id: randomUUID() }, [
      { actorId: id, asset: { kind: 'stack', item: 'ration' }, qty: 1, to: 'inventory' },
    ]))).rejects.toMatchObject({ code: 'busy' });
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'expedition_start', id: `${expeditionId}:start` }, [
      { actorId: id, asset: { kind: 'stack', item: 'ration' }, qty: 2, from: 'inventory', to: 'escrow' },
    ], { activity }));
    expect((await holdings(id)).find(h => h.asset.kind === 'stack')?.container).toBe(`escrow:${expeditionId}`);
    expect(await transact(database, tx => checkLedgerInvariants(tx, [id], [expeditionId]))).toEqual([]);
    expect(await transact(database, tx => checkLedgerInvariants(tx, [id]))).toContain('orphan expedition escrow');
    await transact(database, tx => applyLedgerDeltas(tx, { type: 'expedition_settlement', id: `${expeditionId}:end` }, [
      { actorId: id, asset: { kind: 'stack', item: 'ration' }, qty: 2, from: 'escrow', to: 'inventory' },
    ], { activity }));
    await database.db.update(actors).set({ activityState: 'none', activityId: null }).where(eq(actors.actorId, id));
    expect((await holdings(id)).find(h => h.asset.kind === 'stack')).toMatchObject({ container: 'inventory', qty: 2 });
    expect(await transact(database, tx => checkLedgerInvariants(tx, [id]))).toEqual([]);
  });
  it('rolls the whole batch back when the caller transaction fails', async () => {
    const id = await actor(); const source = { type: 'fixture_rollback', id: randomUUID() };
    await expect(database.db.transaction(async tx => {
      await applyLedgerDeltas(tx, source, [{ actorId: id, asset: { kind: 'currency', currency: 'gold' }, qty: 9 }]);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await holdings(id)).toEqual([]);
    expect(await database.pool.query('SELECT 1 FROM ledger_batches WHERE source_id=$1', [source.id])).toMatchObject({ rows: [] });
  });
});
