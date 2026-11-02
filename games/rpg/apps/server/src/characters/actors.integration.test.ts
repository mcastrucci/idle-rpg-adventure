import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import {
  accounts, actors, createDatabase, lockActors, parseServerConfig, requireSanctuaryMutation, transitionActivity,
} from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RPG_MIGRATIONS } from '../migrations.ts';
import { characters } from './schema.ts';
import { createCharacterService } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for actor/character integration tests');
const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const content = compiled.bundle;

describe.skipIf(!adminUrl)('actor and RPG character persistence against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  const databaseName = `actors_test_${randomUUID().replaceAll('-', '')}`;
  const accountId = randomUUID();
  const foreignAccountId = randomUUID();
  async function create(account = accountId, name = 'Bulwark') {
    return database.db.transaction(tx => createCharacterService(tx, content).create(account, { name }));
  }
  beforeAll(async () => {
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: '/unused', LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createDatabase(config, { migrationSets: [RPG_MIGRATIONS] });
    await database.migrate();
    await database.db.insert(accounts).values([
      { id: accountId, createdAt: new Date(0) }, { id: foreignAccountId, createdAt: new Date(0) },
    ]);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  });
  it('creates fixed level-1 starter state and atomically prevents duplicate account/game characters', async () => {
    const created = await create();
    expect(created).toMatchObject({ accountId, gameId: 'rpg', level: 1, xp: 0, unspentPoints: 0, activityState: 'none', activityId: null });
    await expect(create()).rejects.toThrow('character_exists');
    expect((await database.db.select().from(actors).where(eq(actors.accountId, accountId))).length).toBe(1);
    expect((await database.db.select().from(characters).where(eq(characters.accountId, accountId))).length).toBe(1);
  });
  it('lets exactly one concurrent live/expedition entry win, and rejects stale releases', async () => {
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    const attempts = await Promise.all((['live', 'expedition'] as const).map(state => database.db.transaction(
      tx => transitionActivity(tx, actor.actorId, { state: 'none', activityId: null }, { state, activityId: randomUUID() }),
    )));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const winner = attempts.find(value => value !== null);
    if (!winner || winner.activityState === 'none' || !winner.activityId) throw new Error('missing winner');
    const stale = await database.db.transaction(tx => transitionActivity(tx, winner.actorId,
      { state: winner.activityState as 'live' | 'expedition', activityId: randomUUID() }, { state: 'none', activityId: null }));
    expect(stale).toBeNull();
    const released = await database.db.transaction(tx => transitionActivity(tx, winner.actorId,
      { state: winner.activityState as 'live' | 'expedition', activityId: winner.activityId as string }, { state: 'none', activityId: null }));
    expect(released?.version).toBe(2);
  });
  it('rolls back activity transitions with the enclosing future-ledger/instance transaction', async () => {
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    await expect(database.db.transaction(async tx => {
      expect(await transitionActivity(tx, actor.actorId, { state: 'none', activityId: null }, { state: 'live', activityId: randomUUID() })).not.toBeNull();
      throw new Error('later instance/ledger insert failed');
    })).rejects.toThrow('later instance/ledger insert failed');
    expect((await database.db.select().from(actors).where(eq(actors.actorId, actor.actorId)))[0]).toMatchObject({ activityState: 'none', activityId: null, version: actor.version });
  });
  it('serializes configuration edits with activity entry, then rejects edits behind the active lock', async () => {
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    let signalLocked: (() => void) | undefined;
    let release: (() => void) | undefined;
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const editing = database.db.transaction(async tx => {
      await requireSanctuaryMutation(tx, actor.actorId, accountId, 'rpg');
      signalLocked?.();
      await gate;
      return createCharacterService(tx, content).configure(accountId, actor.actorId, { name: 'Before embark' });
    });
    await locked;
    const activityId = randomUUID();
    const entering = database.db.transaction(tx => transitionActivity(tx, actor.actorId,
      { state: 'none', activityId: null }, { state: 'live', activityId }));
    release?.();
    const [edited, entered] = await Promise.all([editing, entering]);
    expect(edited.name).toBe('Before embark');
    expect(entered?.activityState).toBe('live');
    expect(entered?.version).toBe(edited.version + 1);
    await expect(database.db.transaction(tx => createCharacterService(tx, content).configure(accountId, actor.actorId,
      { name: 'After embark' }))).rejects.toMatchObject({ statusCode: 409 });
    await database.db.transaction(tx => transitionActivity(tx, actor.actorId, { state: 'live', activityId }, { state: 'none', activityId: null }));
  });
  it('rolls back configuration and actor version with the caller transaction', async () => {
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    const before = await database.db.transaction(tx => createCharacterService(tx, content).read(accountId, actor.actorId));
    await expect(database.db.transaction(async tx => {
      await createCharacterService(tx, content).configure(accountId, actor.actorId, { name: 'Rolled back' });
      throw new Error('command failed later');
    })).rejects.toThrow('command failed later');
    const after = await database.db.transaction(tx => createCharacterService(tx, content).read(accountId, actor.actorId));
    expect(after).toEqual(before);
  });
  it('enforces activity/null invariants and ownership mirrors in the database itself', async () => {
    const id = randomUUID();
    await expect(database.pool.query('INSERT INTO actors (actor_id,account_id,game_id,activity_state,activity_id) VALUES ($1,$2,$3,$4,$5)',
      [id, accountId, 'other-game', 'none', randomUUID()])).rejects.toThrow();
    await expect(database.pool.query('INSERT INTO actors (actor_id,account_id,game_id,activity_state,activity_id) VALUES ($1,$2,$3,$4,$5)',
      [id, accountId, 'other-game', 'live', null])).rejects.toThrow();
    await expect(database.pool.query('INSERT INTO actors (actor_id,account_id,game_id,activity_state,activity_id) VALUES ($1,$2,$3,$4,$5)',
      [id, accountId, 'other-game', 'invalid', randomUUID()])).rejects.toThrow();
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    await expect(database.db.update(characters).set({ accountId: foreignAccountId }).where(eq(characters.actorId, actor.actorId))).rejects.toThrow();
  });
  it('orders opposing party lock requests consistently without deadlock', async () => {
    const other = await create(foreignAccountId, 'Other');
    const [first] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!first) throw new Error('missing fixture');
    const ids = [first.actorId, other.actorId];
    const results = await Promise.all([ids, [...ids].reverse()].map(order => database.db.transaction(async tx => {
      await tx.execute('SET LOCAL lock_timeout = \'2s\'');
      return (await lockActors(tx, order)).map(actor => actor.actorId);
    })));
    expect(results).toEqual([[...ids].sort(), [...ids].sort()]);
    const caseActorId = `aaaaaaaa${randomUUID().slice(8)}`; // Guaranteed alphabetic hex digits exercise case aliases.
    await database.db.insert(actors).values({ actorId: caseActorId, accountId: foreignAccountId, gameId: 'lock-case-fixture' });
    const duplicateCase = await database.db.transaction(tx => lockActors(tx, [caseActorId,
      caseActorId.toUpperCase(), first.actorId, first.actorId]));
    expect(duplicateCase.map(actor => actor.actorId)).toEqual([caseActorId, first.actorId].sort());
  });
  it('denies foreign ownership and blocks all character edits while either activity is active', async () => {
    const [actor] = await database.db.select().from(actors).where(eq(actors.accountId, accountId));
    if (!actor) throw new Error('missing fixture');
    await expect(database.db.transaction(tx => createCharacterService(tx, content).read(foreignAccountId, actor.actorId))).rejects.toMatchObject({ statusCode: 404 });
    await expect(database.db.transaction(tx => createCharacterService(tx, content).configure(foreignAccountId, actor.actorId, { name: 'Stolen' }))).rejects.toMatchObject({ statusCode: 404 });
    for (const state of ['live', 'expedition'] as const) {
      const activityId = randomUUID();
      await database.db.transaction(tx => transitionActivity(tx, actor.actorId, { state: 'none', activityId: null }, { state, activityId }));
      await expect(database.db.transaction(tx => requireSanctuaryMutation(tx, actor.actorId, accountId, 'rpg'))).rejects.toMatchObject({ statusCode: 409 });
      for (const input of [{ name: 'Busy' }, { skillLoadout: [] }, { automationRules: [] }, { allocate: { STR: 0 } }]) {
        await expect(database.db.transaction(tx => createCharacterService(tx, content).configure(accountId, actor.actorId, input))).rejects.toMatchObject({ statusCode: 409 });
      }
      await database.db.transaction(tx => transitionActivity(tx, actor.actorId, { state, activityId }, { state: 'none', activityId: null }));
    }
    await expect(database.db.transaction(tx => createCharacterService(tx, content).configure(accountId, actor.actorId, { allocate: { STR: 1 } }))).rejects.toThrow('allocation exceeds');
    const edited = await database.db.transaction(tx => createCharacterService(tx, content).configure(accountId, actor.actorId, { name: 'Ready' }));
    expect(edited.name).toBe('Ready');
  });
});
