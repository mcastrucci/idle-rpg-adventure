import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { applyLedgerDeltas, assetBalances, checkLedgerInvariants, createDatabase, getHoldings, itemInstances, ledgerBatches,
  ManualClock, parseServerConfig, transitionActivity } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { and, eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import type { InventorySnapshotDto } from '@rpg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { validateRpgBundle } from '../content.ts';
import { expeditions } from '../expeditions/schema.ts';
import { characters } from '../characters/schema.ts';
import { recordAreaCompletion } from '../expeditions/progress.ts';
import { STARTER_KIT_ITEMS, createInventoryService } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL inventory acceptance tests');
const token = () => randomBytes(32).toString('base64url');
const GOLD = { kind: 'currency', currency: 'gold' } as const;
const SWORD = 'item:rusty_sword';

interface Session { accountId: string; sessionToken: string }
interface Character { actorId: string; accountId: string; level: number; [key: string]: unknown }
interface WireCommand { command_id: string; operation: string; payload: Record<string, unknown> }
interface SocketResult { type: string; status: number; body: Record<string, unknown>; command_id?: string }

describe.skipIf(!adminUrl)('authenticated inventory and merchant against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let directory: string;
  let websocketUrl: string;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  const databaseName = `inventory_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_800_000_000_000);
  const sockets = new Set<WebSocket>();
  let nextRemoteAddress = 1;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'inventory-integration-'));
    const sourceContent = fileURLToPath(new URL('../../../../content', import.meta.url));
    const contentDirectory = join(directory, 'test-content');
    await cp(sourceContent, contentDirectory, { recursive: true });
    const itemsPath = join(contentDirectory, 'items', 'region_1.json');
    const authoredItems = JSON.parse(await readFile(itemsPath, 'utf8')) as { id: string; levelRequired?: number; [key: string]: unknown }[];
    const paddedVest = authoredItems.find(item => item.id === 'item:padded_vest');
    if (!paddedVest) throw new Error('authored content is missing the padded vest');
    // This private integration fixture exercises the level gate without changing authored game content.
    paddedVest.levelRequired = 2;
    authoredItems.push({ id: 'item:overflow_test_material', kind: 'material', value: 2_147_483_647,
      stackable: true, maxStack: 10, tags: ['test'] });
    await writeFile(itemsPath, JSON.stringify(authoredItems));
    const compiled = compileContentDirectory(contentDirectory, plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle;
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString(), roles: ['api', 'live'] };
    database = createRpgDatabase(config);
    await database.migrate();
    app = await createRpgServer(config, { clock, seedSource: () => 17 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    websocketUrl = address.replace('http:', 'ws:') + '/auth/live';
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  async function guest(): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', remoteAddress: `127.0.0.${nextRemoteAddress++}`,
      payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function createHero(session: Session): Promise<Character> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Inventory hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<Character>();
  }
  async function fixture(options: { gold?: number; sword?: boolean; vest?: boolean; potion?: number; material?: number; areaComplete?: boolean } = {}) {
    const session = await guest();
    const character = await createHero(session);
    const deltas = [] as { actorId: string; asset: typeof GOLD | { kind: 'stack'; item: string } | { kind: 'unique_mint'; item: string }; qty: number }[];
    if (options.gold) deltas.push({ actorId: character.actorId, asset: GOLD, qty: options.gold });
    if (options.potion) deltas.push({ actorId: character.actorId, asset: { kind: 'stack', item: 'item:minor_healing_potion' }, qty: options.potion });
    if (options.material) deltas.push({ actorId: character.actorId, asset: { kind: 'stack', item: 'item:amber_resin' }, qty: options.material });
    if (options.sword) deltas.push({ actorId: character.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: 1 });
    if (options.vest) deltas.push({ actorId: character.actorId, asset: { kind: 'unique_mint', item: 'item:padded_vest' }, qty: 1 });
    if (deltas.length) await database.db.transaction(tx => applyLedgerDeltas(tx,
      { type: 'test_fixture', id: `${character.actorId}:inventory` }, deltas));
    if (options.sword) {
      const instance = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
        .find(item => item.definition === SWORD);
      if (!instance) throw new Error('fixture sword was not minted');
      // Seed an authored roll payload after its REAL ledger mint so equip/storage can prove preservation.
      await database.db.update(itemInstances).set({ rolls: { power: 7, affix: 'steady' } }).where(eq(itemInstances.id, instance.id));
    }
    if (options.areaComplete) {
      const { recordAreaCompletion } = await import('../expeditions/progress.ts');
      await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, 'area:region_1'));
    }
    return { session, character };
  }
  async function command(session: Session, actorId: string, envelope: WireCommand) {
    return app.inject({ method: 'POST', url: `/characters/${actorId}/inventory/commands`, headers: headers(session), payload: envelope });
  }
  async function socket(session: Session) {
    const connection = new WebSocket(websocketUrl, { headers: headers(session) });
    sockets.add(connection);
    const inbox: string[] = [];
    connection.on('message', message => inbox.push(message.toString()));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      connection.once('error', onError);
      connection.once('open', () => { connection.off('error', onError); resolve(); });
    });
    async function next(): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const message = inbox.shift();
        if (message !== undefined) return message;
        if (connection.readyState === WebSocket.CLOSED) throw new Error('socket closed before expected message');
        await delay(10);
      }
      throw new Error('socket response timeout');
    }
    return { connection, next };
  }
  async function gold(actorId: string): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.filter(row => row.assetKind === 'currency' && row.assetRef === 'gold' && row.container === 'inventory')
      .reduce((sum, row) => sum + row.qty, 0);
  }
  async function inventory(session: Session, actorId: string) {
    return app.inject({ url: `/characters/${actorId}/inventory`, headers: headers(session) });
  }
  function envelope(operation: string, payload: Record<string, unknown>, commandId: string = randomUUID()): WireCommand {
    return { command_id: commandId, operation: `inventory.${operation}`, payload };
  }

  it('serves the compiled merchant offers and inventory from the authenticated actor state', async () => {
    const { session, character } = await fixture({ gold: 60, potion: 2 });
    const catalog = await app.inject({ url: '/merchant', headers: headers(session) });
    expect(catalog.statusCode).toBe(200);
    expect(JSON.stringify(catalog.json())).toContain('offer:minor_healing_potion');
    expect(JSON.stringify(catalog.json())).toContain('offer:sap_tonic');
    expect(JSON.stringify(catalog.json())).toContain('offer:healing_potion');
    expect(catalog.json().sellOffers).toContainEqual({ item: 'item:amber_resin', unitPrice: { currency: 'gold', amount: 3 } });
    expect(catalog.json().sellOffers).toEqual([...catalog.json().sellOffers].sort((a: { item: string }, b: { item: string }) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    expect(catalog.json()).toMatchObject({ merchants: [expect.objectContaining({ offers: expect.arrayContaining([
      expect.objectContaining({ id: 'offer:minor_healing_potion', buyPrice: { currency: 'gold', amount: 12 } }),
      expect.objectContaining({ id: 'offer:sap_tonic', buyPrice: { currency: 'gold', amount: 18 } }),
      expect.objectContaining({ id: 'offer:healing_potion', buyPrice: { currency: 'gold', amount: 40 }, requiresCompletedArea: 'area:region_1' }),
    ]) })] });
    const snapshot = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(snapshot).toMatchObject({ actorId: character.actorId, actorVersion: 0, activityState: 'none', level: 1,
      starterKit: { claimed: false, items: STARTER_KIT_ITEMS },
      attributes: { STR: expect.any(Number), AGI: expect.any(Number), INT: expect.any(Number), VIT: expect.any(Number), SPI: expect.any(Number) },
      completedAreas: [], catalog: { contentHash: content.contentHash, items: expect.arrayContaining([
        expect.objectContaining({ id: 'item:rusty_sword', kind: 'equipment', slot: 'weapon', stackable: false }),
        expect.objectContaining({ id: 'item:minor_healing_potion', kind: 'consumable', stackable: true }),
      ]) },
      holdings: expect.arrayContaining([
        expect.objectContaining({ asset: { kind: 'currency', currency: 'gold' }, qty: 60 }),
        expect.objectContaining({ asset: { kind: 'stack', item: 'item:minor_healing_potion' }, qty: 2 }),
      ]) });
    const swordDefinition = snapshot.catalog.items.find(item => item.id === 'item:rusty_sword');
    expect(swordDefinition).toBeDefined();
    expect(Object.keys(swordDefinition ?? {}).every(key => ['id', 'kind', 'nameKey', 'slot', 'levelRequired', 'stats', 'stackable'].includes(key))).toBe(true);
    expect(swordDefinition).not.toHaveProperty('value');
    expect(swordDefinition).not.toHaveProperty('tags');
    expect(swordDefinition).not.toHaveProperty('use');
    const stranger = await guest();
    expect((await inventory(stranger, character.actorId)).statusCode).toBe(404);
  });

  it('sells only banked authored materials at their unchanged value and replays the same command', async () => {
    const { session, character } = await fixture({ gold: 4, material: 3 });
    const before = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    const saleId = randomUUID();
    const sale = await command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:amber_resin', quantity: 2,
    }, saleId));
    expect(sale.statusCode).toBe(200);
    expect(sale.json()).toEqual({ actorId: character.actorId, version: before.actorVersion + 1 });
    const after = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(after.actorVersion).toBe(before.actorVersion + 1);
    expect(after.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: 10 }),
      expect.objectContaining({ asset: { kind: 'stack', item: 'item:amber_resin' }, container: 'inventory', qty: 1 }),
    ]));
    const replay = await command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:amber_resin', quantity: 2,
    }, saleId));
    expect(replay.json()).toEqual(sale.json());
    expect((await inventory(session, character.actorId)).json<InventorySnapshotDto>().actorVersion).toBe(before.actorVersion + 1);
    const conflict = await command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:amber_resin', quantity: 1,
    }, saleId));
    expect(conflict.statusCode).toBe(409);
    expect((await inventory(session, character.actorId)).json<InventorySnapshotDto>().actorVersion).toBe(before.actorVersion + 1);
  });

  it('rolls back a completed material sale when its surrounding transaction aborts', async () => {
    const { session, character } = await fixture({ gold: 4, material: 3 });
    const before = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    const commandId = randomUUID();
    await expect(database.db.transaction(async tx => {
      const result = await createInventoryService(tx, content).sellMaterial(session.accountId, commandId, {
        actorId: character.actorId, item: 'item:amber_resin', quantity: 2,
      });
      expect(result).toEqual({ actorId: character.actorId, version: before.actorVersion + 1 });
      throw new Error('force_sale_rollback');
    })).rejects.toThrow('force_sale_rollback');

    const after = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(after.actorVersion).toBe(before.actorVersion);
    expect(after.holdings).toEqual(before.holdings);
    const [batch] = await database.db.select().from(ledgerBatches).where(and(
      eq(ledgerBatches.sourceType, 'rpg_command'), eq(ledgerBatches.sourceId, `${session.accountId}:${commandId}`)));
    expect(batch).toBeUndefined();
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('serializes concurrent sales of the same stack so fresh command IDs cannot oversell', async () => {
    const { session, character } = await fixture({ material: 3 });
    const requests = [1, 2].map(() => command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:amber_resin', quantity: 2,
    })));
    const results = await Promise.all(requests);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const snapshot = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(snapshot.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: 6 }),
      expect.objectContaining({ asset: { kind: 'stack', item: 'item:amber_resin' }, container: 'inventory', qty: 1 }),
    ]));
    expect(snapshot.actorVersion).toBe(1);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('bounds sale proceeds and resulting inventory gold to the ledger integer range', async () => {
    const { session, character } = await fixture({ gold: 1 });
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:overflow_material` }, [
      { actorId: character.actorId, asset: { kind: 'stack', item: 'item:overflow_test_material' }, qty: 2 },
    ]));
    const badProceeds = await command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:overflow_test_material', quantity: 2,
    }));
    expect(badProceeds.statusCode).toBe(400);
    const goldOverflow = await command(session, character.actorId, envelope('sellMaterial', {
      actorId: character.actorId, item: 'item:overflow_test_material', quantity: 1,
    }));
    expect(goldOverflow.statusCode).toBe(409);
    const snapshot = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(snapshot.actorVersion).toBe(0);
    expect(snapshot.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: 1 }),
      expect.objectContaining({ asset: { kind: 'stack', item: 'item:overflow_test_material' }, container: 'inventory', qty: 2 }),
    ]));
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('rejects non-owned, active, storage-only, and non-material sale requests without changing version or balances', async () => {
    const owner = await fixture({ material: 2 });
    const stranger = await guest();
    const unauthorized = await command(stranger, owner.character.actorId, envelope('sellMaterial', {
      actorId: owner.character.actorId, item: 'item:amber_resin', quantity: 1,
    }));
    expect(unauthorized.statusCode).toBe(404);
    const toStorage = await command(owner.session, owner.character.actorId, envelope('move', {
      actorId: owner.character.actorId, item: 'item:amber_resin', quantity: 2, from: 'inventory', to: 'storage',
    }));
    expect(toStorage.statusCode).toBe(200);
    const storageOnly = await command(owner.session, owner.character.actorId, envelope('sellMaterial', {
      actorId: owner.character.actorId, item: 'item:amber_resin', quantity: 1,
    }));
    expect(storageOnly.statusCode).toBe(409);
    for (const item of ['item:minor_healing_potion', 'item:rusty_sword', 'item:seed_capsule', 'item:missing']) {
      const prohibited = await command(owner.session, owner.character.actorId, envelope('sellMaterial', {
        actorId: owner.character.actorId, item, quantity: 1,
      }));
      expect([400, 409]).toContain(prohibited.statusCode);
    }
    const forgedContainer = await command(owner.session, owner.character.actorId, envelope('sellMaterial', {
      actorId: owner.character.actorId, item: 'item:amber_resin', quantity: 1, from: 'storage', container: 'corpse',
    }));
    expect(forgedContainer.statusCode).toBe(400);
    for (const quantity of [0, -1, 10_001]) {
      const invalid = await command(owner.session, owner.character.actorId, envelope('sellMaterial', {
        actorId: owner.character.actorId, item: 'item:amber_resin', quantity,
      }));
      expect(invalid.statusCode).toBe(400);
    }
    await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId, { state: 'none', activityId: null }, { state: 'live', activityId: 'test_live' }));
    const activeBefore = (await inventory(owner.session, owner.character.actorId)).json<InventorySnapshotDto>();
    const active = await command(owner.session, owner.character.actorId, envelope('sellMaterial', {
      actorId: owner.character.actorId, item: 'item:amber_resin', quantity: 1,
    }));
    expect(active.statusCode).toBe(409);
    const after = (await inventory(owner.session, owner.character.actorId)).json<InventorySnapshotDto>();
    expect(after.actorVersion).toBe(activeBefore.actorVersion);
    expect(after.holdings).toEqual(activeBefore.holdings);
    await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId, { state: 'live', activityId: 'test_live' }, { state: 'none', activityId: null }));
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [owner.character.actorId]))).toEqual([]);
  });

  it('claims one stable starter kit for new and existing characters without resetting progress', async () => {
    const { session, character } = await fixture({ gold: 60, potion: 2, sword: true });
    const existingSword = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.definition === 'item:rusty_sword');
    if (!existingSword) throw new Error('existing sword fixture is missing');
    expect((await command(session, character.actorId, envelope('equip', { actorId: character.actorId,
      itemId: existingSword.id, slot: 'weapon' }))).statusCode).toBe(200);
    await database.db.update(characters).set({ level: 3, xp: 77, unspentPoints: 2,
      attributes: { STR: 7, AGI: 6, INT: 5, VIT: 8, SPI: 5 } }).where(eq(characters.actorId, character.actorId));
    await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, 'area:region_1'));
    const before = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    const characterBefore = (await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0];
    if (!characterBefore) throw new Error('character progress fixture is missing');
    expect(before.starterKit).toEqual({ claimed: false, items: STARTER_KIT_ITEMS });
    const claimId = randomUUID();
    const claim = await command(session, character.actorId, envelope('claimStarterKit', { actorId: character.actorId }, claimId));
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toEqual({ actorId: character.actorId, version: before.actorVersion + 1 });
    let after = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(after.starterKit).toEqual({ claimed: true, items: STARTER_KIT_ITEMS });
    expect(after).toMatchObject({ level: before.level, attributes: before.attributes, completedAreas: before.completedAreas });
    expect(after.holdings.filter(row => row.definition && STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number])))
      .toHaveLength(4);
    expect(after.holdings).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: existingSword.id,
      container: 'equipped', slot: 'weapon', rolls: { power: 7, affix: 'steady' } }),
    ...before.holdings.map(holding => expect.objectContaining(holding))]));
    const characterAfter = (await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0];
    expect(characterAfter).toEqual(characterBefore);
    const sameCommandReplay = await command(session, character.actorId,
      envelope('claimStarterKit', { actorId: character.actorId }, claimId));
    expect(sameCommandReplay.json()).toEqual(claim.json());
    const repeat = await command(session, character.actorId, envelope('claimStarterKit', { actorId: character.actorId }));
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ actorId: character.actorId, version: before.actorVersion + 1 });
    const sword = after.holdings.find(row => row.definition === 'item:rusty_sword' && row.itemId !== existingSword.id);
    if (!sword?.itemId) throw new Error('starter sword is missing its unique instance id');
    expect((await command(session, character.actorId, envelope('move', { actorId: character.actorId, itemId: sword.itemId,
      from: 'inventory', to: 'storage' }))).statusCode).toBe(200);
    after = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(after.starterKit?.claimed).toBe(true);
    const replayWithNewCommand = await command(session, character.actorId, envelope('claimStarterKit', { actorId: character.actorId }));
    expect(replayWithNewCommand.json()).toEqual({ actorId: character.actorId, version: before.actorVersion + 2 });
    expect((await inventory(session, character.actorId)).json<InventorySnapshotDto>().holdings
      .filter(row => row.definition && STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number]))).toHaveLength(4);
  });

  it('serializes concurrent starter kit claims with different command ids', async () => {
    const { session, character } = await fixture();
    const claims = await Promise.all([1, 2].map(() => command(session, character.actorId,
      envelope('claimStarterKit', { actorId: character.actorId }))));
    expect(claims.map(result => result.statusCode)).toEqual([200, 200]);
    expect(claims.map(result => result.json<{ version: number }>().version).sort()).toEqual([1, 1]);
    const snapshot = (await inventory(session, character.actorId)).json<InventorySnapshotDto>();
    expect(snapshot.starterKit?.claimed).toBe(true);
    expect(snapshot.holdings.filter(row => row.definition && STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number])))
      .toHaveLength(3);
  });

  it('denies starter kit claims for foreign or busy actors and rolls back an uncommitted claim', async () => {
    const owner = await fixture();
    const stranger = await guest();
    expect((await command(stranger, owner.character.actorId, envelope('claimStarterKit', { actorId: owner.character.actorId }))).statusCode).toBe(404);
    for (const state of ['live', 'expedition'] as const) {
      const activityId = randomUUID();
      await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId,
        { state: 'none', activityId: null }, { state, activityId }));
      expect((await command(owner.session, owner.character.actorId, envelope('claimStarterKit', { actorId: owner.character.actorId }))).statusCode).toBe(409);
      await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId,
        { state, activityId }, { state: 'none', activityId: null }));
    }
    await expect(database.db.transaction(async tx => {
      await createInventoryService(tx, content).claimStarterKit(owner.session.accountId, owner.character.actorId);
      throw new Error('rollback fixture');
    })).rejects.toThrow('rollback fixture');
    const afterRollback = (await inventory(owner.session, owner.character.actorId)).json<InventorySnapshotDto>();
    expect(afterRollback.starterKit?.claimed).toBe(false);
    expect(afterRollback.holdings.filter(row => row.definition && STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number]))).toHaveLength(0);
    await expect(database.db.transaction(tx => createInventoryService(tx, { collections: { items: [] } } as never)
      .claimStarterKit(owner.session.accountId, owner.character.actorId))).rejects.toThrow('starter_kit_unavailable');
    const invalidContent = (await inventory(owner.session, owner.character.actorId)).json<InventorySnapshotDto>();
    expect(invalidContent.starterKit?.claimed).toBe(false);
    expect(invalidContent.actorVersion).toBe(afterRollback.actorVersion);
    expect(invalidContent.holdings.filter(row => row.definition && STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number]))).toHaveLength(0);
    expect((await command(owner.session, owner.character.actorId, envelope('claimStarterKit', { actorId: owner.character.actorId }))).statusCode).toBe(200);
    const activeId = randomUUID();
    await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId,
      { state: 'none', activityId: null }, { state: 'live', activityId: activeId }));
    expect((await command(owner.session, owner.character.actorId, envelope('claimStarterKit', { actorId: owner.character.actorId }))).statusCode).toBe(409);
    await database.db.transaction(tx => transitionActivity(tx, owner.character.actorId,
      { state: 'live', activityId: activeId }, { state: 'none', activityId: null }));
  });

  it('returns an empty inventory for a fresh character without granting defaults', async () => {
    const { session, character } = await fixture();
    expect((await inventory(session, character.actorId)).json()).toMatchObject({ actorId: character.actorId, holdings: [],
      actorVersion: 0, activityState: 'none', level: 1, completedAreas: [], catalog: { contentHash: content.contentHash } });
  });

  it('returns only persisted completion records for merchant gating', async () => {
    const { session, character } = await fixture({ areaComplete: true });
    expect((await inventory(session, character.actorId)).json()).toMatchObject({ completedAreas: ['area:region_1'] });
  });

  it('validates merchant content schemas and rejects broken item references', () => {
    expect(() => validateRpgBundle(content as never)).not.toThrow();
    const invalid = structuredClone(content) as unknown;
    const breakOfferReference = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(breakOfferReference);
      if (typeof value !== 'object' || value === null) return false;
      const record = value as Record<string, unknown>;
      if (record['id'] === 'offer:minor_healing_potion') {
        record['item'] = 'item:missing_fixture_reference';
        return true;
      }
      return Object.values(record).some(breakOfferReference);
    };
    expect(breakOfferReference(invalid)).toBe(true);
    expect(() => validateRpgBundle(invalid as never)).toThrow();
  });

  it('replays one HTTP purchase through a real authenticated WebSocket and rejects a changed command payload', async () => {
    const { session, character } = await fixture({ gold: 30 });
    const payload = { actorId: character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1 };
    const request = envelope('buy', payload);
    const ws = await socket(session);
    expect(JSON.parse(await ws.next())).toMatchObject({ type: 'authenticated', accountId: session.accountId });
    ws.connection.send(JSON.stringify({ type: 'command', command: request }));
    const first = JSON.parse(await ws.next()) as SocketResult;
    expect(first).toMatchObject({ type: 'command.result', status: 200 });
    const stranger = await guest();
    expect((await command(stranger, character.actorId, request)).statusCode).toBe(404);
    const replay = await command(session, character.actorId, request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.body);
    expect(await gold(character.actorId)).toBe(18);
    const contents = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(contents).toEqual(expect.arrayContaining([expect.objectContaining({
      asset: { kind: 'stack', item: 'item:minor_healing_potion' }, qty: 1, container: 'inventory',
    })]));
    const conflict = await command(session, character.actorId, envelope('buy', { ...payload, quantity: 2 }, request.command_id));
    expect(conflict.statusCode).toBe(409);
    expect(await gold(character.actorId)).toBe(18);
    ws.connection.terminate();
  });

  it('replays a confirmed purchase after the server content price changes', async () => {
    const { session, character } = await fixture({ gold: 24 });
    const request = envelope('buy', { actorId: character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1 });
    const first = await command(session, character.actorId, request);
    expect(first.statusCode).toBe(200);
    const changedContent = join(directory, 'changed-content');
    await cp(join(directory, 'test-content'), changedContent, { recursive: true });
    const merchantPath = join(changedContent, 'merchants', 'region_1.json');
    const authoredMerchant = JSON.parse(await readFile(merchantPath, 'utf8')) as {
      offers: { id: string; buyPrice: { amount: number } }[];
    };
    const changedOffer = authoredMerchant.offers.find(offer => offer.id === 'offer:minor_healing_potion');
    if (!changedOffer) throw new Error('authored merchant is missing the minor potion offer');
    changedOffer.buyPrice.amount = 99;
    await writeFile(merchantPath, JSON.stringify(authoredMerchant));
    const changedBundle = compileContentDirectory(changedContent, plugin);
    if (!changedBundle.ok) throw new Error(JSON.stringify(changedBundle.errors));
    const changedPath = join(directory, 'changed-bundle.json');
    await writeFile(changedPath, JSON.stringify(changedBundle.bundle));
    const changedApp = await createRpgServer({ ...config, contentBundlePath: changedPath, roles: ['api'] }, { clock });
    try {
      const replay = await changedApp.inject({ method: 'POST', url: `/characters/${character.actorId}/inventory/commands`,
        headers: headers(session), payload: request });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(await gold(character.actorId)).toBe(12);
    } finally { await changedApp.close(); }
  });

  it('prices offers from server content, ignores/rejects forged client prices, and enforces the real progression gate', async () => {
    const locked = await fixture({ gold: 100 });
    const gate = await command(locked.session, locked.character.actorId, envelope('buy', {
      actorId: locked.character.actorId, offerId: 'offer:healing_potion', quantity: 1,
    }));
    expect(gate.statusCode).toBe(409);
    const forgedProgress = await command(locked.session, locked.character.actorId, envelope('buy', {
      actorId: locked.character.actorId, offerId: 'offer:healing_potion', quantity: 1, completedAreas: ['area:region_1'],
    }));
    expect(forgedProgress.statusCode).toBe(400);
    expect(await gold(locked.character.actorId)).toBe(100);
    const forged = await command(locked.session, locked.character.actorId, envelope('buy', {
      actorId: locked.character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1, price: 0,
    }));
    expect(forged.statusCode).toBe(400);
    expect(await gold(locked.character.actorId)).toBe(100);
    const unlocked = await fixture({ gold: 100, areaComplete: true });
    const success = await command(unlocked.session, unlocked.character.actorId, envelope('buy', {
      actorId: unlocked.character.actorId, offerId: 'offer:healing_potion', quantity: 1,
    }));
    expect(success.statusCode).toBe(200);
    expect(await gold(unlocked.character.actorId)).toBe(60);
  });

  it('serializes concurrent purchases against one balance and never drives gold or a stack below zero', async () => {
    const { session, character } = await fixture({ gold: 18 });
    const requests = [1, 2].map(() => command(session, character.actorId, envelope('buy', {
      actorId: character.actorId, offerId: 'offer:sap_tonic', quantity: 1,
    })));
    const results = await Promise.all(requests);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(await gold(character.actorId)).toBe(0);
    const holdings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(holdings.find(row => row.asset.kind === 'stack' && row.asset.item === 'item:sap_tonic')?.qty).toBe(1);
    expect(holdings.every(row => row.qty >= 0)).toBe(true);
  });

  it('equips, atomically replaces, unequips, and roundtrips unique items without changing their UUIDs or rolls', async () => {
    const { session, character } = await fixture({ sword: true });
    const [minted] = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId));
    if (!minted) throw new Error('missing fixture sword');
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:second-sword` }, [
      { actorId: character.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: 1 },
    ]));
    const instances = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId));
    const second = instances.find(item => item.id !== minted.id);
    if (!second) throw new Error('missing second fixture sword');
    await database.db.update(itemInstances).set({ rolls: { power: 11, affix: 'keen' } }).where(eq(itemInstances.id, second.id));
    const equipped = await command(session, character.actorId, envelope('equip', { actorId: character.actorId, itemId: minted.id, slot: 'weapon' }));
    expect(equipped.statusCode).toBe(200);
    const row = async (id: string) => (await database.db.select().from(itemInstances).where(eq(itemInstances.id, id)))[0];
    expect(await row(minted.id)).toMatchObject({ id: minted.id, container: 'equipped', slot: 'weapon', rolls: { power: 7, affix: 'steady' } });
    const secondEquip = await command(session, character.actorId,
      envelope('equip', { actorId: character.actorId, itemId: second.id, slot: 'weapon' }));
    expect(secondEquip.statusCode).toBe(200);
    expect(await row(minted.id)).toMatchObject({ container: 'inventory', slot: null, rolls: { power: 7, affix: 'steady' } });
    expect(await row(second.id)).toMatchObject({ container: 'equipped', slot: 'weapon', rolls: { power: 11, affix: 'keen' } });
    const unequipped = await command(session, character.actorId, envelope('unequip', { actorId: character.actorId, itemId: second.id }));
    expect(unequipped.statusCode).toBe(200);
    expect(await row(second.id)).toMatchObject({ id: second.id, container: 'inventory', slot: null, rolls: { power: 11, affix: 'keen' } });
    const stored = await command(session, character.actorId, envelope('move', {
      actorId: character.actorId, itemId: second.id, from: 'inventory', to: 'storage',
    }));
    expect(stored.statusCode).toBe(200);
    const restored = await command(session, character.actorId, envelope('move', {
      actorId: character.actorId, itemId: second.id, from: 'storage', to: 'inventory',
    }));
    expect(restored.statusCode).toBe(200);
    expect(await row(second.id)).toMatchObject({ id: second.id, container: 'inventory', rolls: { power: 11, affix: 'keen' } });
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('rejects invalid equipment type, slot, level, and non-owned equipment with no ledger change', async () => {
    const { session, character } = await fixture({ sword: true, vest: true });
    const sword = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.definition === SWORD);
    if (!sword) throw new Error('missing fixture sword');
    const before = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, character.actorId));
    for (const slot of ['chest', 'not-a-slot']) {
      const response = await command(session, character.actorId, envelope('equip', { actorId: character.actorId, itemId: sword.id, slot }));
      expect([400, 409]).toContain(response.statusCode);
    }
    const vest = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.definition === 'item:padded_vest');
    if (!vest) throw new Error('missing fixture equipment');
    const wrongType = await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:wrong-type` }, [
      { actorId: character.actorId, asset: { kind: 'unique_mint', item: 'item:minor_healing_potion' }, qty: 1 },
    ]));
    expect(wrongType.applied).toBe(true);
    const potion = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.definition === 'item:minor_healing_potion');
    if (!potion) throw new Error('missing non-equipment fixture instance');
    const badType = await command(session, character.actorId, envelope('equip', { actorId: character.actorId, itemId: potion.id, slot: 'weapon' }));
    expect([400, 409]).toContain(badType.statusCode);
    const underlevel = await command(session, character.actorId, envelope('equip', { actorId: character.actorId, itemId: vest.id, slot: 'chest' }));
    expect([400, 409]).toContain(underlevel.statusCode);
    const unowned = await command(session, character.actorId, envelope('equip', { actorId: character.actorId, itemId: randomUUID(), slot: 'weapon' }));
    expect([400, 404, 409]).toContain(unowned.statusCode);
    const after = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, character.actorId));
    expect(after).toEqual(before);
    expect(await database.db.transaction(tx => getHoldings(tx, character.actorId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: sword.id, container: 'inventory' }),
    ]));
  });

  it('moves the last stack unit through storage and rejects invalid quantities and forbidden containers', async () => {
    const { session, character } = await fixture({ potion: 1 });
    const moved = await command(session, character.actorId, envelope('move', {
      actorId: character.actorId, item: 'item:minor_healing_potion', quantity: 1, from: 'inventory', to: 'storage',
    }));
    expect(moved.statusCode).toBe(200);
    const back = await command(session, character.actorId, envelope('move', {
      actorId: character.actorId, item: 'item:minor_healing_potion', quantity: 1, from: 'storage', to: 'inventory',
    }));
    expect(back.statusCode).toBe(200);
    const consume = await command(session, character.actorId, envelope('move', {
      actorId: character.actorId, item: 'item:minor_healing_potion', quantity: 1, from: 'inventory', to: 'destroyed',
    }));
    expect(consume.statusCode).toBe(400);
    const buy = await command(session, character.actorId, envelope('buy', { actorId: character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1 }));
    // This fresh actor has no gold; failed purchase must not affect the fixture stack.
    expect(buy.statusCode).toBe(409);
    expect(await database.db.transaction(tx => getHoldings(tx, character.actorId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: { kind: 'stack', item: 'item:minor_healing_potion' }, container: 'inventory', qty: 1 }),
    ]));
    for (const quantity of [0, -1, 10_001]) {
      const bad = await command(session, character.actorId, envelope('move', {
        actorId: character.actorId, item: 'item:minor_healing_potion', quantity, from: 'inventory', to: 'storage',
      }));
      expect(bad.statusCode).toBe(400);
    }
    const swordFixture = await fixture({ sword: true });
    const swordRows = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, swordFixture.character.actorId));
    const sword = swordRows[0];
    if (!sword) throw new Error('missing move restriction sword');
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${swordFixture.character.actorId}:equip-for-move-test` }, [
      { actorId: swordFixture.character.actorId, asset: { kind: 'unique', itemId: sword.id }, qty: 1, from: 'inventory', to: 'equipped' },
    ], { equipment: { actorId: swordFixture.character.actorId, itemId: sword.id, slot: 'weapon' } }));
    const equippedMove = await command(swordFixture.session, swordFixture.character.actorId, envelope('move', {
      actorId: swordFixture.character.actorId, itemId: sword.id, from: 'equipped', to: 'storage',
    }));
    expect(equippedMove.statusCode).toBe(400);
    for (const from of ['escrow', 'run_bag', 'corpse']) {
      const denied = await command(swordFixture.session, swordFixture.character.actorId, envelope('move', {
        actorId: swordFixture.character.actorId, itemId: sword.id, from, to: 'inventory',
      }));
      expect(denied.statusCode).toBe(400);
    }
  });

  it('returns 404 for foreign ownership and applies origin protection to inventory routes', async () => {
    const owner = await fixture({ gold: 20 });
    const stranger = await guest();
    const payload = { actorId: owner.character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1 };
    expect((await inventory(stranger, owner.character.actorId)).statusCode).toBe(404);
    expect((await command(stranger, owner.character.actorId, envelope('buy', payload))).statusCode).toBe(404);
    expect((await app.inject({ url: '/merchant', headers: { ...headers(owner.session), origin: 'https://other.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/characters/${owner.character.actorId}/inventory/commands`, headers: {
      ...headers(owner.session), origin: 'https://other.example',
    }, payload: envelope('buy', payload) })).statusCode).toBe(403);
  });

  it('blocks every inventory mutation while live or on expedition, while own reads still work', async () => {
    const mutationKinds = [
      (actorId: string, itemId: string) => envelope('equip', { actorId, itemId, slot: 'weapon' }),
      (actorId: string, itemId: string) => envelope('unequip', { actorId, itemId }),
      (actorId: string) => envelope('move', { actorId, item: 'item:minor_healing_potion', quantity: 1, from: 'inventory', to: 'storage' }),
      (actorId: string, itemId: string) => envelope('move', { actorId, itemId, from: 'inventory', to: 'storage' }),
      (actorId: string) => envelope('buy', { actorId, offerId: 'offer:minor_healing_potion', quantity: 1 }),
    ];
    for (const state of ['live', 'expedition'] as const) {
      for (const [index, makeCommand] of mutationKinds.entries()) {
        const { session, character } = await fixture({ gold: 20, sword: true, potion: 1 });
        const [sword] = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId));
        if (!sword) throw new Error('missing fixture sword');
        if (index === 1) {
          await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:equipped` }, [
            { actorId: character.actorId, asset: { kind: 'unique', itemId: sword.id }, qty: 1, from: 'inventory', to: 'equipped' },
          ], { equipment: { actorId: character.actorId, itemId: sword.id, slot: 'weapon' } }));
        }
        const activityId = randomUUID();
        await database.db.transaction(tx => transitionActivity(tx, character.actorId,
          { state: 'none', activityId: null }, { state, activityId }));
        expect((await inventory(session, character.actorId)).statusCode).toBe(200);
        const response = await command(session, character.actorId, makeCommand(character.actorId, sword.id));
        expect(response.statusCode).toBe(409);
        await database.db.transaction(tx => transitionActivity(tx, character.actorId,
          { state, activityId }, { state: 'none', activityId: null }));
      }
    }
  });

  it('allows only one concurrent equip of the same unique instance and leaves a valid ledger', async () => {
    const { session, character } = await fixture({ sword: true });
    const [sword] = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId));
    if (!sword) throw new Error('missing fixture sword');
    const attempts = await Promise.all([1, 2].map(() => command(session, character.actorId,
      envelope('equip', { actorId: character.actorId, itemId: sword.id, slot: 'weapon' }))));
    expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
    expect(await database.db.transaction(tx => getHoldings(tx, character.actorId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: sword.id, container: 'equipped', slot: 'weapon', qty: 1 }),
    ]));
  });

  it('serializes two different instances competing for the same equipment slot', async () => {
    const { session, character } = await fixture({ sword: true });
    const first = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.definition === SWORD);
    if (!first) throw new Error('missing fixture sword');
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:slot-race-sword` }, [
      { actorId: character.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: 1 },
    ]));
    const second = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, character.actorId)))
      .find(item => item.id !== first.id);
    if (!second) throw new Error('missing second fixture sword');
    const attempts = await Promise.all([first, second].map(item => command(session, character.actorId,
      envelope('equip', { actorId: character.actorId, itemId: item.id, slot: 'weapon' }))));
    expect(attempts.map(response => response.statusCode)).toEqual([200, 200]);
    const holdings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(holdings.filter(row => row.container === 'equipped' && row.slot === 'weapon')).toHaveLength(1);
    expect(holdings.filter(row => row.asset.kind === 'unique')).toHaveLength(2);
    expect(holdings.filter(row => row.asset.kind === 'unique' && row.container === 'inventory')).toHaveLength(1);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('moves the last stack unit at most once under concurrent move commands', async () => {
    const { session, character } = await fixture({ potion: 1 });
    const attempts = await Promise.all([1, 2].map(() => command(session, character.actorId, envelope('move', {
      actorId: character.actorId, item: 'item:minor_healing_potion', quantity: 1, from: 'inventory', to: 'storage',
    }))));
    expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const holdings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(holdings.filter(row => row.asset.kind === 'stack' && row.asset.item === 'item:minor_healing_potion'))
      .toEqual([expect.objectContaining({ container: 'storage', qty: 1 })]);
    expect(holdings.every(row => row.qty >= 0)).toBe(true);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);
  });

  it('keeps purchase and expedition escrow concurrent loads ledger-consistent', async () => {
    const { session, character } = await fixture({ gold: 12, potion: 1, areaComplete: true });
    const purchase = command(session, character.actorId, envelope('buy', {
      actorId: character.actorId, offerId: 'offer:minor_healing_potion', quantity: 1,
    }));
    const start = app.inject({ method: 'POST', url: '/expeditions', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'expedition.start', payload: {
        actorId: character.actorId,
        request: { areaId: 'area:region_1', activityId: 'idle:region_1.hunt', durationMin: 60, paceBp: 10_000 },
        config: { consumables: [{ item: 'item:minor_healing_potion', qty: 1 },], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } },
      },
    } });
    const [purchased, started] = await Promise.all([purchase, start]);
    expect([200, 409]).toContain(purchased.statusCode);
    expect(started.statusCode).toBe(201);
    expect(await gold(character.actorId)).toBe(purchased.statusCode === 200 ? 0 : 12);
    const active = await database.db.select().from(expeditions).where(eq(expeditions.actorId, character.actorId));
    const activeIds = active.filter(expedition => expedition.status === 'running').map(expedition => expedition.id);
    expect(active.length).toBe(started.statusCode === 201 ? 1 : 0);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId], activeIds))).toEqual([]);
    expect((await database.db.transaction(tx => getHoldings(tx, character.actorId))).every(row => row.qty >= 0)).toBe(true);
  });
});
