import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { applyLedgerDeltas, AuthService, createDatabase, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import type { JsonValue } from '@engine/live-kernel';
import { rpgAreaDiscoveries, rpgCompletedAreas, rpgRegionConqueredEvents } from '../expeditions/schema.ts';
import { rpgActorObjectives } from '../expeditions/schema.ts';
import { readRpgEvalContext, recordDiscovery, recordObjective } from '../expeditions/progress.ts';
import { createCharacterService } from '../characters/service.ts';
import { applyConquestProgress } from './service.ts';
import type { RpgCompletionSnapshot } from './types.ts';
import { buildLiveWorld } from '../live/world.ts';
import { applyRpgLiveEffects } from '../live/effects.ts';
import { characters } from '../characters/schema.ts';
import { eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for conquest integration tests');
const REGION = 'area:region_1';

describe.skipIf(!adminUrl)('personal region conquest persistence (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: ReturnType<typeof compileBundle>;
  let auth: AuthService;
  let snapshot: RpgCompletionSnapshot;
  const clock = new ManualClock(1_000_000);
  const databaseName = `conquest_test_${randomUUID().replaceAll('-', '')}`;

  function compileBundle() {
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    return compiled.bundle;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'conquest-integration-'));
    content = compileBundle();
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createDatabase(config, { migrationSets: [{ id: 'rpg', schema: 'rpg_migrations', directory: fileURLToPath(new URL('../../migrations', import.meta.url)) }] });
    await database.migrate();
    auth = new AuthService(database, clock);
    const world = buildLiveWorld(content.world);
    const built = world.areas.get(REGION)?.completion;
    if (!built) throw new Error('Region 1 fixture has no completion rule');
    const rule = built.area.completion;
    if (!rule) throw new Error('Region 1 fixture has no completion rule');
    const area = { ...built.area, locations: [...built.area.locations, 'loc:region_1.later_secret'], completion: {
      ...rule, frozen: { poolSize: 8, requiredCount: 6, at: '2026-11-02' },
    } };
    snapshot = { area, locations: [...built.locations, { id: 'loc:region_1.later_secret', tags: ['secret'], exits: [] }] } as RpgCompletionSnapshot;
  }, 30_000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function actor(name: string): Promise<string> {
    const session = await auth.guest(randomBytes(32).toString('base64url'));
    const character = await database.db.transaction(tx => createCharacterService(tx, content as never).create(session.accountId, { name }));
    return character.actorId;
  }

  const poolLocations = () => snapshot.locations.filter(location => location.tags.includes('ordinary')).map(location => location.id);

  it('conquers at the frozen threshold plus mandatory boss, ignores later secret locations, and emits one replay-safe event', async () => {
    const actorId = await actor('Conquest hero');
    const pool = poolLocations();
    expect(pool).toHaveLength(8);
    expect(snapshot.area.completion?.frozen?.requiredCount).toBe(6);
    await database.db.transaction(async tx => {
      for (const locationId of pool.slice(0, 5)) await recordDiscovery(tx, clock, actorId, REGION, locationId);
      await recordDiscovery(tx, clock, actorId, REGION, 'loc:region_1.later_secret');
      await applyConquestProgress(tx, clock, actorId, REGION, snapshot, ['enemy:hollow_matriarch']);
    });
    const beforeBoss = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(beforeBoss.actor.completedAreas.has(REGION as `area:${string}`)).toBe(false);

    const sixth = pool[5];
    if (!sixth) throw new Error('Region 1 fixture needs at least six pool locations');
    await database.db.transaction(async tx => {
      await recordDiscovery(tx, clock, actorId, REGION, sixth);
      await applyConquestProgress(tx, clock, actorId, REGION, snapshot);
    });
    const afterBoss = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(afterBoss.actor.completedAreas.has(REGION as `area:${string}`)).toBe(true);
    expect(await database.db.select().from(rpgRegionConqueredEvents).where(eq(rpgRegionConqueredEvents.actorId, actorId))).toHaveLength(1);

    await Promise.all([0, 1].map(() => database.db.transaction(tx => applyConquestProgress(tx, clock, actorId, REGION, snapshot,
      ['enemy:hollow_matriarch']))));
    expect(await database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId))).toHaveLength(1);
    expect(await database.db.select().from(rpgRegionConqueredEvents).where(eq(rpgRegionConqueredEvents.actorId, actorId))).toHaveLength(1);

    const rule = snapshot.area.completion;
    if (!rule) throw new Error('Region 1 fixture needs a completion rule');
    const laterStricterSnapshot = { ...snapshot, area: { ...snapshot.area,
      completion: { ...rule, frozen: { poolSize: 8, requiredCount: 8, at: '2026-11-02' } } } } as RpgCompletionSnapshot;
    await database.db.transaction(tx => applyConquestProgress(tx, clock, actorId, REGION, laterStricterSnapshot));
    const afterContentChange = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(afterContentChange.actor.completedAreas.has(REGION as `area:${string}`)).toBe(true);
  });

  it('keeps full exploration locked until the mandatory boss is defeated', async () => {
    const actorId = await actor('No boss hero');
    await database.db.transaction(async tx => {
      for (const locationId of poolLocations()) await recordDiscovery(tx, clock, actorId, REGION, locationId);
      await applyConquestProgress(tx, clock, actorId, REGION, snapshot);
    });
    const beforeBoss = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(beforeBoss.actor.completedAreas.has(REGION as `area:${string}`)).toBe(false);

    await database.db.transaction(tx => applyConquestProgress(tx, clock, actorId, REGION, snapshot, ['enemy:hollow_matriarch']));
    const afterBoss = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(afterBoss.actor.completedAreas.has(REGION as `area:${string}`)).toBe(true);
  });

  it('uses the actor level and inventory when evaluating generic completion requirements', async () => {
    const actorId = await actor('Context hero');
    const rule = snapshot.area.completion;
    if (!rule) throw new Error('Region 1 fixture needs a completion rule');
    const snapshotWithContextRules = { ...snapshot, area: { ...snapshot.area, completion: { ...rule,
      required: { all: [
        { game: 'defeated', enemy: 'enemy:hollow_matriarch' },
        { game: 'levelAtLeast', level: 2 },
        { hasItem: { item: 'item:conquest_token', qty: 1 } },
      ] },
    } } } as RpgCompletionSnapshot;
    await database.db.transaction(async tx => {
      await tx.update(characters).set({ level: 2 }).where(eq(characters.actorId, actorId));
      await applyLedgerDeltas(tx, { type: 'test_fixture', id: actorId }, [
        { actorId, asset: { kind: 'stack', item: 'item:conquest_token' }, qty: 1, to: 'inventory' },
      ]);
      for (const locationId of poolLocations().slice(0, 6)) await recordDiscovery(tx, clock, actorId, REGION, locationId);
      await applyConquestProgress(tx, clock, actorId, REGION, snapshotWithContextRules, ['enemy:hollow_matriarch']);
    });
    const context = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 2,
      []));
    expect(context.actor.completedAreas.has(REGION as `area:${string}`)).toBe(true);
  });

  it('rolls discoveries, boss credit, completion, and the event back together', async () => {
    const actorId = await actor('Rollback hero');
    await expect(database.db.transaction(async tx => {
      for (const locationId of poolLocations().slice(0, 6)) await recordDiscovery(tx, clock, actorId, REGION, locationId);
      await applyConquestProgress(tx, clock, actorId, REGION, snapshot, ['enemy:hollow_matriarch']);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    expect(await database.db.select().from(rpgAreaDiscoveries).where(eq(rpgAreaDiscoveries.actorId, actorId))).toHaveLength(0);
    expect(await database.db.select().from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, actorId))).toHaveLength(0);
    expect(await database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId))).toHaveLength(0);
    expect(await database.db.select().from(rpgRegionConqueredEvents).where(eq(rpgRegionConqueredEvents.actorId, actorId))).toHaveLength(0);
  });

  it('keeps one completion and event when two worker transactions evaluate the final progress together', async () => {
    const actorId = await actor('Concurrent conquest hero');
    await database.db.transaction(async tx => {
      for (const locationId of poolLocations().slice(0, 6)) await recordDiscovery(tx, clock, actorId, REGION, locationId);
      await recordObjective(tx, clock, actorId, 'defeated:enemy:hollow_matriarch');
    });
    await Promise.all([0, 1].map(() => database.db.transaction(tx => applyConquestProgress(tx, clock, actorId, REGION, snapshot))));
    expect(await database.db.select().from(rpgCompletedAreas).where(eq(rpgCompletedAreas.actorId, actorId))).toHaveLength(1);
    expect(await database.db.select().from(rpgRegionConqueredEvents).where(eq(rpgRegionConqueredEvents.actorId, actorId))).toHaveLength(1);
  });

  it('serializes concurrent final discovery and boss effects for the same actor', async () => {
    const actorId = await actor('Concurrent requirements hero');
    const present = { participants: [{ actorId, left: false }] };
    const discovery = JSON.parse(JSON.stringify({ type: 'discovery', actorId, areaId: REGION,
      locationId: poolLocations()[5], completion: snapshot })) as JsonValue;
    const boss = JSON.parse(JSON.stringify({ type: 'bossDefeated', actorId, areaId: REGION,
      enemyIds: ['enemy:hollow_matriarch'], completion: snapshot })) as JsonValue;
    await database.db.transaction(async tx => {
      for (const locationId of poolLocations().slice(0, 5)) await recordDiscovery(tx, clock, actorId, REGION, locationId);
    });

    let waiting = 0;
    let release!: () => void;
    const bothTransactionsOpen = new Promise<void>(resolve => { release = resolve; });
    const runEffect = (effect: JsonValue) => database.db.transaction(async tx => {
      waiting += 1;
      if (waiting === 2) release();
      await bothTransactionsOpen;
      await applyRpgLiveEffects(tx, present, [effect], clock.nowMs());
    });
    await Promise.all([runEffect(discovery), runEffect(boss)]);
    const context = await database.db.transaction(tx => readRpgEvalContext(tx, actorId, 1));
    expect(context.actor.completedAreas.has(REGION as `area:${string}`)).toBe(true);
    expect(await database.db.select().from(rpgRegionConqueredEvents).where(eq(rpgRegionConqueredEvents.actorId, actorId))).toHaveLength(1);
  });

  it('rejects effect credit for non-present or left participants', async () => {
    const actorId = await actor('Absent hero');
    const effect = JSON.parse(JSON.stringify({ type: 'bossDefeated', actorId, areaId: REGION,
      enemyIds: ['enemy:hollow_matriarch'], completion: snapshot })) as JsonValue;
    await expect(database.db.transaction(tx => applyRpgLiveEffects(tx, { participants: [] }, [effect], clock.nowMs())))
      .rejects.toThrow('live effect for a non-participant');
    await expect(database.db.transaction(tx => applyRpgLiveEffects(tx, { participants: [{ actorId, left: true }] }, [effect], clock.nowMs())))
      .rejects.toThrow('live effect for a non-participant');
    expect(await database.db.select().from(rpgActorObjectives).where(eq(rpgActorObjectives.actorId, actorId))).toHaveLength(0);
  });
});
