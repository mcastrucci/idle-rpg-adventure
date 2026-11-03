/** #43 live death and corpse flows against a real PostgreSQL ledger. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { LiveConnection } from '@engine/live-kernel';
import { actors, applyLedgerDeltas, assetBalances, AuthService, checkLedgerInvariants, createDatabase, getHoldings,
  itemInstances, liveInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, PostgresInstanceStoreHooks, ServerConfig } from '@engine/server-kit';
import { parseLiveServerFrame } from '@rpg/protocol';
import plugin from '@rpg/content-plugin';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { characters } from '../characters/schema.ts';
import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createRpgLiveHost, startRpgLiveInstance } from './index.ts';
import type { RpgLiveHost } from './index.ts';
import { liveDeaths } from './death-schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for live death PostgreSQL tests');
const ENTRANCE = 'loc:test_grove.entrance';
const GLADE = 'loc:test_grove.glade';
const SLIME = { id: 'group:death_slime', enemies: ['enemy:test_grove.slime'] };
const WARDENS = { id: 'group:death_wardens', enemies: ['enemy:test_grove.warden', 'enemy:test_grove.warden', 'enemy:test_grove.warden'] };
const RETREATERS = { id: 'group:death_retreaters', enemies: ['enemy:test_grove.retreat_warden', 'enemy:test_grove.retreat_warden', 'enemy:test_grove.retreat_warden'] };
const HERB = 'item:test_grove.herb';
const POTION = 'item:minor_healing_potion';
const SWORD = 'item:rusty_sword';
const RUN_BAG = (id: string) => `run_bag:${id}`;
const CORPSE = (id: string) => `corpse:${id}`;
const token = () => randomBytes(32).toString('base64url');

interface Player { accountId: string; sessionToken: string; actorId: string }
interface Node { app: Awaited<ReturnType<typeof createRpgServer>>; live: RpgLiveHost }

describe.skipIf(!adminUrl)('live death and corpse recovery (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let auth: AuthService;
  const databaseName = `live_death_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);
  const nodes: Node[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'live-death-'));
    const testContent = join(directory, 'content');
    await cp(fileURLToPath(new URL('../../../../content', import.meta.url)), testContent, { recursive: true });
    // Only this temporary test bundle changes: slime loot always gives a stack, gold, and a unique UUID.
    const lootPath = join(testContent, 'loot-tables', 'test_grove.json');
    const tables = JSON.parse(await readFile(lootPath, 'utf8')) as { id: string; rolls: number; nothingWeight?: number;
      entries: { item: string; weight: number; qty?: { min: number; max: number } }[];
      guaranteed?: { item: string; qty?: { min: number; max: number } }[]; gold?: { min: number; max: number } }[];
    const slimeLoot = tables.find(row => row.id === 'loot:test_grove.slime');
    if (!slimeLoot) throw new Error('authored test Grove slime loot is missing');
    slimeLoot.rolls = 1;
    slimeLoot.nothingWeight = 0;
    slimeLoot.entries = [{ item: HERB, weight: 1, qty: { min: 2, max: 2 } }];
    slimeLoot.guaranteed = [...(slimeLoot.guaranteed ?? []), { item: SWORD, qty: { min: 1, max: 1 } }];
    slimeLoot.gold = { min: 7, max: 7 };
    await writeFile(lootPath, JSON.stringify(tables));
    // 255 makes the 10% loss demonstrate floor(25.5) = 25 rather than a rounded penalty.
    const curvePath = join(testContent, 'progression', 'xp-curve.json');
    const curve = JSON.parse(await readFile(curvePath, 'utf8')) as { xpToNext: number[] };
    curve.xpToNext[1] = 255;
    await writeFile(curvePath, JSON.stringify(curve));
    // Make a predictable partial-party case possible: a low-HP hero can die while a fixture-strength ally clears one turn.
    const wardenPath = join(testContent, 'enemies', 'test_grove_warden.json');
    const warden = JSON.parse(await readFile(wardenPath, 'utf8')) as Record<string, unknown> &
      { stats: { maxHp: number; power: number }; phases?: unknown };
    const wardenWithoutPhases = Object.fromEntries(Object.entries(warden).filter(([key]) => key !== 'phases'));
    const retreater = { ...wardenWithoutPhases, id: 'enemy:test_grove.retreat_warden', rank: 'normal',
      stats: { ...warden.stats, maxHp: 100, power: 1_000 } };
    await writeFile(join(testContent, 'enemies', 'test_grove_retreat_warden.json'), JSON.stringify(retreater));
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

  async function player(name = 'Death hero', stocked = true): Promise<Player> {
    const session = await auth.guest(token());
    const hero = await database.db.transaction(tx => createCharacterService(tx, content as never).create(session.accountId, { name }));
    if (stocked) {
      await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${hero.actorId}:death-stock` }, [
        { actorId: hero.actorId, asset: { kind: 'stack', item: POTION }, qty: 5 },
        { actorId: hero.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: 1 },
      ]));
      const minted = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, hero.actorId)))
        .find(row => row.definition === SWORD);
      if (!minted) throw new Error('fixture sword mint is missing');
      await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${hero.actorId}:death-equipment` }, [
        { actorId: hero.actorId, asset: { kind: 'stack', item: POTION }, qty: 3, from: 'inventory', to: 'storage' },
        { actorId: hero.actorId, asset: { kind: 'unique', itemId: minted.id }, qty: 1, from: 'inventory', to: 'equipped' },
      ], { equipment: { actorId: hero.actorId, itemId: minted.id, slot: 'weapon' } }));
    }
    return { accountId: session.accountId, sessionToken: session.sessionToken, actorId: hero.actorId };
  }

  async function holdings(actorId: string) { return database.db.transaction(tx => getHoldings(tx, actorId)); }
  async function issues(actorId: string) { return database.db.transaction(tx => checkLedgerInvariants(tx, [actorId])); }
  async function balance(actorId: string, assetRef: string, container: string): Promise<number> {
    const rows = await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId));
    return rows.find(row => row.assetRef === assetRef && row.container === container)?.qty ?? 0;
  }
  function connection(messages?: unknown[]): LiveConnection { return { id: randomUUID(), push: frame => messages?.push(parseLiveServerFrame(frame)) }; }
  async function attach(n: Node, who: Player, instanceId: string) {
    const transport = connection();
    await n.live.host().attach(instanceId, who.actorId, who.accountId, transport);
    return transport;
  }
  async function command(n: Node, who: Player, instanceId: string, value: Record<string, unknown>, commandId = randomUUID()) {
    return n.live.host().submit(instanceId, who.actorId, who.accountId, commandId, value as never);
  }
  async function advance(n: Node, instanceId: string, until: () => boolean, maxMs = 90_000) {
    for (let elapsed = 0; elapsed < maxMs && !until(); elapsed += 500) {
      clock.advance(500);
      await n.live.host().pump();
    }
    expect(until(), `live instance ${instanceId} did not reach the expected checkpoint`).toBe(true);
  }
  async function die(n: Node, who: Player, withLoot: boolean, carryPotions = false): Promise<string> {
    const groups = withLoot ? [SLIME, WARDENS] : [WARDENS];
    const id = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: ENTRANCE, groups,
      ...(carryPotions ? { consumables: { [who.actorId]: [{ item: POTION, qty: 2 }] } } : {}) });
    await attach(n, who, id);
    if (withLoot) {
      expect((await command(n, who, id, { type: 'engage', groupId: SLIME.id })).ack.status).toBe('applied');
      await advance(n, id, () => n.live.host().inspect(id)?.ticking === false);
    }
    expect((await command(n, who, id, { type: 'engage', groupId: WARDENS.id })).ack.status).toBe('applied');
    await advance(n, id, () => !n.live.host().has(id));
    const [closed] = await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, id));
    expect(closed).toMatchObject({ status: 'closed', outcome: 'defeated' });
    return id;
  }

  async function deathRow(actorId: string) {
    const [row] = await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, actorId))
      .orderBy(desc(liveDeaths.occurredAt), desc(liveDeaths.deathId));
    if (!row) throw new Error('actual live death did not create an owner corpse');
    return row;
  }

  it('commits a real death penalty and exact corpse assets while preserving equipped gear, storage, and unused supplies', async () => {
    const who = await player();
    const effectActivityStates: { context: string; status: string }[] = [];
    const closeActivityStates: string[] = [];
    const n = await node('death-durable', {
      onEffects: async (tx, _instance, effects, _nowMs, context) => {
        if (!effects.some(effect => (effect as { type?: string }).type === 'heroDied')) return;
        const [actor] = await tx.select().from(actors).where(eq(actors.actorId, who.actorId));
        effectActivityStates.push({ context: context.type, status: actor?.activityState ?? 'missing' });
      },
      onClose: async tx => {
        const [actor] = await tx.select().from(actors).where(eq(actors.actorId, who.actorId));
        closeActivityStates.push(actor?.activityState ?? 'missing');
      },
    });
    await database.db.update(characters).set({ level: 2, xp: 4, automationRules: [
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ] }).where(eq(characters.actorId, who.actorId));
    const [before] = await database.db.select().from(characters).where(eq(characters.actorId, who.actorId));
    if (!before) throw new Error('fixture character is missing');
    const originalEquipment = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, who.actorId)))
      .filter(row => row.container === 'equipped');
    const originalHoldings = await holdings(who.actorId);
    const messages: unknown[] = [];
    const host = n.live.host();
    const originalAttach = host.attach.bind(host);
    host.attach = async (instanceId, actorId, accountId, transport) => originalAttach(instanceId, actorId, accountId,
      { ...transport, push: frame => { messages.push(parseLiveServerFrame(frame)); transport.push(frame); } });

    const instanceId = await die(n, who, true, true);
    const death = await deathRow(who.actorId);
    expect(death).toMatchObject({ instanceId, areaId: 'area:test_grove', locationId: ENTRANCE, status: 'active', xpBeforeLevel: 2,
      xpBeforeIntoLevel: 14, xpLost: 25, xpAfterLevel: 1, xpAfterIntoLevel: 89 });
    const [after] = await database.db.select().from(characters).where(eq(characters.actorId, who.actorId));
    expect(after).toMatchObject({ level: 1, xp: 89, attributes: before.attributes, unspentPoints: before.unspentPoints,
      skillLoadout: before.skillLoadout, automationRules: before.automationRules });
    expect(effectActivityStates).toEqual([{ context: 'close', status: 'none' }]);
    expect(closeActivityStates).toEqual(['none']);
    expect(await balance(who.actorId, HERB, CORPSE(death.deathId))).toBe(2);
    expect(await balance(who.actorId, 'gold', CORPSE(death.deathId))).toBe(7);
    const corpseUnique = (await holdings(who.actorId)).find(row => row.container === CORPSE(death.deathId) && row.asset.kind === 'unique');
    expect(corpseUnique?.itemId).toBeDefined();
    expect(corpseUnique?.definition).toBe(SWORD);
    expect((death.bagSnapshot as { uniques: { itemId: string; definition: string }[] }).uniques)
      .toEqual([expect.objectContaining({ itemId: corpseUnique?.itemId, definition: SWORD })]);
    expect((await database.db.select().from(itemInstances).where(eq(itemInstances.id, corpseUnique?.itemId as string)))[0])
      .toMatchObject({ id: corpseUnique?.itemId, definition: SWORD, container: CORPSE(death.deathId) });
    expect(await balance(who.actorId, HERB, RUN_BAG(instanceId))).toBe(0);
    expect(await balance(who.actorId, 'gold', RUN_BAG(instanceId))).toBe(0);
    const finalEquipment = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, who.actorId)))
      .filter(row => row.container === 'equipped');
    expect(finalEquipment).toEqual(originalEquipment);
    const finalHoldings = await holdings(who.actorId);
    expect(finalHoldings.find(row => row.asset.kind === 'stack' && row.asset.item === POTION && row.container === 'inventory')?.qty).toBe(2);
    expect(finalHoldings.find(row => row.asset.kind === 'stack' && row.asset.item === POTION && row.container === 'storage')?.qty).toBe(3);
    expect(finalHoldings.filter(row => row.container === 'equipped')).toEqual(originalHoldings.filter(row => row.container === 'equipped'));
    expect(messages.some(frame => (frame as { type?: string; event?: { type?: string } }).type === 'live.event' &&
      (frame as { event?: { type?: string } }).event?.type === 'combatRewards')).toBe(true);

    const owned = await n.app.inject({ method: 'GET', url: `/characters/${who.actorId}/live-death`,
      headers: { authorization: `Bearer ${who.sessionToken}` } });
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toMatchObject({ death: { deathId: death.deathId, xpLost: 25, corpse: { status: 'active' } } });
    expect((await n.app.inject({ method: 'GET', url: `/characters/${who.actorId}/live-death` })).statusCode).toBe(401);
    const stranger = await player('No history', false);
    expect((await n.app.inject({ method: 'GET', url: `/characters/${who.actorId}/live-death`,
      headers: { authorization: `Bearer ${stranger.sessionToken}` } })).statusCode).toBe(404);
    const empty = await n.app.inject({ method: 'GET', url: `/characters/${stranger.actorId}/live-death`,
      headers: { authorization: `Bearer ${stranger.sessionToken}` } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ death: null });
    expect(await issues(who.actorId)).toEqual([]);
  }, 45_000);

  it('still applies the durable death penalty when the player disconnects during a losing fight', async () => {
    const n = await node('death-disconnected-fight');
    const who = await player('Disconnected fighter', false);
    await database.db.update(characters).set({ xp: 20 }).where(eq(characters.actorId, who.actorId));
    const id = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: ENTRANCE, groups: [WARDENS] });
    const transport = await attach(n, who, id);
    expect((await command(n, who, id, { type: 'engage', groupId: WARDENS.id })).ack.status).toBe('applied');
    await n.live.host().detach(id, who.actorId, transport.id);
    await advance(n, id, () => !n.live.host().has(id));
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, id)))[0])
      .toMatchObject({ status: 'closed', outcome: 'defeated' });
    expect(await deathRow(who.actorId)).toMatchObject({ instanceId: id, status: 'active', xpBeforeLevel: 1,
      xpBeforeIntoLevel: 20, xpBeforeTotal: 20, xpLost: 10, xpAfterLevel: 1, xpAfterIntoLevel: 10, xpAfterTotal: 10 });
    expect((await database.db.select().from(actors).where(eq(actors.actorId, who.actorId)))[0]?.activityState).toBe('none');
    expect(await issues(who.actorId)).toEqual([]);
  }, 45_000);

  it('settles one hero death at combat end while a surviving party member wins the fight', async () => {
    const fallen = await player('Fallen fighter', false);
    const survivor = await player('Surviving fighter', false);
    const checkpointActivityStates: string[] = [];
    const n = await node('death-partial-party', {
      onEffects: async (tx, _instance, effects, _nowMs, context) => {
        if (context.type !== 'checkpoint' || !effects.some(effect => (effect as { type?: string }).type === 'heroDied')) return;
        const [actor] = await tx.select().from(actors).where(eq(actors.actorId, fallen.actorId));
        checkpointActivityStates.push(actor?.activityState ?? 'missing');
      },
    });
    await database.db.update(characters).set({ level: 2, xp: 4, automationRules: [] }).where(eq(characters.actorId, fallen.actorId));
    await database.db.update(characters).set({ attributes: { STR: 10_000, AGI: 4, INT: 2, VIT: 1_000, SPI: 5 } })
      .where(eq(characters.actorId, survivor.actorId));
    const id = await startRpgLiveInstance(n.live, database, { actorIds: [fallen.actorId, survivor.actorId], location: ENTRANCE,
      groups: [RETREATERS] });
    const frames: unknown[] = [];
    await n.live.host().attach(id, fallen.actorId, fallen.accountId, connection(frames));
    await attach(n, survivor, id);
    const runtime = n.live.host().inspect(id)?.state.heroes.find(hero => hero.actorId === fallen.actorId);
    if (!runtime) throw new Error('fallen party hero snapshot is missing');
    runtime.hp = 1; // Explicit adversarial battle fixture; the enemy pack must kill this hero before the strong ally clears it.
    expect((await command(n, fallen, id, { type: 'engage', groupId: RETREATERS.id })).ack.status).toBe('applied');
    expect((await command(n, survivor, id, { type: 'setAuto', auto: false })).ack.status).toBe('applied');
    let deathObservedBeforeFightEnd = false;
    for (let elapsed = 0; elapsed < 90_000 && !deathObservedBeforeFightEnd; elapsed += 500) {
      clock.advance(500);
      await n.live.host().pump();
      const combat = n.live.host().inspect(id)?.state.combat;
      deathObservedBeforeFightEnd = Boolean(combat && combat.outcome === null &&
        combat.actors.some(actor => actor.id === fallen.actorId && actor.hp === 0));
    }
    expect(deathObservedBeforeFightEnd).toBe(true);
    expect((await command(n, survivor, id, { type: 'setAuto', auto: true })).ack.status).toBe('applied');
    await advance(n, id, () => n.live.host().inspect(id)?.ticking === false, 90_000);
    const death = await deathRow(fallen.actorId);
    expect(death).toMatchObject({ status: 'active', locationId: ENTRANCE, xpBeforeLevel: 2, xpBeforeIntoLevel: 4,
      xpLost: 25, xpAfterLevel: 1, xpAfterIntoLevel: 79 });
    expect(checkpointActivityStates).toEqual(['live']);
    expect(await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, survivor.actorId))).toHaveLength(0);
    expect(n.live.host().inspect(id)?.state.visited[ENTRANCE]?.groups[0]?.defeated).toBe(true);
    expect((await database.db.select().from(liveInstances).where(eq(liveInstances.instanceId, id)))[0]?.status).toBe('active');
    expect(frames.some(value => (value as { type?: string; event?: { type?: string; event?: { type?: string } } }).type === 'live.event' &&
      (value as { event?: { type?: string; event?: { type?: string } } }).event?.type === 'combat' &&
      (value as { event?: { event?: { type?: string } } }).event?.event?.type === 'ActorDied')).toBe(true);
    await command(n, survivor, id, { type: 'returnToSanctuary' });
    expect(await issues(fallen.actorId)).toEqual([]);
    expect(await issues(survivor.actorId)).toEqual([]);
  }, 45_000);

  it('settles a fallen hero at a survivor retreat checkpoint before the enemy fight reaches a final outcome', async () => {
    const n = await node('death-retreat-checkpoint');
    const fallen = await player('Retreating fallen fighter', false);
    const survivor = await player('Retreating survivor', false);
    await database.db.update(characters).set({ level: 2, xp: 4, automationRules: [] }).where(eq(characters.actorId, fallen.actorId));
    await database.db.update(characters).set({ attributes: { STR: 10_000, AGI: 4, INT: 2, VIT: 1_000, SPI: 5 } })
      .where(eq(characters.actorId, survivor.actorId));
    const id = await startRpgLiveInstance(n.live, database, { actorIds: [fallen.actorId, survivor.actorId], location: ENTRANCE,
      groups: [RETREATERS] });
    await attach(n, fallen, id);
    await attach(n, survivor, id);
    const runtime = n.live.host().inspect(id)?.state.heroes.find(hero => hero.actorId === fallen.actorId);
    if (!runtime) throw new Error('fallen party hero snapshot is missing');
    runtime.hp = 1;
    expect((await command(n, fallen, id, { type: 'engage', groupId: RETREATERS.id })).ack.status).toBe('applied');
    expect((await command(n, survivor, id, { type: 'setAuto', auto: false })).ack.status).toBe('applied');
    let deathObservedBeforeFightEnd = false;
    for (let elapsed = 0; elapsed < 90_000 && !deathObservedBeforeFightEnd; elapsed += 500) {
      clock.advance(500);
      await n.live.host().pump();
      const combat = n.live.host().inspect(id)?.state.combat;
      deathObservedBeforeFightEnd = Boolean(combat && combat.outcome === null &&
        combat.actors.some(actor => actor.id === fallen.actorId && actor.hp === 0));
    }
    expect(deathObservedBeforeFightEnd).toBe(true);
    expect(await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, fallen.actorId))).toHaveLength(0);

    const retreatId = randomUUID();
    expect(await command(n, survivor, id, { type: 'retreat' }, retreatId)).toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    const death = await deathRow(fallen.actorId);
    expect(death).toMatchObject({ instanceId: id, status: 'active', xpBeforeLevel: 2, xpBeforeIntoLevel: 4,
      xpLost: 25, xpAfterLevel: 1, xpAfterIntoLevel: 79 });
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, fallen.actorId))).filter(row => row.status === 'active'))
      .toHaveLength(1);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, fallen.actorId)))[0])
      .toMatchObject({ activityState: 'live', activityId: id });
    expect(await command(n, survivor, id, { type: 'retreat' }, retreatId)).toMatchObject({ duplicate: true });
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, fallen.actorId))).filter(row => row.status === 'active'))
      .toHaveLength(1);
    await command(n, survivor, id, { type: 'returnToSanctuary' });
    expect(await issues(fallen.actorId)).toEqual([]);
    expect(await issues(survivor.actorId)).toEqual([]);
  }, 45_000);

  it('recovers only at the owner corpse hotspot, exactly once across handover and replay, then banks only on explicit return', async () => {
    const original = await node('death-recovery-original');
    const who = await player();
    await die(original, who, true);
    const corpse = await deathRow(who.actorId);
    const before = await holdings(who.actorId);
    const corpseContainer = CORPSE(corpse.deathId);
    const originalQty = await balance(who.actorId, HERB, corpseContainer);

    const wrongLocation = await startRpgLiveInstance(original.live, database, { actorIds: [who.actorId], location: GLADE });
    await attach(original, who, wrongLocation);
    const wrong = await command(original, who, wrongLocation, { type: 'interact', hotspotId: CORPSE(corpse.deathId) });
    expect(wrong).toMatchObject({ ack: { status: 'rejected', reason: 'unknown_hotspot' } });
    expect(await holdings(who.actorId)).toEqual(before);
    await command(original, who, wrongLocation, { type: 'travel', exitId: 'exit:test_grove.glade.entrance' });
    await command(original, who, wrongLocation, { type: 'returnToSanctuary' });

    const partner = await player('Corpse witness', false);
    const a = await node('death-recovery-a');
    const staleHost = await startRpgLiveInstance(a.live, database, { actorIds: [who.actorId, partner.actorId], location: ENTRANCE });
    await attach(a, who, staleHost);
    await attach(a, partner, staleHost);
    await expect(startRpgLiveInstance(a.live, database, { actorIds: [who.actorId], location: ENTRANCE })).rejects.toThrow();
    const beforeStrangerAttempt = a.live.host().inspect(staleHost)?.seq;
    const strangerAttempt = await command(a, partner, staleHost, { type: 'interact', hotspotId: CORPSE(corpse.deathId) });
    expect(strangerAttempt).toMatchObject({ ack: { status: 'rejected', reason: 'unknown_hotspot' } });
    expect(a.live.host().inspect(staleHost)?.seq).toBe(beforeStrangerAttempt);
    expect(await holdings(who.actorId)).toEqual(before);

    a.live.host().abandonForTesting();
    clock.advance(30_001);
    const b = await node('death-recovery-b');
    expect(await b.live.host().recover(staleHost)).toBe(true);
    await attach(b, who, staleHost);
    const recoveryId = randomUUID();
    expect(await command(b, who, staleHost, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, recoveryId))
      .toMatchObject({ ack: { status: 'applied' }, duplicate: false });
    expect(await balance(who.actorId, HERB, CORPSE(corpse.deathId))).toBe(0);
    expect(await balance(who.actorId, HERB, RUN_BAG(staleHost))).toBe(originalQty);
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.deathId, corpse.deathId)))[0]?.status).toBe('recovered');
    expect(await command(b, who, staleHost, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, recoveryId))
      .toMatchObject({ duplicate: true });

    b.live.host().abandonForTesting();
    clock.advance(30_001);
    const c = await node('death-recovery-c');
    expect(await c.live.host().recover(staleHost)).toBe(true);
    await attach(c, who, staleHost);
    expect(await command(c, who, staleHost, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, recoveryId))
      .toMatchObject({ duplicate: true });
    expect(await balance(who.actorId, HERB, RUN_BAG(staleHost))).toBe(originalQty);
    expect(await command(c, who, staleHost, { type: 'returnToSanctuary' })).toMatchObject({ ack: { status: 'applied' } });
    expect(await balance(who.actorId, HERB, RUN_BAG(staleHost))).toBe(0);
    expect(await balance(who.actorId, HERB, 'inventory')).toBe(originalQty);
    expect(await issues(who.actorId)).toEqual([]);
  }, 60_000);

  it('rejects an expired corpse from a stale start snapshot without publishing a recovery event or changing the run bag', async () => {
    const n = await node('death-expiry');
    const who = await player();
    await die(n, who, true);
    const corpse = await deathRow(who.actorId);
    clock.advance(corpse.expiresAt.getTime() - clock.nowMs() - 1_000);
    const future = await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: ENTRANCE });
    await attach(n, who, future);
    const before = n.live.host().inspect(future);
    if (!before) throw new Error('future instance is missing');
    const bagBefore = await balance(who.actorId, HERB, RUN_BAG(future));
    const seqBefore = before.seq;
    clock.advance(1_000);
    const expiredCommandId = randomUUID();
    const reply = await command(n, who, future, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, expiredCommandId);
    expect(reply).toMatchObject({ ack: { status: 'rejected', reason: 'corpse_unavailable' }, duplicate: false });
    expect(await command(n, who, future, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, expiredCommandId))
      .toMatchObject({ ack: { status: 'rejected', reason: 'corpse_unavailable' }, duplicate: true });
    const after = n.live.host().inspect(future);
    expect(after?.seq).toBe(seqBefore);
    expect(after?.state.runBag[who.actorId]).toEqual(before.state.runBag[who.actorId]);
    expect(await balance(who.actorId, HERB, RUN_BAG(future))).toBe(bagBefore);
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.deathId, corpse.deathId)))[0]?.status).toBe('active');
    n.live.host().abandonForTesting();
    clock.advance(30_001);
    const recovered = await node('death-expiry-recovered');
    expect(await recovered.live.host().recover(future)).toBe(true);
    await attach(recovered, who, future);
    const recoveredSeq = recovered.live.host().inspect(future)?.seq;
    expect(await command(recovered, who, future, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, expiredCommandId))
      .toMatchObject({ ack: { status: 'rejected', reason: 'corpse_unavailable' }, duplicate: false });
    expect(await command(recovered, who, future, { type: 'interact', hotspotId: CORPSE(corpse.deathId) }, expiredCommandId))
      .toMatchObject({ ack: { status: 'rejected', reason: 'corpse_unavailable' }, duplicate: true });
    expect(recovered.live.host().inspect(future)?.seq).toBe(recoveredSeq);
    expect(recovered.live.host().inspect(future)?.state.runBag[who.actorId]).toEqual(before.state.runBag[who.actorId]);
    await command(recovered, who, future, { type: 'returnToSanctuary' });
    await startRpgLiveInstance(n.live, database, { actorIds: [who.actorId], location: ENTRANCE });
    expect((await database.db.select().from(liveDeaths).where(eq(liveDeaths.deathId, corpse.deathId)))[0]?.status).toBe('expired');
    expect(await balance(who.actorId, HERB, CORPSE(corpse.deathId))).toBe(0);
    expect(await issues(who.actorId)).toEqual([]);
  }, 45_000);

  it('invalidates a prior corpse on every later death, including when the second corpse has no contents', async () => {
    const n = await node('death-second');
    const who = await player();
    await die(n, who, true);
    const first = await deathRow(who.actorId);
    expect(await balance(who.actorId, HERB, CORPSE(first.deathId))).toBe(2);
    await die(n, who, false);
    const rows = await database.db.select().from(liveDeaths).where(eq(liveDeaths.actorId, who.actorId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.deathId === first.deathId)?.status).toBe('invalidated');
    const current = rows.find(row => row.deathId !== first.deathId);
    expect(current).toMatchObject({ status: 'active', bagSnapshot: { stacks: [], gold: 0, uniques: [] } });
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1);
    expect(await balance(who.actorId, HERB, CORPSE(first.deathId))).toBe(0);
    expect(await issues(who.actorId)).toEqual([]);
  }, 60_000);

  it('floors an odd XP requirement and clamps a level-one death penalty at zero', async () => {
    const n = await node('death-xp-floor');
    const who = await player('Level one', false);
    await die(n, who, false);
    const death = await deathRow(who.actorId);
    expect(death).toMatchObject({ xpBeforeLevel: 1, xpBeforeIntoLevel: 0, xpBeforeTotal: 0,
      xpLost: 0, xpAfterLevel: 1, xpAfterIntoLevel: 0, xpAfterTotal: 0 });
    expect((await database.db.select().from(characters).where(eq(characters.actorId, who.actorId)))[0])
      .toMatchObject({ level: 1, xp: 0 });
    expect(await issues(who.actorId)).toEqual([]);
  }, 45_000);
});
