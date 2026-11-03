/**
 * #42 live rewards against a real PostgreSQL ledger. These tests use the real game, live host, checkpoints and ledger;
 * they deliberately do not write fake reward rows or seed a starter inventory.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { LiveConnection } from '@engine/live-kernel';
import { actors, applyLedgerDeltas, assetBalances, AuthService, checkLedgerInvariants, createDatabase, getHoldings, itemInstances, ledgerBatches,
  ledgerEntries, liveInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, PostgresInstanceStoreHooks, ServerConfig } from '@engine/server-kit';
import { eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { characters } from '../characters/schema.ts';
import { createRpgDatabase, createRpgServer } from '../index.ts';
import { rpgAreaDiscoveries } from '../expeditions/schema.ts';
import { applyRpgLiveEffects } from './effects.ts';
import { createRpgLiveHost, startRpgLiveInstance } from './index.ts';
import type { RpgLiveHost } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for live rewards PostgreSQL tests');
const LOCATION = 'loc:test_grove.entrance';
const GLADE = 'loc:test_grove.glade';
const SLIME = { id: 'group:reward_slime', enemies: ['enemy:test_grove.slime'] };
const POTION = 'item:minor_healing_potion';
const SWORD = 'item:rusty_sword';
const RUN_BAG = (instanceId: string) => `run_bag:${instanceId}`;
const HERB_NODE = 'res:test_grove.herb_patch#0';
const token = () => randomBytes(32).toString('base64url');

interface Player { accountId: string; sessionToken: string; actorId: string }
interface Node { app: Awaited<ReturnType<typeof createRpgServer>>; live: RpgLiveHost }

describe.skipIf(!adminUrl)('live rewards and ledger integration (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let auth: AuthService;
  const databaseName = `live_rewards_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_800_000_000_000);
  const nodes: Node[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-rewards-'));
    const sourceContent = fileURLToPath(new URL('../../../../content', import.meta.url));
    const testContent = join(directory, 'content');
    await cp(sourceContent, testContent, { recursive: true });
    // Make the authored test Grove gather table deterministic in this private compiled fixture (the production table
    // retains its authored nothing chance). This keeps the persisted gather assertion independent of random seeds.
    const lootPath = join(testContent, 'loot-tables', 'test_grove.json');
    const tables = JSON.parse(await readFile(lootPath, 'utf8')) as { id: string; rolls: number; nothingWeight?: number;
      entries: { item: string; weight: number; qty?: { min: number; max: number } }[];
      guaranteed?: { item: string; qty?: { min: number; max: number } }[] }[];
    const slimeTable = tables.find(table => table.id === 'loot:test_grove.slime');
    if (!slimeTable) throw new Error('authored test Grove slime table is missing');
    slimeTable.guaranteed = [...(slimeTable.guaranteed ?? []), { item: SWORD, qty: { min: 1, max: 1 } }];
    const gatherTable = tables.find(table => table.id === 'loot:test_grove.herb_gather');
    if (!gatherTable) throw new Error('authored test Grove gather table is missing');
    gatherTable.rolls = 1;
    gatherTable.nothingWeight = 0;
    gatherTable.entries = [{ item: 'item:test_grove.herb', weight: 1, qty: { min: 1, max: 1 } }];
    await writeFile(lootPath, JSON.stringify(tables));
    const compiled = compileContentDirectory(testContent, plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle;
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    auth = new AuthService(database, clock);
  }, 30_000);

  afterAll(async () => {
    for (const node of nodes) await node.app.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function node(nodeId: string, hooks: PostgresInstanceStoreHooks = {}): Promise<Node> {
    const live = createRpgLiveHost({ autoStart: false, nodeId, leaseMs: 30_000, graceMs: 60_000, hooks });
    const app = await createRpgServer(config, { clock, live });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const created = { app, live };
    nodes.push(created);
    return created;
  }

  async function player(options: { potion?: number; sword?: boolean } = {}): Promise<Player> {
    const session = await auth.guest(token());
    const hero = await database.db.transaction((tx) => createCharacterService(tx, content as never).create(session.accountId, { name: 'Rewards hero' }));
    const deltas = [] as { actorId: string; asset: { kind: 'stack'; item: string } | { kind: 'unique_mint'; item: string }; qty: number }[];
    if (options.potion) deltas.push({ actorId: hero.actorId, asset: { kind: 'stack', item: POTION }, qty: options.potion });
    if (options.sword) deltas.push({ actorId: hero.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: 1 });
    if (deltas.length) await database.db.transaction((tx) => applyLedgerDeltas(tx,
      { type: 'test_fixture', id: `${hero.actorId}:live-rewards` }, deltas));
    return { accountId: session.accountId, sessionToken: session.sessionToken, actorId: hero.actorId };
  }

  async function holdings(actorId: string) { return database.db.transaction((tx) => getHoldings(tx, actorId)); }
  async function ledgerIssues(actorId: string) { return database.db.transaction((tx) => checkLedgerInvariants(tx, [actorId])); }
  async function balance(actorId: string, assetRef: string, container: string): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.find(row => row.assetRef === assetRef && row.container === container)?.qty ?? 0;
  }
  function connection(messages?: unknown[]): LiveConnection { return { id: randomUUID(), push: message => messages?.push(message) }; }
  async function attach(n: Node, who: Player, instanceId: string) {
    const transport = connection();
    await n.live.host().attach(instanceId, who.actorId, who.accountId, transport);
    return transport;
  }
  async function command(n: Node, who: Player, instanceId: string, command: Record<string, unknown>, commandId = randomUUID()) {
    return n.live.host().submit(instanceId, who.actorId, who.accountId, commandId, command as never);
  }
  async function advance(n: Node, instanceId: string, until: () => boolean, maxMs = 90_000) {
    for (let elapsed = 0; elapsed < maxMs && !until(); elapsed += 500) {
      clock.advance(500);
      await n.live.host().pump();
    }
    expect(until(), `live instance ${instanceId} did not reach the expected checkpoint`).toBe(true);
  }

  it('grants authored victory loot to the instance run bag and credits XP once at victory, never at close', async () => {
    const n = await node('reward-victory');
    const who = await player();
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION, groups: [SLIME] });
    const messages: unknown[] = [];
    const transport = connection(messages);
    await n.live.host().attach(instanceId, who.actorId, who.accountId, transport);
    const commandId = randomUUID();
    expect(await command(n, who, instanceId, { type: 'engage', groupId: SLIME.id }, commandId)).toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    await advance(n, instanceId, () => n.live.host().inspect(instanceId)?.ticking === false);

    const hero = n.live.host().inspect(instanceId)?.state.heroes[0];
    expect(hero?.xp).toBe(10);
    const saved = await database.db.select().from(characters).where(eq(characters.actorId, who.actorId));
    expect(saved[0]?.xp).toBe(10);
    const bagGold = await balance(who.actorId, 'gold', RUN_BAG(instanceId));
    expect(bagGold).toBeGreaterThanOrEqual(1);
    expect(bagGold).toBeLessThanOrEqual(3);
    expect(await balance(who.actorId, 'gold', 'inventory')).toBe(0);
    expect((await holdings(who.actorId)).filter(h => h.container === RUN_BAG(instanceId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: { kind: 'currency', currency: 'gold' }, qty: bagGold }),
      expect.objectContaining({ asset: { kind: 'unique', itemId: expect.any(String) }, container: RUN_BAG(instanceId), definition: SWORD }),
    ]));
    const bagSword = (await holdings(who.actorId)).find(h => h.container === RUN_BAG(instanceId) && h.definition === SWORD);
    expect(bagSword?.itemId).toBeDefined();
    const swordId = bagSword?.itemId as string;
    expect(await ledgerIssues(who.actorId)).toEqual([]);

    expect(await command(n, who, instanceId, { type: 'engage', groupId: SLIME.id }, commandId)).toMatchObject({ duplicate: true });
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0]?.xp).toBe(10);
    const progression = content.collections['progression']?.[0] as { xpToNext: readonly number[] } | undefined;
    if (!progression) throw new Error('compiled XP curve is missing');
    const xpReplay = { type: 'xpGranted', actionId: `victory:${SLIME.id}`, actorId: who.actorId, xp: 10,
      xpToNext: progression.xpToNext };
    const event = messages.map(value => value as { type?: string; event?: { type?: string; rewards?: { actorId: string; xp: number; drops: { item: string; qty: number }[]; gold: number }[] } })
      .find(value => value.type === 'live.event' && value.event?.type === 'combatRewards')?.event;
    const reward = event?.rewards?.find(value => value.actorId === who.actorId);
    expect(reward).toBeDefined();
    const lootReplay = { type: 'lootGranted', actionId: `victory:${SLIME.id}`, actorId: who.actorId,
      items: reward?.drops ?? [], gold: reward?.gold ?? 0 };
    await database.db.transaction(tx => applyRpgLiveEffects(tx, { instanceId, participants: [{ actorId: who.actorId }] },
      [xpReplay as never, lootReplay as never], clock.nowMs(), { type: 'checkpoint' }));
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0]?.xp).toBe(10);
    expect(await balance(who.actorId, 'gold', RUN_BAG(instanceId))).toBe(bagGold);
    expect(await balance(who.actorId, 'gold', 'inventory')).toBe(0);
    expect(await ledgerIssues(who.actorId)).toEqual([]);
    expect(await command(n, who, instanceId, { type: 'returnToSanctuary' })).toMatchObject({ ack: { status: 'applied' } });
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0]?.xp).toBe(10);
    expect(await balance(who.actorId, 'gold', RUN_BAG(instanceId))).toBe(0);
    expect(await balance(who.actorId, 'gold', 'inventory')).toBe(bagGold);
    expect((await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'rpg_live_return')))
      .filter(batch => batch.sourceId === instanceId)).toHaveLength(1);
    expect((await database.db.select().from(itemInstances).where(eq(itemInstances.id, swordId)))[0])
      .toMatchObject({ id: swordId, definition: SWORD, container: 'inventory' });
    expect(await ledgerIssues(who.actorId)).toEqual([]);
  }, 30_000);

  it('rejects a changed XP replay payload for the same live reward action', async () => {
    const n = await node('reward-xp-conflict');
    const who = await player();
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION, groups: [SLIME] });
    await attach(n, who, instanceId);
    await command(n, who, instanceId, { type: 'engage', groupId: SLIME.id });
    await advance(n, instanceId, () => n.live.host().inspect(instanceId)?.ticking === false);
    const progression = content.collections['progression']?.[0] as { xpToNext: readonly number[] } | undefined;
    if (!progression) throw new Error('compiled XP curve is missing');
    await expect(database.db.transaction(tx => applyRpgLiveEffects(tx,
      { instanceId, participants: [{ actorId: who.actorId }] },
      [{ type: 'xpGranted', actionId: `victory:${SLIME.id}`, actorId: who.actorId, xp: 11,
        xpToNext: progression.xpToNext } as never], clock.nowMs(), { type: 'checkpoint' })))
      .rejects.toThrow('live XP reward idempotency conflict');
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0]?.xp).toBe(10);
    await command(n, who, instanceId, { type: 'returnToSanctuary' });
  }, 30_000);

  it('rolls authored gather loot at the gather checkpoint, survives lease handover, and returns the bag once', async () => {
    const a = await node('reward-gather-a');
    const b = await node('reward-gather-b');
    const who = await player();
    const instanceId = await startRpgLiveInstance(a.live, database, { actorIds: [who.actorId], location: LOCATION });
    await attach(a, who, instanceId);
    expect(await command(a, who, instanceId, { type: 'travel', exitId: 'exit:test_grove.entrance.glade' })).toMatchObject({ ack: { status: 'applied' } });
    const gatherId = randomUUID();
    const gather = await command(a, who, instanceId, { type: 'gather', nodeId: HERB_NODE }, gatherId);
    expect(gather.ack.status).toBe('applied');
    const state = a.live.host().inspect(instanceId)?.state;
    expect(state?.runBag[who.actorId]).toBeDefined();
    const before = await holdings(who.actorId);
    const scoped = before.filter(h => h.container === RUN_BAG(instanceId));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every(h => h.asset.kind === 'stack' && h.asset.item === 'item:test_grove.herb')).toBe(true);

    clock.advance(30_001);
    expect(await b.live.host().recover(instanceId)).toBe(true);
    await expect(command(a, who, instanceId, { type: 'returnToSanctuary' }, randomUUID()))
      .rejects.toMatchObject({ code: 'not_hosted' });
    expect(b.live.host().inspect(instanceId)?.state.runBag[who.actorId]).toEqual(state?.runBag[who.actorId]);
    const transport = connection();
    await b.live.host().attach(instanceId, who.actorId, who.accountId, transport);
    expect(await command(b, who, instanceId, { type: 'travel', exitId: 'exit:test_grove.glade.entrance' }))
      .toMatchObject({ ack: { status: 'applied' } });
    await command(b, who, instanceId, { type: 'returnToSanctuary' });
    expect(await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId))).toBe(0);
    const inventoryHerb = await balance(who.actorId, 'item:test_grove.herb', 'inventory');
    expect(inventoryHerb).toBeGreaterThan(0);
    const returned = await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'rpg_live_return'));
    expect(returned.filter(batch => batch.sourceId === instanceId)).toHaveLength(1);
    expect((await database.db.select().from(ledgerEntries).where(eq(ledgerEntries.sourceType, 'rpg_live_return')))
      .filter(entry => entry.sourceId === instanceId)).toHaveLength(scoped.length);
  }, 30_000);

  it('rolls back bank and close together when the fenced return transaction fails', async () => {
    let rejectClose = true;
    const a = await node('reward-return-rollback', { onClose: async () => {
      if (rejectClose) { rejectClose = false; throw new Error('injected close failure'); }
    } });
    const b = await node('reward-return-recovery');
    const who = await player();
    const instanceId = await startRpgLiveInstance(a.live, database, { actorIds: [who.actorId], location: GLADE });
    await attach(a, who, instanceId);
    await command(a, who, instanceId, { type: 'gather', nodeId: HERB_NODE });
    expect(await command(a, who, instanceId, { type: 'travel', exitId: 'exit:test_grove.glade.entrance' }))
      .toMatchObject({ ack: { status: 'applied' } });
    const bagQty = await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId));
    expect(bagQty).toBeGreaterThan(0);
    await expect(command(a, who, instanceId, { type: 'returnToSanctuary' })).rejects.toThrow('injected close failure');
    expect(await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId))).toBe(bagQty);
    expect(await balance(who.actorId, 'item:test_grove.herb', 'inventory')).toBe(0);
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId)))[0]?.status).toBe('active');
    a.live.host().abandonForTesting();
    clock.advance(30_001);
    expect(await b.live.host().recover(instanceId)).toBe(true);
    await attach(b, who, instanceId);
    await command(b, who, instanceId, { type: 'returnToSanctuary' });
    expect(await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId))).toBe(0);
    expect(await balance(who.actorId, 'item:test_grove.herb', 'inventory')).toBe(bagQty);
    expect((await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'rpg_live_return')))
      .filter(batch => batch.sourceId === instanceId)).toHaveLength(1);
  }, 30_000);

  it('snapshots real equipped gear and carried potions, consumes only a carried potion, and preserves the unused one', async () => {
    const n = await node('reward-potions');
    const who = await player({ potion: 2, sword: true });
    const minted = (await holdings(who.actorId)).find(h => h.definition === SWORD);
    expect(minted?.itemId).toBeDefined();
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${who.actorId}:equip` }, [
      { actorId: who.actorId, asset: { kind: 'unique', itemId: minted?.itemId as string }, qty: 1, from: 'inventory', to: 'equipped' },
    ], { equipment: { actorId: who.actorId, itemId: minted?.itemId as string, slot: 'weapon' } }));
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION,
      consumables: { [who.actorId]: [{ item: POTION, qty: 2 }] } });
    const state = n.live.host().inspect(instanceId)?.state;
    expect(state?.heroes[0]?.build.equipment).toEqual(expect.arrayContaining([expect.objectContaining({ stats: { power: 5, critBp: 150 } })]));
    expect(state?.heroes[0]?.consumables).toEqual([{ item: POTION, qty: 2 }]);
    await attach(n, who, instanceId);
    // Lower HP as an explicit persisted test setup, then execute the real healing command and checkpoint.
    const heroState = n.live.host().inspect(instanceId)?.state.heroes[0];
    if (!heroState) throw new Error('live hero snapshot missing');
    heroState.hp = deriveStats(heroState.build, DEFAULT_STAT_FORMULAS).maxHp - 1;
    const [firstUse, racingUse] = await Promise.all([
      command(n, who, instanceId, { type: 'useConsumable', itemId: POTION }, randomUUID()),
      command(n, who, instanceId, { type: 'useConsumable', itemId: POTION }, randomUUID()),
    ]);
    expect([firstUse.ack.status, racingUse.ack.status].sort()).toEqual(['applied', 'rejected']);
    const used = n.live.host().inspect(instanceId)?.state.heroes[0]?.used[POTION] ?? 0;
    expect(used).toBe(1);
    expect(await balance(who.actorId, POTION, 'inventory')).toBe(1); // consumption is durable at the use checkpoint
    const oldHost = n.live.host();
    oldHost.abandonForTesting();
    clock.advance(30_001);
    const replacement = await node('reward-potions-recovered');
    expect(await replacement.live.host().recover(instanceId)).toBe(true);
    expect((await replacement.live.host().inspect(instanceId)?.state.heroes[0]?.used[POTION])).toBe(1);
    const recoveredConnection = connection();
    await replacement.live.host().attach(instanceId, who.actorId, who.accountId, recoveredConnection);
    await command(replacement, who, instanceId, { type: 'returnToSanctuary' });
    const finalHoldings = await holdings(who.actorId);
    expect(finalHoldings.find(h => h.asset.kind === 'stack' && h.asset.item === POTION && h.container === 'inventory')?.qty)
      .toBe(2 - used);
    expect(finalHoldings.some(h => h.container === RUN_BAG(instanceId) && h.asset.kind === 'unique')).toBe(false);
    expect((await database.db.select().from(itemInstances).where(eq(itemInstances.id, minted?.itemId as string)))[0])
      .toMatchObject({ container: 'equipped', slot: 'weapon', sourceType: 'test_fixture' });
  }, 45_000);

  it('rejects unknown equipped runtime rolls and never starts with an invented gear snapshot', async () => {
    const n = await node('reward-unknown-roll');
    const who = await player({ sword: true });
    const sword = (await holdings(who.actorId)).find(h => h.definition === SWORD);
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${who.actorId}:equip-unknown-roll` }, [
      { actorId: who.actorId, asset: { kind: 'unique', itemId: sword?.itemId as string }, qty: 1, from: 'inventory', to: 'equipped' },
    ], { equipment: { actorId: who.actorId, itemId: sword?.itemId as string, slot: 'weapon' } }));
    await database.db.update(itemInstances).set({ rolls: { invented_power: 999 } }).where(eq(itemInstances.id, sword?.itemId as string));
    await expect(startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION })).rejects.toThrow();
    const [actor] = await database.db.select().from(actors).where(eq(actors.actorId, who.actorId));
    expect(actor?.activityState).toBe('none');
  }, 30_000);

  it('retries one stale prepared start snapshot from the new authoritative build without leaking activity locks', async () => {
    const n = await node('reward-stale-start');
    const who = await player();
    const host = n.live.host();
    const create = host.create.bind(host);
    let createAttempts = 0;
    host.create = async input => {
      createAttempts += 1;
      if (createAttempts === 1) {
        await database.db.transaction(async tx => {
          const [current] = await tx.select().from(characters).where(eq(characters.actorId, who.actorId));
          if (!current) throw new Error('stale-start fixture character is missing');
          await tx.update(characters).set({ attributes: { ...current.attributes, SPI: current.attributes.SPI + 1 } })
            .where(eq(characters.actorId, who.actorId));
        });
      }
      return create(input);
    };
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION });
    expect(createAttempts).toBe(2);
    const [character] = await database.db.select().from(characters).where(eq(characters.actorId, who.actorId));
    expect(n.live.host().inspect(instanceId)?.state.heroes[0]?.build.attributes).toEqual(character?.attributes);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0])
      .toMatchObject({ activityState: 'live', activityId: instanceId });
    const instances = await database.pool.query('SELECT instance_id FROM live_instances WHERE participants @> $1::jsonb',
      [JSON.stringify([{ actorId: who.actorId }])]);
    expect(instances.rows).toHaveLength(1);
    await attach(n, who, instanceId);
    await command(n, who, instanceId, { type: 'returnToSanctuary' });
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]?.activityState).toBe('none');
    expect(await database.pool.query('SELECT instance_id FROM live_instances WHERE participants @> $1::jsonb',
      [JSON.stringify([{ actorId: who.actorId }])])).toMatchObject({ rows: [{ instance_id: instanceId }] });
  }, 30_000);

  it('does not bank an unsecured bag on defeat/grace close and the following instance cannot claim the old bag', async () => {
    const n = await node('reward-defeat');
    const who = await player();
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: GLADE });
    await attach(n, who, instanceId);
    await command(n, who, instanceId, { type: 'gather', nodeId: HERB_NODE });
    const bagQty = await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId));
    expect(bagQty).toBeGreaterThanOrEqual(0);
    // The close hook must not interpret any non-return close (including abandonment after grace) as a bank.
    n.live.host().abandonForTesting();
    clock.advance(30_001);
    const recovered = await node('reward-defeat-recover');
    expect(await recovered.live.host().recover(instanceId)).toBe(true);
    await advance(recovered, instanceId, () => !recovered.live.host().has(instanceId), 65_000);
    expect(await balance(who.actorId, 'item:test_grove.herb', 'inventory')).toBe(0);
    expect(await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId))).toBe(bagQty);
    const nextInstance = await startRpgLiveInstance(recovered.live, database, { actorIds: [who.actorId], location: LOCATION });
    await attach(recovered, who, nextInstance);
    await command(recovered, who, nextInstance, { type: 'returnToSanctuary' });
    expect(await balance(who.actorId, 'item:test_grove.herb', 'inventory')).toBe(0);
    expect(await balance(who.actorId, 'item:test_grove.herb', RUN_BAG(instanceId))).toBe(bagQty);
  }, 45_000);

  it('commits the queued initial discovery during grace release with no game command, while rejecting another absent actor effect', async () => {
    const n = await node('reward-grace-release');
    const who = await player();
    const instanceId = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: LOCATION });
    const transport = connection();
    await n.live.host().attach(instanceId, who.actorId, who.accountId, transport);
    await n.live.host().detach(instanceId, who.actorId, transport.id);
    expect(n.live.host().inspect(instanceId)?.state.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'discovery', actorId: who.actorId, areaId: 'area:test_grove', locationId: LOCATION }),
    ]));

    for (let elapsed = 0; elapsed <= 60_000 && n.live.host().has(instanceId); elapsed += 1_000) {
      clock.advance(1_000);
      await n.live.host().pump();
    }
    expect(n.live.host().has(instanceId)).toBe(false);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]?.activityState).toBe('none');
    expect(await database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, who.actorId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ areaId: 'area:test_grove', locationId: LOCATION })]));
    expect(await balance(who.actorId, 'gold', RUN_BAG(instanceId))).toBe(0);
    expect((await holdings(who.actorId)).filter(item => item.container.startsWith('run_bag:'))).toEqual([]);
    expect((await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'rpg_live_return')))
      .filter(batch => batch.sourceId === instanceId)).toHaveLength(0);
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, instanceId)))[0])
      .toMatchObject({ status: 'closed', outcome: 'abandoned' });

    const other = await player();
    await expect(database.db.transaction(tx => applyRpgLiveEffects(tx,
      { instanceId, participants: [{ actorId: who.actorId, left: true }, { actorId: other.actorId, left: true }] },
      [{ type: 'discovery', actorId: other.actorId, areaId: 'area:test_grove', locationId: LOCATION } as never],
      clock.nowMs(), { type: 'release', actorId: who.actorId }))).rejects.toThrow('live effect for a non-participant');
    expect(await database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, other.actorId))).toHaveLength(0);
  }, 30_000);
});
