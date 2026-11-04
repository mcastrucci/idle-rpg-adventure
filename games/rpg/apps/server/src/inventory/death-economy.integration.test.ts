/** #56 matched-input survival/death accounting through authored Region 1 (real PostgreSQL). */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { actors, applyLedgerDeltas, assetBalances, checkLedgerInvariants, createDatabase, itemInstances, liveInstances,
  liveSessions, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createRpgLiveHost } from '../live/index.ts';
import type { RpgLiveHost } from '../live/index.ts';
import { liveDeaths } from '../live/death-schema.ts';
import { characters } from '../characters/schema.ts';
import { STARTER_KIT_ITEMS } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for the death economy PostgreSQL proof');
const token = () => randomBytes(32).toString('base64url');
const AREA = 'area:region_1';
const CAUSEWAY = 'loc:region_1.overgrown_causeway';
const OUTBOUND = 'exit:region_1.portal_clearing.overgrown_causeway';
const INBOUND = 'exit:region_1.overgrown_causeway.portal_clearing';
const GLOWCAP = 'item:glowcap';
const POTION = 'item:minor_healing_potion';
const RUN_BAG = (instanceId: string) => `run_bag:${instanceId}`;
const CORPSE = (deathId: string) => `corpse:${deathId}`;

interface Session { accountId: string; sessionToken: string }
interface Hero { actorId: string; accountId: string }
interface Arm {
  session: Session;
  hero: Hero;
  equipped: { itemId: string; definition: string; slot: string | null }[];
  consumed: number;
}

