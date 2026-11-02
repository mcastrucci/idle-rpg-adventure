import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { actors, applyLedgerDeltas, assetBalances, createDatabase, ledgerBatches, ledgerEntries, ManualClock, parseServerConfig, scheduledJobs } from '@engine/server-kit';
import type { Database, LoadedContent, ServerConfig } from '@engine/server-kit';
import { parseExpeditionEstimateDto, parseExpeditionEstimateRequest } from '@rpg/protocol';
import type { ExpeditionEstimateDto } from '@rpg/protocol';
import plugin from '@rpg/content-plugin';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { characters } from '../characters/schema.ts';
import { EstimateCache } from './estimate-cache.ts';
import { createInlineEstimateRunner } from './estimate-runner.ts';
import type { EstimateRunner } from './estimate-runner.ts';
import type { EstimateAggregate } from './estimate-samples.ts';
import { createEstimateService } from './estimates.ts';
import { recordAreaCompletion } from './progress.ts';
import { expeditions } from './schema.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL estimate tests');
const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';
const START_AT = 1_800_000_000_000;

interface Session { accountId: string; sessionToken: string }

describe.skipIf(!adminUrl)('expedition estimates against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let directory: string;
  let content: LoadedContent;
  let runs = 0;
  const databaseName = `estimates_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(START_AT);
  const counting = (bundle: LoadedContent): EstimateRunner => {
    const inner = createInlineEstimateRunner(bundle);
    return { run: async job => { runs++; return inner.run(job); }, close: () => inner.close() };
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'estimates-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle as unknown as LoadedContent;
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(compiled.bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    const config: ServerConfig = { ...base, databaseUrl: url.toString(), roles: ['api'] };
    database = createRpgDatabase(config);
    await database.migrate();
    // The default runner (worker-thread pool) serves the HTTP route, like production.
    app = await createRpgServer(config, { clock });
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
  async function fixture(options: { potionQty?: number; completed?: boolean } = {}) {
    const guest = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: randomBytes(32).toString('base64url') } });
    expect(guest.statusCode).toBe(200);
    const session = guest.json<Session>();
    const created = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Estimate hero' } } });
    expect(created.statusCode).toBe(201);
    const actorId = created.json<{ actorId: string }>().actorId;
    if (options.completed ?? true) await database.db.transaction(tx => recordAreaCompletion(tx, clock, actorId, REGION));
    if (options.potionQty) await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${actorId}:potion` },
      [{ actorId, asset: { kind: 'stack', item: POTION }, qty: options.potionQty as number }]));
    return { session, actorId };
  }
  const body = (options: { durationMin?: number; potions?: number; belowHpBp?: number; areaId?: string; paceBp?: number } = {}) => ({
    request: { areaId: options.areaId ?? REGION, activityId: HUNT, durationMin: options.durationMin ?? 15, paceBp: options.paceBp ?? 10_000 },
    config: { consumables: options.potions ? [{ item: POTION, qty: options.potions }] : [], retreat: { belowHpBp: options.belowHpBp ?? 0, onlyWhenNoHealing: false } },
  });
  const estimate = (session: Session, actorId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/characters/${actorId}/expedition-estimate`, headers: headers(session), payload: payload as Record<string, unknown> });

  async function sideEffectState(actorId: string) {
    const [actor] = await database.db.select().from(actors).where(eq(actors.actorId, actorId));
    const [character] = await database.db.select().from(characters).where(eq(characters.actorId, actorId));
    return {
      actor,
      character,
      balances: await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, actorId)),
      ledgerEntries: (await database.db.select().from(ledgerEntries)).length,
      ledgerBatches: (await database.db.select().from(ledgerBatches)).length,
      expeditions: (await database.db.select().from(expeditions)).length,
      jobs: (await database.db.select().from(scheduledJobs)).length,
    };
  }

  it('returns a labelled estimate from the server-derived build, served from cache on repeat, with no side effects', async () => {
    const { session, actorId } = await fixture({ potionQty: 3 });
    const before = await sideEffectState(actorId);
    const first = await estimate(session, actorId, body({ potions: 2, belowHpBp: 2000 }));
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const dto = parseExpeditionEstimateDto(first.json());
    expect(dto).toMatchObject({ estimate: true, actorId, areaId: REGION, activityId: HUNT, durationMin: 15, paceBp: 10_000, n: 200, cached: false });
    expect(dto.consumablesUsed.map(row => row.item)).toEqual([POTION]);
    expect(dto.consumablesUsed[0]?.p90).toBeLessThanOrEqual(2);
    const rates = dto.outcomeRatesBp;
    expect(rates.completed + rates.retreated + rates.died).toBeGreaterThan(9_990);
    expect(dto.xp.p10).toBeLessThanOrEqual(dto.xp.p50);
    expect(JSON.stringify(dto)).not.toMatch(/"(?:seed|rootSeed|budget|timeline)"\s*:/);

    const second = await estimate(session, actorId, body({ potions: 2, belowHpBp: 2000 }));
    expect(second.statusCode).toBe(200);
    const again = parseExpeditionEstimateDto(second.json());
    expect(again).toEqual({ ...dto, cached: true } satisfies ExpeditionEstimateDto);
    expect(await sideEffectState(actorId)).toEqual(before);
  }, 30_000);

  it('enforces ownership, request shape, start gates and inventory like a start', async () => {
    const { session, actorId } = await fixture({ potionQty: 1 });
    const other = await fixture();
    expect((await estimate(other.session, actorId, body())).statusCode).toBe(404);
    expect((await estimate(session, randomUUID(), body())).statusCode).toBe(404);
    const unauthenticated = await app.inject({ method: 'POST', url: `/characters/${actorId}/expedition-estimate`, payload: body() });
    expect(unauthenticated.statusCode).toBe(401);
    // Clients cannot smuggle stats or an actor into the body.
    expect((await estimate(session, actorId, { ...body(), snapshot: { build: { level: 99 } } })).json()).toEqual({ error: 'invalid_request' });
    expect((await estimate(session, actorId, { ...body(), actorId })).statusCode).toBe(400);
    expect((await estimate(session, actorId, body({ paceBp: 12_000 }))).json()).toEqual({ error: 'invalid_pace' });
    expect((await estimate(session, actorId, body({ durationMin: 45 }))).json()).toEqual({ error: 'rpg.invalidDuration' });
    expect((await estimate(session, actorId, body({ potions: 2 }))).json()).toEqual({ error: 'insufficient_consumables' });
    const locked = await fixture({ completed: false });
    expect((await estimate(locked.session, locked.actorId, body())).json()).toEqual({ error: 'start.areaNotCompleted' });
  }, 30_000);

  it('keys the cache by build/rules, config and content hash', async () => {
    const { session, actorId } = await fixture({ potionQty: 2 });
    const cache = new EstimateCache<EstimateAggregate>({ maxEntries: 16, maxPending: 4 });
    const service = createEstimateService(content, { createRunner: counting, cache });
    const changedContent = createEstimateService({ ...content, contentHash: `${content.contentHash}-next` }, { createRunner: counting, cache });
    const request = parseExpeditionEstimateRequest(body());
    try {
      runs = 0;
      expect((await service.estimate(database, session.accountId, actorId, request)).cached).toBe(false);
      expect((await service.estimate(database, session.accountId, actorId, request)).cached).toBe(true);
      expect(runs).toBe(1);
      // New content (hash) must not reuse the old result.
      expect((await changedContent.estimate(database, session.accountId, actorId, request)).cached).toBe(false);
      // A config change is a new key.
      expect((await service.estimate(database, session.accountId, actorId, parseExpeditionEstimateRequest(body({ potions: 1 })))).cached).toBe(false);
      // A server-side rules change (character configuration) invalidates the build/rules part of the key.
      const configure = await app.inject({ method: 'PATCH', url: `/characters/${actorId}/configuration`, headers: headers(session), payload: {
        command_id: randomUUID(), operation: 'character.configure', payload: { automationRules: [] } } });
      expect(configure.statusCode).toBe(200);
      expect((await service.estimate(database, session.accountId, actorId, request)).cached).toBe(false);
      expect(runs).toBe(4);
    } finally { await service.close(); await changedContent.close(); }
  }, 30_000);
});
