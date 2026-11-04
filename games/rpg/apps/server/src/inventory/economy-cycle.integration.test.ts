/** #56 bounded new-player economy proof through authenticated HTTP and live WebSockets (real PostgreSQL). */
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { actors, assetBalances, checkLedgerInvariants, createDatabase, itemInstances, liveSessions, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import type { InventorySnapshotDto } from '@rpg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createRpgLiveHost } from '../live/index.ts';
import type { RpgLiveHost } from '../live/index.ts';
import { characters } from '../characters/schema.ts';
import { STARTER_KIT_ITEMS } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for the new-player economy PostgreSQL proof');
const token = () => randomBytes(32).toString('base64url');
const REGION = 'area:region_1';
const PORTAL_EXIT = 'exit:region_1.portal_clearing.overgrown_causeway';
const RETURN_EXIT = 'exit:region_1.overgrown_causeway.portal_clearing';
const GLOWCAP = 'item:glowcap';
const POTION = 'item:minor_healing_potion';
const RUN_BAG = (instanceId: string) => `run_bag:${instanceId}`;

interface Session { accountId: string; sessionToken: string }
interface Hero { actorId: string; accountId: string }
type Message = Record<string, unknown> & { type: string };

describe.skipIf(!adminUrl)('new-player bounded economy cycle (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let liveHost: RpgLiveHost;
  let directory: string;
  let websocketUrl: string;
  const databaseName = `economy_cycle_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_800_000_000_000);
  const sockets = new Set<WebSocket>();
  let nextRemoteAddress = 1;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rpg-economy-cycle-'));
    const sourceContent = fileURLToPath(new URL('../../../../content', import.meta.url));
    const compiled = compileContentDirectory(sourceContent, plugin);
    if (!compiled.ok) throw new Error(`authored content failed compilation: ${JSON.stringify(compiled.errors)}`);
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(compiled.bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    liveHost = createRpgLiveHost({ autoStart: false, nodeId: 'economy-cycle', leaseMs: 30_000, graceMs: 60_000 });
    app = await createRpgServer(config, { clock, live: liveHost });
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
  async function createHero(session: Session): Promise<Hero> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Economy cycle hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<Hero>();
  }
  async function inventory(session: Session, actorId: string) {
    const response = await app.inject({ url: `/characters/${actorId}/inventory`, headers: headers(session) });
    expect(response.statusCode).toBe(200);
    return response.json<InventorySnapshotDto>();
  }
  async function inventoryCommand(session: Session, actorId: string, operation: string, payload: Record<string, unknown>, commandId = randomUUID()) {
    return app.inject({ method: 'POST', url: `/characters/${actorId}/inventory/commands`, headers: headers(session), payload: {
      command_id: commandId, operation: `inventory.${operation}`, payload: { actorId, ...payload },
    } });
  }
  async function gold(actorId: string, container = 'inventory'): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.filter(row => row.assetKind === 'currency' && row.assetRef === 'gold' && row.container === container)
      .reduce((sum, row) => sum + row.qty, 0);
  }
  async function qty(actorId: string, item: string, container = 'inventory'): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.filter(row => row.assetKind === 'stack' && row.assetRef === item && row.container === container)
      .reduce((sum, row) => sum + row.qty, 0);
  }
  async function waitLeaseRelease(accountId: string) {
    for (let attempt = 0; attempt < 250; attempt++) {
      if ((await database.db.select().from(liveSessions).where(eq(liveSessions.accountId, accountId))).length === 0) return;
      await delay(10);
    }
    throw new Error('authenticated WebSocket lease did not release within the bounded cleanup interval');
  }

  class Client {
    readonly socket: WebSocket;
    readonly inbox: Message[] = [];
    closeDetails = 'not closed';
    constructor(session: Session) {
      this.socket = new WebSocket(websocketUrl, { headers: headers(session) });
      sockets.add(this.socket);
      this.socket.on('message', data => this.inbox.push(JSON.parse(data.toString()) as Message));
      this.socket.on('error', error => { this.closeDetails = `socket error: ${error.message}`; });
      this.socket.on('close', (code, reason) => { this.closeDetails = `${code}: ${reason.toString()}`; });
    }
    async wait(predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const errorIndex = this.inbox.findIndex(message => message.type === 'live.error');
        if (errorIndex >= 0) throw new Error(`live host rejected request: ${JSON.stringify(this.inbox.splice(errorIndex, 1)[0])}`);
        const index = this.inbox.findIndex(predicate);
        if (index >= 0) return this.inbox.splice(index, 1)[0] as Message;
        if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`socket closed before expected frame (${this.closeDetails})`);
        await delay(5);
      }
      throw new Error('timed out waiting for authenticated live frame');
    }
    async ready() { await this.wait(message => message.type === 'authenticated'); }
    request(command: Record<string, unknown>) { this.socket.send(JSON.stringify({ type: 'command', command })); }
    async drop() {
      if (this.socket.readyState === WebSocket.CLOSED) return;
      const closed = once(this.socket, 'close');
      this.socket.terminate();
      await closed;
    }
  }
  async function liveCommand(client: Client, actorId: string, instanceId: string, command: Record<string, unknown>, commandId = randomUUID()) {
    client.request({ op: 'live.command', actorId, instanceId, commandId, command });
    return client.wait(message => message.type === 'live.ack' && message['commandId'] === commandId);
  }
  async function attach(client: Client, actorId: string, instanceId: string) {
    client.request({ op: 'live.attach', actorId, instanceId });
    const frames: Message[] = [];
    while (!frames.some(message => message.type === 'live.attached') || !frames.some(message => message.type === 'live.snapshot')) {
      frames.push(await client.wait(message => message.type === 'live.attached' || message.type === 'live.snapshot'));
    }
  }
  async function start(session: Session, actorId: string, supplies: { item: string; qty: number }[] = []) {
    const response = await app.inject({ method: 'POST', url: '/live/start', headers: headers(session), payload: {
      commandId: randomUUID(), actorId, areaId: REGION, supplies,
    } });
    expect(response.statusCode, `live start failed: ${response.body}`).toBe(200);
    return response.json<{ instanceId: string }>().instanceId;
  }
  async function actor(actorId: string) {
    const [row] = await database.db.select().from(actors).where(eq(actors.actorId, actorId));
    if (!row) throw new Error('new player actor row disappeared');
    return row;
  }

  it('gathers, banks, sells, and buys through bounded new instances while preserving the character', async () => {
    const session = await guest();
    const hero = await createHero(session);
    const initial = await inventory(session, hero.actorId);
    expect(initial).toMatchObject({ actorVersion: 0, level: 1,
      starterKit: { claimed: false, items: STARTER_KIT_ITEMS }, activityState: 'none' });
    expect(initial.holdings).toEqual([]);
    const [newCharacter] = await database.db.select().from(characters).where(eq(characters.actorId, hero.actorId));
    expect(newCharacter).toMatchObject({ level: 1, xp: 0 });
    expect(await gold(hero.actorId)).toBe(0);
    expect(await qty(hero.actorId, GLOWCAP)).toBe(0);
    const merchantResponse = await app.inject({ url: '/merchant', headers: headers(session) });
    expect(merchantResponse.statusCode).toBe(200);
    const merchant = merchantResponse.json<{ merchants: { offers: { id: string; item: string; buyPrice: { amount: number } }[] }[];
      sellOffers: { item: string; unitPrice: { amount: number } }[] }>();
    const potionOffer = merchant.merchants.flatMap(row => row.offers).find(row => row.item === POTION);
    const glowcapSell = merchant.sellOffers.find(row => row.item === GLOWCAP);
    expect(potionOffer, 'compiled authored merchant must offer minor healing potion').toBeDefined();
    expect(glowcapSell, 'compiled authored merchant must buy glowcap').toBeDefined();
    expect(potionOffer?.buyPrice.amount).toBe(12);
    expect(glowcapSell?.unitPrice.amount).toBe(2);
    const price = potionOffer?.buyPrice.amount as number;
    const unitValue = glowcapSell?.unitPrice.amount as number;
    const maximumCycles = Math.ceil(price / unitValue);
    expect(maximumCycles).toBeLessThanOrEqual(20);

    const claimId = randomUUID();
    const claim = await inventoryCommand(session, hero.actorId, 'claimStarterKit', {}, claimId);
    expect(claim.statusCode).toBe(200);
    expect((await inventoryCommand(session, hero.actorId, 'claimStarterKit', {}, claimId)).json()).toEqual(claim.json());
    const kit = await inventory(session, hero.actorId);
    const kitItems = kit.holdings.filter(row => row.container === 'inventory' && row.itemId &&
      STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number]));
    expect(kitItems).toHaveLength(3);
    for (const holding of kitItems) {
      const slot = kit.catalog.items.find(item => item.id === holding.definition)?.slot;
      expect(slot, `starter kit item ${holding.definition} must have an authored equipment slot`).toBeDefined();
      const response = await inventoryCommand(session, hero.actorId, 'equip', { itemId: holding.itemId, slot });
      expect(response.statusCode).toBe(200);
    }
    const equippedBefore = (await inventory(session, hero.actorId)).holdings.filter(row => row.container === 'equipped')
      .map(row => ({ itemId: row.itemId, definition: row.definition, slot: row.slot })).sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    expect(equippedBefore).toHaveLength(3);

    let cycles = 0;
    let totalGathered = 0;
    let totalBanked = 0;
    let totalSold = 0;
    let materialGold = 0;
    let cycleGold = 0;
    while (cycleGold < price && cycles < maximumCycles) {
      cycles++;
      const instanceId = await start(session, hero.actorId);
      const client = new Client(session);
      try {
        await client.ready();
        await attach(client, hero.actorId, instanceId);
        const busySale = await inventoryCommand(session, hero.actorId, 'sellMaterial', { item: GLOWCAP, quantity: 1 });
        expect(busySale.statusCode).toBe(409);
        expect(busySale.json()).toEqual({ error: 'busy' });
        expect((await inventory(session, hero.actorId)).activityState).toBe('live');
        const travel = await liveCommand(client, hero.actorId, instanceId, { type: 'travel', exitId: PORTAL_EXIT });
        expect(travel).toMatchObject({ status: 'applied', duplicate: false });
        const causeway = await app.inject({ url: `/live/current/${hero.actorId}`, headers: headers(session) });
        expect(causeway.statusCode).toBe(200);
        const currentView = causeway.json<{ current: { view: { resources: { nodeId: string; resource: string; gathered: boolean }[] } } }>().current.view;
        const resource = currentView.resources.find(row => row.resource === 'res:glowcap' && !row.gathered);
        expect(resource, `authored current view has no available glowcap node in cycle ${cycles}`).toBeDefined();
        const gatherId = randomUUID();
        const gatherAck = await liveCommand(client, hero.actorId, instanceId, { type: 'gather', nodeId: resource?.nodeId }, gatherId);
        expect(gatherAck).toMatchObject({ status: 'applied', duplicate: false });
        const gatheredEvent = await client.wait(message => message.type === 'live.event' &&
          (message['event'] as { type?: string } | undefined)?.type === 'gathered');
        const drops = ((gatheredEvent['event'] as { drops: { item: string; qty: number }[] }).drops)
          .filter(drop => drop.item === GLOWCAP).reduce((sum, drop) => sum + drop.qty, 0);
        expect(drops, `authored glowcap gather yielded ${drops}; cycle ${cycles}`).toBeGreaterThanOrEqual(1);
        expect(drops).toBeLessThanOrEqual(2);
        const bagQty = await qty(hero.actorId, GLOWCAP, RUN_BAG(instanceId));
        expect(bagQty).toBe(drops);
        expect(await qty(hero.actorId, GLOWCAP)).toBe(totalBanked - totalSold);
        expect(await liveCommand(client, hero.actorId, instanceId, { type: 'gather', nodeId: resource?.nodeId }, gatherId))
          .toMatchObject({ status: 'applied', duplicate: true });
        expect(await qty(hero.actorId, GLOWCAP, RUN_BAG(instanceId))).toBe(drops);
        expect(await liveCommand(client, hero.actorId, instanceId, { type: 'gather', nodeId: resource?.nodeId }))
          .toMatchObject({ status: 'rejected', reason: 'already_gathered', duplicate: false });
        expect(await qty(hero.actorId, GLOWCAP, RUN_BAG(instanceId))).toBe(drops);
        expect(await liveCommand(client, hero.actorId, instanceId, { type: 'travel', exitId: RETURN_EXIT }))
          .toMatchObject({ status: 'applied' });
        expect(await liveCommand(client, hero.actorId, instanceId, { type: 'returnToSanctuary' }))
          .toMatchObject({ status: 'applied' });
        totalGathered += drops;
        totalBanked += bagQty;
      } finally {
        await client.drop();
        await waitLeaseRelease(session.accountId);
      }
      expect(await qty(hero.actorId, GLOWCAP)).toBe(totalBanked - totalSold);
      const snapshot = await inventory(session, hero.actorId);
      const saleQty = await qty(hero.actorId, GLOWCAP);
      const saleId = randomUUID();
      const sale = await inventoryCommand(session, hero.actorId, 'sellMaterial', { item: GLOWCAP, quantity: saleQty }, saleId);
      expect(sale.statusCode).toBe(200);
      const goldEarned = saleQty * unitValue;
      materialGold += goldEarned;
      totalSold += saleQty;
      cycleGold += goldEarned;
      const goldAfterSale = await gold(hero.actorId);
      expect(goldAfterSale).toBe(cycleGold);
      expect((await inventoryCommand(session, hero.actorId, 'sellMaterial', { item: GLOWCAP, quantity: saleQty }, saleId)).json())
        .toEqual(sale.json());
      expect(await gold(hero.actorId)).toBe(cycleGold);
      expect((await inventory(session, hero.actorId)).actorVersion).toBe(snapshot.actorVersion + 1);
      expect(await qty(hero.actorId, GLOWCAP, RUN_BAG(instanceId))).toBe(0);
      expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [hero.actorId]))).toEqual([]);
    }
    expect(cycleGold, `only ${cycles} cycles ran; accumulated ${cycleGold} gold but potion costs ${price}`).toBeGreaterThanOrEqual(price);
    expect(cycles).toBeLessThanOrEqual(maximumCycles);
    const buyId = randomUUID();
    const beforeBuy = await inventory(session, hero.actorId);
    const buy = await inventoryCommand(session, hero.actorId, 'buy', { offerId: potionOffer?.id, quantity: 1 }, buyId);
    expect(buy.statusCode).toBe(200);
    const finalGold = cycleGold - price;
    expect(await gold(hero.actorId)).toBe(finalGold);
    expect(await qty(hero.actorId, POTION)).toBe(1);
    expect((await inventoryCommand(session, hero.actorId, 'buy', { offerId: potionOffer?.id, quantity: 1 }, buyId)).json())
      .toEqual(buy.json());
    expect(await gold(hero.actorId)).toBe(finalGold);
    expect(await qty(hero.actorId, POTION)).toBe(1);
    const purchased = await inventory(session, hero.actorId);
    expect(purchased.actorVersion).toBe(beforeBuy.actorVersion + 1);
    expect(purchased).toMatchObject({ level: 1, activityState: 'none' });
    expect(purchased.holdings.filter(row => row.container === 'equipped')
      .map(row => ({ itemId: row.itemId, definition: row.definition, slot: row.slot }))
      .sort((a, b) => String(a.slot).localeCompare(String(b.slot)))).toEqual(equippedBefore);

    const finalInstance = await start(session, hero.actorId, [{ item: POTION, qty: 1 }]);
    const current = await app.inject({ url: `/live/current/${hero.actorId}`, headers: headers(session) });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ current: { instanceId: finalInstance,
      view: { heroes: [expect.objectContaining({ actorId: hero.actorId, consumables: expect.arrayContaining([
        expect.objectContaining({ item: POTION, qty: 1 }),
      ]) })] } } });
    const client = new Client(session);
    try {
      await client.ready();
      await attach(client, hero.actorId, finalInstance);
      const finalSnapshot = await inventory(session, hero.actorId);
      expect(finalSnapshot.activityState).toBe('live');
      expect(await qty(hero.actorId, POTION)).toBe(1);
      // The live start view exposes the same equipped set and selected consumable.
      const row = await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, hero.actorId));
      expect(row.filter(item => item.container === 'equipped').map(item => item.definition).sort())
        .toEqual(equippedBefore.map(item => item.definition).sort());
      // Avoid using the potion; return from the portal to prove it remains exactly once.
      expect(await liveCommand(client, hero.actorId, finalInstance, { type: 'returnToSanctuary' }))
        .toMatchObject({ status: 'applied' });
    } finally {
      await client.drop();
      await waitLeaseRelease(session.accountId);
    }
    const completed = await inventory(session, hero.actorId);
    expect(completed).toMatchObject({ level: 1, activityState: 'none' });
    expect(await qty(hero.actorId, POTION)).toBe(1);
    expect(await gold(hero.actorId)).toBe(finalGold);
    expect(totalGathered).toBe(totalBanked);
    expect(totalBanked).toBe(totalSold);
    expect(await qty(hero.actorId, GLOWCAP)).toBe(0);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [hero.actorId]))).toEqual([]);
    const [storedCharacter] = await database.db.select().from(characters).where(eq(characters.actorId, hero.actorId));
    if (!storedCharacter) throw new Error('new player character row disappeared');
    expect(storedCharacter).toMatchObject({ level: 1, xp: 0 });
    const storedActor = await actor(hero.actorId);
    expect(storedActor).toMatchObject({ activityState: 'none', activityId: null });
    console.info(JSON.stringify({ proof: 'newplayer-economy-cycle', cycles, gathered: totalGathered, banked: totalBanked,
      sold: totalSold, materialGold, spent: price, finalGold, potionQty: await qty(hero.actorId, POTION),
      level: completed.level, xp: storedCharacter.xp }));
  }, 120_000);
});