describe.skipIf(!adminUrl)('matched-input survival/death economy accounting (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let live: RpgLiveHost;
  let directory: string;
  const databaseName = `death_economy_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);
  let remoteAddress = 1;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rpg-death-economy-'));
    const source = fileURLToPath(new URL('../../../../content', import.meta.url));
    const compiled = compileContentDirectory(source, plugin);
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
    live = createRpgLiveHost({ autoStart: false, nodeId: 'death-economy-proof', leaseMs: 30_000, graceMs: 60_000 });
    app = await createRpgServer(config, { clock, live });
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);

  afterAll(async () => {
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
    const response = await app.inject({ method: 'POST', url: '/auth/guest', remoteAddress: `127.0.0.${remoteAddress++}`,
      payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function createHero(session: Session, name: string): Promise<Hero> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<Hero>();
  }
  async function inventory(session: Session, actorId: string) {
    const response = await app.inject({ url: `/characters/${actorId}/inventory`, headers: headers(session) });
    expect(response.statusCode).toBe(200);
    return response.json<{ holdings: { asset: { kind: string; item?: string; currency?: string }; itemId?: string;
      definition?: string; container: string; slot?: string | null; qty: number }[]; catalog: { items: { id: string; slot?: string }[] } }>();
  }
  async function inventoryCommand(session: Session, actorId: string, operation: string, payload: Record<string, unknown>, commandId = randomUUID()) {
    return app.inject({ method: 'POST', url: `/characters/${actorId}/inventory/commands`, headers: headers(session), payload: {
      command_id: commandId, operation: `inventory.${operation}`, payload: { actorId, ...payload },
    } });
  }
  async function createMatchedArm(name: string): Promise<Arm> {
    const session = await guest();
    const hero = await createHero(session, name);
    // Controlled test starting state: 80 L1 XP and three potions on each actor. This lets the run expose a non-zero
    // current death loss, carry two selected supplies, and keep one potion in storage without claiming fresh-player data.
    await database.db.update(characters).set({ xp: 80 }).where(eq(characters.actorId, hero.actorId));
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${hero.actorId}:death-economy-start` }, [
      { actorId: hero.actorId, asset: { kind: 'stack', item: POTION }, qty: 3 },
    ]));
    const funded = await inventory(session, hero.actorId);
    expect(funded.holdings).toMatchObject([{ asset: { kind: 'stack', item: POTION }, container: 'inventory', qty: 3 }]);
    const claim = await inventoryCommand(session, hero.actorId, 'claimStarterKit', {});
    expect(claim.statusCode).toBe(200);
    const kit = await inventory(session, hero.actorId);
    const kitHoldings = kit.holdings.filter(row => row.container === 'inventory' && row.itemId &&
      STARTER_KIT_ITEMS.includes(row.definition as typeof STARTER_KIT_ITEMS[number]));
    expect(kitHoldings).toHaveLength(3);
    for (const holding of kitHoldings) {
      const slot = kit.catalog.items.find(item => item.id === holding.definition)?.slot;
      expect(slot).toBeDefined();
      expect((await inventoryCommand(session, hero.actorId, 'equip', { itemId: holding.itemId, slot })).statusCode).toBe(200);
    }
    expect((await inventoryCommand(session, hero.actorId, 'move', { item: POTION, quantity: 1, from: 'inventory', to: 'storage' })).statusCode).toBe(200);
    const prepared = await inventory(session, hero.actorId);
    expect(prepared.holdings.filter(row => row.container === 'inventory' && row.asset.kind === 'stack' && row.asset.item === POTION))
      .toMatchObject([{ qty: 2 }]);
    const equipped = prepared.holdings.filter(row => row.container === 'equipped')
      .map(row => ({ itemId: row.itemId as string, definition: row.definition as string, slot: row.slot ?? null }))
      .sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    return { session, hero, equipped, consumed: 0 };
  }
  async function start(arm: Arm, supplies: number) {
    const response = await app.inject({ method: 'POST', url: '/live/start', headers: headers(arm.session), payload: {
      commandId: randomUUID(), actorId: arm.hero.actorId, areaId: AREA, supplies: [{ item: POTION, qty: supplies }],
    } });
    expect(response.statusCode, `live start failed: ${response.body}`).toBe(200);
    const instanceId = response.json<{ instanceId: string }>().instanceId;
    await live.host().attach(instanceId, arm.hero.actorId, arm.hero.accountId, { id: randomUUID(), push: () => {} });
    return instanceId;
  }
  async function command(arm: Arm, instanceId: string, value: Record<string, unknown>, commandId = randomUUID()) {
    return live.host().submit(instanceId, arm.hero.actorId, arm.hero.accountId, commandId, value as never);
  }
  async function balance(actorId: string, assetRef: string, container: string): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.filter(row => row.assetRef === assetRef && row.container === container).reduce((sum, row) => sum + row.qty, 0);
  }
  async function advance(instanceId: string, until: () => boolean, maxMs = 900_000) {
    for (let elapsed = 0; elapsed < maxMs && !until(); elapsed += 500) {
      clock.advance(500);
      await live.host().pump();
    }
    expect(until(), `live instance ${instanceId} did not reach its bounded checkpoint`).toBe(true);
  }
  async function travel(arm: Arm, instanceId: string, exitId: string) {
    expect(await command(arm, instanceId, { type: 'travel', exitId })).toMatchObject({ ack: { status: 'applied' }, duplicate: false });
  }
  async function gather(arm: Arm, instanceId: string): Promise<{ commandId: string; nodeId: string; qty: number }> {
    const view = await app.inject({ url: `/live/current/${arm.hero.actorId}`, headers: headers(arm.session) });
    expect(view.statusCode).toBe(200);
    const resources = view.json<{ current: { view: { resources: { nodeId: string; resource: string; gathered: boolean }[] } } }>()
      .current.view.resources;
    const node = resources.find(row => row.resource === 'res:glowcap' && !row.gathered);
    expect(node).toBeDefined();
    const commandId = randomUUID();
    expect(await command(arm, instanceId, { type: 'gather', nodeId: node?.nodeId }, commandId))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    await advance(instanceId, () => live.host().inspect(instanceId)?.state.gathered.some(value => value.endsWith(`/${node?.nodeId}`)) ?? false);
    const bagQty = await balance(arm.hero.actorId, GLOWCAP, RUN_BAG(instanceId));
    expect(bagQty).toBeGreaterThanOrEqual(1);
    expect(bagQty).toBeLessThanOrEqual(2);
    expect(await command(arm, instanceId, { type: 'gather', nodeId: node?.nodeId }, commandId))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: true });
    expect(await balance(arm.hero.actorId, GLOWCAP, RUN_BAG(instanceId))).toBe(bagQty);
    return { commandId, nodeId: node?.nodeId as string, qty: bagQty };
  }
  async function returnFromCauseway(arm: Arm, instanceId: string) {
    await travel(arm, instanceId, INBOUND);
    expect(await command(arm, instanceId, { type: 'returnToSanctuary' })).toMatchObject({ ack: { status: 'applied' } });
    await advance(instanceId, () => !live.host().has(instanceId));
  }
  async function assertSanctuary(arm: Arm) {
    const [actor] = await database.db.select().from(actors).where(eq(actors.actorId, arm.hero.actorId));
    expect(actor?.activityState).toBe('none');
    expect(await database.db.select().from(liveSessions).where(eq(liveSessions.accountId, arm.hero.accountId))).toHaveLength(0);
  }

  it('compares safe banking with a real authored death, corpse recovery, sales, supply use, and replay accounting', async () => {
    const survivor = await createMatchedArm('Survival ledger arm');
    const fallen = await createMatchedArm('Death ledger arm');
    const [survivorCharacter] = await database.db.select().from(characters).where(eq(characters.actorId, survivor.hero.actorId));
    const [fallenCharacterBefore] = await database.db.select().from(characters).where(eq(characters.actorId, fallen.hero.actorId));
    expect({ level: fallenCharacterBefore?.level, xp: fallenCharacterBefore?.xp, attributes: fallenCharacterBefore?.attributes,
      skillLoadout: fallenCharacterBefore?.skillLoadout, automationRules: fallenCharacterBefore?.automationRules })
      .toEqual({ level: survivorCharacter?.level, xp: survivorCharacter?.xp, attributes: survivorCharacter?.attributes,
        skillLoadout: survivorCharacter?.skillLoadout, automationRules: survivorCharacter?.automationRules });
    for (const arm of [survivor, fallen]) {
      const rows = await inventory(arm.session, arm.hero.actorId);
      expect(rows.holdings.filter(row => row.container === 'equipped').map(row => row.definition).sort())
        .toEqual([...STARTER_KIT_ITEMS].sort());
      expect(await balance(arm.hero.actorId, POTION, 'inventory')).toBe(2);
      expect(await balance(arm.hero.actorId, POTION, 'storage')).toBe(1);
      expect(await balance(arm.hero.actorId, 'gold', 'inventory')).toBe(0);
      expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [arm.hero.actorId]))).toEqual([]);
    }

    // Survival arm gathers at the unchanged authored causeway, then returns without engaging its optional encounter.
    const survivorInstance = await start(survivor, 2);
    await travel(survivor, survivorInstance, OUTBOUND);
    const survivedGather = await gather(survivor, survivorInstance);
    expect(await command(survivor, survivorInstance, { type: 'gather', nodeId: survivedGather.nodeId }))
      .toMatchObject({ ack: { status: 'rejected', reason: 'already_gathered' }, duplicate: false });
    expect(await balance(survivor.hero.actorId, GLOWCAP, RUN_BAG(survivorInstance))).toBe(survivedGather.qty);
    await returnFromCauseway(survivor, survivorInstance);
    await assertSanctuary(survivor);
    expect(await balance(survivor.hero.actorId, GLOWCAP, 'inventory')).toBe(survivedGather.qty);
    expect(await balance(survivor.hero.actorId, GLOWCAP, RUN_BAG(survivorInstance))).toBe(0);
    expect(await balance(survivor.hero.actorId, POTION, 'inventory')).toBe(2);

    // Death arm uses the same authored route/loadout/supply count, chooses one normally rolled non-boss group,
    // disables hero attacks, and uses exactly one carried potion before allowing the authored enemy to finish the run.
    const deathInstance = await start(fallen, 2);
    await travel(fallen, deathInstance, OUTBOUND);
    const fallenGather = await gather(fallen, deathInstance);
    const current = await app.inject({ url: `/live/current/${fallen.hero.actorId}`, headers: headers(fallen.session) });
    const groups = current.json<{ current: { view: { groups: { id: string; boss: boolean; defeated: boolean }[] } } }>()
      .current.view.groups;
    const target = groups.find(group => !group.boss && !group.defeated);
    expect(target, 'authored Region 1 causeway should expose an optional normal group').toBeDefined();
    expect(await command(fallen, deathInstance, { type: 'engage', groupId: target?.id }))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    expect(await command(fallen, deathInstance, { type: 'setAuto', auto: false }))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    const runtime = () => live.host().inspect(deathInstance)?.state;
    await advance(deathInstance, () => {
      const combat = runtime()?.combat;
      const hero = combat?.actors.find(actor => actor.id === fallen.hero.actorId);
      return Boolean(hero && hero.hp < hero.stats.maxHp);
    });
    expect(await command(fallen, deathInstance, { type: 'useConsumable', itemId: POTION }))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    await advance(deathInstance, () => {
      const actor = runtime()?.combat?.actors.find(candidate => candidate.id === fallen.hero.actorId);
      return actor?.consumables.find(stack => stack.item === POTION)?.qty === 1;
    });
    // Combat consumption is reflected in the instance immediately; its ledger debit is deferred until combat closes.
    expect(await balance(fallen.hero.actorId, POTION, 'inventory')).toBe(2);
    await advance(deathInstance, () => !live.host().has(deathInstance));
    const [closed] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, deathInstance));
    expect(closed).toMatchObject({ status: 'closed', outcome: 'defeated' });
    expect(await balance(fallen.hero.actorId, POTION, 'inventory')).toBe(1);

    const deaths = await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, fallen.hero.actorId));
    const death = deaths.at(-1);
    expect(death).toMatchObject({ instanceId: deathInstance, areaId: AREA, locationId: CAUSEWAY, status: 'active' });
    expect(death).toMatchObject({ xpBeforeTotal: 80, xpLost: 8, xpAfterTotal: 72 });
    expect(await balance(fallen.hero.actorId, GLOWCAP, RUN_BAG(deathInstance))).toBe(0);
    expect(await balance(fallen.hero.actorId, GLOWCAP, CORPSE(death?.deathId as string))).toBe(fallenGather.qty);
    expect(await balance(fallen.hero.actorId, POTION, 'storage')).toBe(1);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [fallen.hero.actorId]))).toEqual([]);

    // Recover through the public current route and interaction command, then explicitly return to bank the corpse.
    const recoveryInstance = await start(fallen, 1);
    await travel(fallen, recoveryInstance, OUTBOUND);
    const corpseId = `corpse:${death?.deathId}`;
    const recoveryCommandId = randomUUID();
    expect(await command(fallen, recoveryInstance, { type: 'interact', hotspotId: corpseId }, recoveryCommandId))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    expect(await command(fallen, recoveryInstance, { type: 'interact', hotspotId: corpseId }, recoveryCommandId))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: true });
    expect(await balance(fallen.hero.actorId, GLOWCAP, CORPSE(death?.deathId as string))).toBe(0);
    expect(await balance(fallen.hero.actorId, GLOWCAP, RUN_BAG(recoveryInstance))).toBe(fallenGather.qty);
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.deathId, death?.deathId as string)))[0]?.status)
      .toBe('recovered');
    await returnFromCauseway(fallen, recoveryInstance);
    await assertSanctuary(fallen);
    expect(await balance(fallen.hero.actorId, GLOWCAP, 'inventory')).toBe(fallenGather.qty);
    expect(await balance(fallen.hero.actorId, POTION, 'inventory')).toBe(1);
    expect(await balance(fallen.hero.actorId, POTION, 'storage')).toBe(1);

    // Sale converts exactly the recovered/banked materials into authored gold; replaying the same command is inert.
    const merchant = await app.inject({ url: '/merchant', headers: headers(survivor.session) });
    expect(merchant.statusCode).toBe(200);
    const glowcapPrice = merchant.json<{ sellOffers: { item: string; unitPrice: { amount: number } }[] }>()
      .sellOffers.find(offer => offer.item === GLOWCAP)?.unitPrice.amount;
    expect(glowcapPrice).toBe(2);
    for (const arm of [survivor, fallen]) {
      const quantity = arm === survivor ? survivedGather.qty : fallenGather.qty;
      const saleId = randomUUID();
      const sale = await inventoryCommand(arm.session, arm.hero.actorId, 'sellMaterial', { item: GLOWCAP, quantity }, saleId);
      expect(sale.statusCode).toBe(200);
      expect((await inventoryCommand(arm.session, arm.hero.actorId, 'sellMaterial', { item: GLOWCAP, quantity }, saleId)).json())
        .toEqual(sale.json());
      expect(await balance(arm.hero.actorId, GLOWCAP, 'inventory')).toBe(0);
      expect(await balance(arm.hero.actorId, 'gold', 'inventory')).toBe(quantity * (glowcapPrice as number));
      expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [arm.hero.actorId]))).toEqual([]);
    }
    const [fallenCharacter] = await database.db.select().from(characters).where(eq(characters.actorId, fallen.hero.actorId));
    const [survivingCharacter] = await database.db.select().from(characters).where(eq(characters.actorId, survivor.hero.actorId));
    expect(fallenCharacter).toMatchObject({ level: 1, xp: 72 });
    expect(survivingCharacter).toMatchObject({ level: 1, xp: 80 });
    fallen.consumed = 1;
    expect(await balance(fallen.hero.actorId, POTION, 'inventory') + fallen.consumed).toBe(2);
    expect(await balance(survivor.hero.actorId, POTION, 'inventory')).toBe(2);
    for (const arm of [survivor, fallen]) {
      const equippedAfter = (await inventory(arm.session, arm.hero.actorId)).holdings.filter(row => row.container === 'equipped')
        .map(row => ({ itemId: row.itemId, definition: row.definition, slot: row.slot ?? null }))
        .sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
      expect(equippedAfter).toEqual(arm.equipped);
      expect(await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, arm.hero.actorId)))
        .toEqual(expect.arrayContaining(arm.equipped.map(item => expect.objectContaining({
          id: item.itemId, definition: item.definition, container: 'equipped', slot: item.slot,
        }))));
    }

    console.info(JSON.stringify({ proof: 'matched-input-authored-r1-survival-v-death-accounting',
      arms: { survival: { gathered: survivedGather.qty, banked: survivedGather.qty, sold: survivedGather.qty,
        materialGold: survivedGather.qty * (glowcapPrice as number), potionConsumed: 0 },
      deathRecovered: { gathered: fallenGather.qty, corpse: fallenGather.qty, recovered: fallenGather.qty,
        banked: fallenGather.qty, sold: fallenGather.qty, materialGold: fallenGather.qty * (glowcapPrice as number), potionConsumed: 1,
        xpLost: death?.xpLost } }, deterministicSeedReplay: false }));
  }, 120_000);
});
