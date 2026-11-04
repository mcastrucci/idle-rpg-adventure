import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { compileContentDirectory } from '@engine/content-compiler';
import { createDatabase, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { applyLedgerDeltas, assetBalances, checkLedgerInvariants, getHoldings, ledgerBatches, ledgerEntries } from '@engine/server-kit';
import { actors, scheduledJobs } from '@engine/server-kit';
import { createActorWorldState } from '@engine/world';
import { checkStart, defaultSettle, placeSegments, settleAt, timelineHash } from '@engine/expedition-kernel';
import type { PlacedTimeline, Timeline } from '@engine/expedition-kernel';
import { applyBagLoss, createRpgActivityRegistry, DEFAULT_RPG_IDLE_TUNING, mergeDeltas, rpgIdleContentFromBundle, rpgProgress } from '@rpg/rpg-sim';
import { createRpgPredicateRegistry, XpCurveSchema } from '@rpg/rpg-schema';
import { applyDeathXpLoss, totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';
import { inflateSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { characters } from '../characters/schema.ts';
import { recordAreaCompletion } from './progress.ts';
import { expeditions } from './schema.ts';
import { createExpeditionService, snapshotRpgActor } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL expedition acceptance tests');
const token = () => randomBytes(32).toString('base64url');
const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';
const START_AT = 1_800_000_000_000;
const DEFAULT_CONFIG = { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } };

class BoundaryClock extends ManualClock {
  #armedRead: number | undefined;
  #reads = 0;
  #advanceMs = 0;
  advanceAfterRead(read: number, durationMs: number): void { this.#armedRead = read; this.#reads = 0; this.#advanceMs = durationMs; }
  override nowMs(): number {
    const result = super.nowMs();
    if (this.#armedRead !== undefined && ++this.#reads === this.#armedRead) {
      this.#armedRead = undefined;
      super.advance(this.#advanceMs);
    }
    return result;
  }
}

interface Session { accountId: string; sessionToken: string }
interface CharacterDto {
  actorId: string;
  accountId: string;
  level: number;
  xp: number;
  attributes: Record<string, number>;
  skillLoadout: string[];
  automationRules: unknown[];
}
interface ExpeditionDto {
  id: string;
  actorId: string;
  state: 'running' | 'completed' | 'cancelled';
  startsAtMs: number;
  plannedEndsAtMs: number;
  segments: readonly { index: number; revealAtMs: number; events: readonly Record<string, unknown>[] }[];
  revealedDeltas: unknown;
  endsAtMs?: number;
  outcome?: unknown;
  cancelPreview?: { consumablesUsed: readonly { item: string; qty: number }[]; consumablesReturned: readonly { item: string; qty: number }[] };
  report?: {
    availability: string; effectiveDurationMs: number | null; outcome: string | null; enemiesDefeated: number | null;
    xp: { earned: number | null; penaltyLost: number | null; net: number | null; beforeTotal: number | null; afterTotal: number | null };
    gold: { earned: number | null; lost: number | null; secured: number | null };
    loot: readonly { item: string; earned: number; lost: number; secured: number }[] | null;
    consumables: readonly { item: string; used: number | null; returned: number | null }[] | null;
    events: readonly string[] | null; finalState: { hp: number | null; maxHp: number | null; xpTotal: number | null };
    death: { causes: readonly { key: string }[]; suggestions: readonly string[] } | null;
  };
  [key: string]: unknown;
}

describe.skipIf(!adminUrl)('authenticated idle expeditions against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let config: ServerConfig;
  let directory: string;
  let bundle: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let nextSeed = 1;
  const databaseName = `expeditions_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new BoundaryClock(START_AT);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'expeditions-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    bundle = compiled.bundle;
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString(), roles: ['api'] };
    database = createRpgDatabase(config);
    await database.migrate();
    app = await createRpgServer(config, { clock, seedSource: () => nextSeed });
  }, 30_000);

  beforeEach(() => { clock.set(START_AT); nextSeed = 1; });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function guest(): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  async function createHero(session: Session): Promise<CharacterDto> {
    const response = await app.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Expedition hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<CharacterDto>();
  }
  async function fixture(options: { potionQty?: number; completed?: boolean } = {}) {
    const session = await guest();
    const character = await createHero(session);
    if (options.completed ?? true) await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
    if (options.potionQty) await database.db.transaction(tx => applyLedgerDeltas(tx,
      { type: 'test_fixture', id: `${character.actorId}:potion` }, [{ actorId: character.actorId,
        asset: { kind: 'stack', item: POTION }, qty: options.potionQty as number }]));
    return { session, character };
  }
  function startPayload(actorId: string, options: { durationMin?: number; consumableQty?: number; config?: unknown } = {}) {
    return { actorId, request: { areaId: REGION, activityId: HUNT, durationMin: options.durationMin ?? 60, paceBp: 10_000 },
      config: options.config ?? { ...DEFAULT_CONFIG, consumables: options.consumableQty ? [{ item: POTION, qty: options.consumableQty }] : [] } };
  }
  async function start(session: Session, actorId: string, options: { durationMin?: number; consumableQty?: number; commandId?: string; config?: unknown } = {}) {
    const commandId = options.commandId ?? randomUUID();
    const response = await app.inject({ method: 'POST', url: '/expeditions', headers: headers(session), payload: {
      command_id: commandId, operation: 'expedition.start', payload: startPayload(actorId, options),
    } });
    return { response, commandId };
  }
  async function options(session: Session, actorId: string) {
    return app.inject({ url: `/characters/${actorId}/expedition-options`, headers: headers(session) });
  }
  async function get(session: Session, id: string) {
    return app.inject({ url: `/expeditions/${id}`, headers: headers(session) });
  }
  async function list(session: Session, actorId: string) {
    return app.inject({ url: `/characters/${actorId}/expeditions`, headers: headers(session) });
  }
  async function cancel(session: Session, id: string, commandId = randomUUID()) {
    return app.inject({ method: 'POST', url: `/expeditions/${id}/cancel`, headers: headers(session), payload: {
      command_id: commandId, operation: 'expedition.cancel', payload: { expeditionId: id },
    } });
  }
  async function persisted(id: string) {
    const [row] = await database.db.select().from(expeditions).where(eq(expeditions.id, id));
    if (!row) throw new Error('expedition missing from PostgreSQL');
    return row;
  }
  async function assertNoFutureDisclosure(session: Session, actorId: string, dto: ExpeditionDto) {
    expect(dto.state).toBe('running');
    expect(dto.endsAtMs).toBeUndefined();
    expect(dto.outcome).toBeUndefined();
    for (const segment of dto.segments) expect(segment.revealAtMs).toBeLessThanOrEqual(clock.nowMs());
    const dtoJson = JSON.stringify(dto);
    expect(dtoJson).not.toContain('stateAfter');
    expect(dtoJson).not.toContain('timelineCompressed');
    expect(dtoJson).not.toContain('timelineHash');
    expect(dtoJson).not.toMatch(/"(?:seed|budget|stateAfter|endsAtMs)"\s*:/);
    expect(dto.summary).toMatchObject({ outcome: null });
    expect(dto.segments.flatMap(segment => segment.events).map(event => event['type']))
      .not.toEqual(expect.arrayContaining(['death', 'retreat']));
    for (const response of [await get(session, dto.id), await list(session, actorId)]) {
      expect(response.statusCode).toBe(200);
      const body = response.json<ExpeditionDto | ExpeditionDto[]>();
      const entries = Array.isArray(body) ? body : [body];
      for (const entry of entries) if (entry.id === dto.id) {
        expect(entry.state).toBe('running');
        expect(entry.endsAtMs).toBeUndefined();
        expect(entry.outcome).toBeUndefined();
        expect(entry.summary).toMatchObject({ outcome: null });
        expect(entry.segments.every(segment => segment.revealAtMs <= clock.nowMs())).toBe(true);
        expect(JSON.stringify(entry)).not.toMatch(/"(?:seed|budget|stateAfter|endsAtMs)"\s*:/);
      }
    }
  }
  async function waitForState(id: string, state: ExpeditionDto['state'], timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await persisted(id);
      if (row.status === state) return row;
      await delay(25);
    }
    throw new Error(`expedition ${id} did not reach ${state}`);
  }
  async function waitForQueueCompletion(singletonKey: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const query = await database.pool.query<{ count: string }>(
        "SELECT count(*) FROM pgboss.job WHERE name='rpg.expedition.settle' AND singleton_key=$1 AND state='completed'", [singletonKey]);
      if (Number(query.rows[0]?.count ?? '0') === 1) return;
      await delay(25);
    }
    throw new Error(`PostgreSQL queue did not complete ${singletonKey}`);
  }

  it('requires persisted conquest, keeps start replay exact, and publishes only the running prefix', async () => {
    const { session, character } = await fixture({ completed: false });
    const unavailable = await options(session, character.actorId);
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json().areas).toContainEqual(expect.objectContaining({ areaId: REGION,
      activities: expect.arrayContaining([
        expect.objectContaining({ activityId: HUNT, available: false }),
        expect.objectContaining({ activityId: 'idle:region_1.gather', available: false }),
      ]) }));
    const fake = await start(session, character.actorId, { config: { ...DEFAULT_CONFIG, completedAreas: [REGION] } });
    expect(fake.response.statusCode).toBe(400);
    const denied = await start(session, character.actorId);
    expect(denied.response.statusCode).toBe(400);
    await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
    expect((await options(session, character.actorId)).json().areas).toContainEqual(expect.objectContaining({ areaId: REGION,
      activities: expect.arrayContaining([
        expect.objectContaining({ activityId: HUNT, available: true }),
        expect.objectContaining({ activityId: 'idle:region_1.gather', available: true }),
      ]) }));

    nextSeed = 17;
    const commandId = randomUUID();
    const first = await start(session, character.actorId, { commandId });
    expect(first.response.statusCode).toBe(201);
    const dto = first.response.json<ExpeditionDto>();
    expect(dto).toMatchObject({ actorId: character.actorId, state: 'running', startsAtMs: START_AT, plannedEndsAtMs: START_AT + 60 * 60_000 });
    await assertNoFutureDisclosure(session, character.actorId, dto);
    expect(dto.summary).toMatchObject({ outcome: null });
    for (const forbidden of ['seed', 'budget', 'timelineCompressed', 'timelineHash', 'endsAtMs', 'outcome']) {
      expect(dto).not.toHaveProperty(forbidden);
    }
    const replay = await start(session, character.actorId, { commandId });
    expect(replay.response.statusCode).toBe(201);
    expect(replay.response.json()).toEqual(dto);
    const row = await persisted(dto.id);
    expect(row).toMatchObject({ status: 'running', seed: '17', revision: 0, startsAtMs: START_AT });
    const storedTimeline = JSON.parse(inflateSync(Buffer.from(row.timelineCompressed, 'base64')).toString('utf8'));
    const sim = createRpgActivityRegistry(rpgIdleContentFromBundle(bundle as never)).get(row.activityId);
    if (!sim) throw new Error('missing stored expedition simulator');
    const replayedTimeline = sim.simulate({ config: row.config as never, actors: row.snapshot.participants as never,
      seed: Number(row.seed), budget: row.budget, areaId: row.areaId as `area:${string}`, activityId: row.activityId });
    expect(replayedTimeline).toEqual(storedTimeline);
    expect(String(timelineHash(replayedTimeline as never))).toBe(row.timelineHash);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, character.actorId)))[0])
      .toMatchObject({ activityState: 'expedition', activityId: dto.id });
    expect(await database.db.select().from(scheduledJobs).where(and(eq(scheduledJobs.name, 'rpg.expedition.settle'), eq(scheduledJobs.singletonKey, `${dto.id}:0`))))
      .toHaveLength(1);
    const conflictingReplay = await start(session, character.actorId, { commandId, durationMin: 30 });
    expect(conflictingReplay.response.statusCode).toBe(409);
    expect(await database.db.select().from(expeditions).where(eq(expeditions.actorId, character.actorId))).toHaveLength(1);
    const foreign = await fixture();
    expect((await get(foreign.session, dto.id)).statusCode).toBe(404);
    expect((await list(foreign.session, foreign.character.actorId)).json()).toEqual([]);
    expect((await cancel(foreign.session, dto.id)).statusCode).toBe(404);
    const holdings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(holdings.some(h => h.asset.kind === 'stack' && h.asset.item === POTION && h.container === `escrow:${dto.id}`)).toBe(false);
  });

  it('rolls back the activity lock, escrow, expedition, and command when durable scheduling fails', async () => {
    const { session, character } = await fixture({ potionQty: 1 });
    const commandId = randomUUID();
    const startBatchesBefore = await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'expedition_start'));
    const scheduledBefore = await database.db.select().from(scheduledJobs).where(eq(scheduledJobs.name, 'rpg.expedition.settle'));
    const privateFailure = 'private future outcome seed 991 timeline secret';
    await database.pool.query(`CREATE FUNCTION reject_expedition_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'rpg.expedition.settle' THEN RAISE EXCEPTION '${privateFailure}'; END IF; RETURN NEW; END $$`);
    await database.pool.query(`CREATE CONSTRAINT TRIGGER reject_expedition_schedule AFTER INSERT ON scheduled_jobs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_expedition_schedule()`);
    try {
      const failed = await start(session, character.actorId, { commandId, consumableQty: 1 });
      expect(failed.response.statusCode).toBe(500);
      expect(failed.response.json()).toEqual({ error: 'internal_error' });
      expect(failed.response.body).not.toContain(privateFailure);
      expect(await database.db.select().from(expeditions).where(eq(expeditions.actorId, character.actorId))).toHaveLength(0);
      expect((await database.db.select().from(actors).where(eq(actors.actorId, character.actorId)))[0])
        .toMatchObject({ activityState: 'none', activityId: null });
      expect(await database.db.select().from(ledgerBatches).where(eq(ledgerBatches.sourceType, 'expedition_start')))
        .toHaveLength(startBatchesBefore.length);
      expect(await database.db.select().from(scheduledJobs).where(eq(scheduledJobs.name, 'rpg.expedition.settle')))
        .toHaveLength(scheduledBefore.length);
      expect(await database.db.select().from(assetBalances).where(and(eq(assetBalances.actorId, character.actorId), eq(assetBalances.assetRef, POTION), eq(assetBalances.container, 'inventory'))))
        .toMatchObject([expect.objectContaining({ qty: 1 })]);
    } finally {
      await database.pool.query('DROP TRIGGER reject_expedition_schedule ON scheduled_jobs');
      await database.pool.query('DROP FUNCTION reject_expedition_schedule()');
    }
    const retry = await start(session, character.actorId, { commandId, consumableQty: 1 });
    expect(retry.response.statusCode).toBe(201);
    expect(await database.db.select().from(expeditions).where(eq(expeditions.actorId, character.actorId))).toHaveLength(1);
    expect(await database.db.select().from(scheduledJobs).where(eq(scheduledJobs.name, 'rpg.expedition.settle')))
      .toHaveLength(scheduledBefore.length + 1);
  });

  it('serializes competing starts for the last healing potion and never escrows it twice', async () => {
    const { session, character } = await fixture({ potionQty: 1 });
    const attempts = await Promise.all([
      start(session, character.actorId, { consumableQty: 1 }),
      start(session, character.actorId, { consumableQty: 1 }),
    ]);
    expect(attempts.map(attempt => attempt.response.statusCode).sort()).toEqual([201, 409]);
    const winner = attempts.find(attempt => attempt.response.statusCode === 201);
    if (!winner) throw new Error('no start won the last potion race');
    const dto = winner.response.json<ExpeditionDto>();
    const potionHoldings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(potionHoldings.filter(h => h.asset.kind === 'stack' && h.asset.item === POTION && h.container.startsWith('escrow:')))
      .toEqual([expect.objectContaining({ qty: 1, container: `escrow:${dto.id}` })]);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId], [dto.id]))).toEqual([]);
  });

  it('freezes cancelled public prefixes and returns escrow based only on revealed events', async () => {
    const { session, character } = await fixture({ potionQty: 1 });
    const cancelConfig = { ...DEFAULT_CONFIG, consumables: [{ item: POTION, qty: 1 }] };
    nextSeed = findEarlyRevealingSeed(bundle, character, cancelConfig);
    const started = await start(session, character.actorId, { durationMin: 60, consumableQty: 1 });
    expect(started.response.statusCode).toBe(201);
    const running = started.response.json<ExpeditionDto>();
    await assertNoFutureDisclosure(session, character.actorId, running);
    const actualEnd = (await persisted(running.id)).endsAtMs;
    expect(actualEnd).toBeGreaterThan(START_AT);
    expect(actualEnd).toBeLessThan(running.plannedEndsAtMs);

    // Freeze one millisecond before the next reveal, then cross that reveal during cancel settlement. The advancing
    // clock proves the persisted cutoff/timestamp are captured once even though ledger work awaits PostgreSQL.
    const runningRow = await persisted(running.id);
    const timeline = JSON.parse(inflateSync(Buffer.from(runningRow.timelineCompressed, 'base64')).toString('utf8'));
    const placed = placeSegments(timeline, runningRow.startsAtMs,
      runningRow.plannedEndsAtMs - runningRow.startsAtMs, runningRow.budget);
    const nextReveal = [...new Set(placed.segments.filter(segment => segment.revealAtMs > START_AT).map(segment => segment.revealAtMs))][1];
    if (nextReveal === undefined || nextReveal >= actualEnd) throw new Error('fixture has no visible prefix before early end');
    clock.set(nextReveal - 1);
    const beforeCancel = (await get(session, running.id)).json<ExpeditionDto>();
    expect(beforeCancel.segments.length).toBeGreaterThan(running.segments.length);
    const beforePreview = beforeCancel.cancelPreview;
    expect(beforePreview).toBeDefined();
    if (!beforePreview) throw new Error('running DTO omitted cancellation escrow preview');
    const usedPreview = beforePreview.consumablesUsed.filter(row => row.item === POTION).reduce((n, row) => n + row.qty, 0);
    const returnedPreview = beforePreview.consumablesReturned.filter(row => row.item === POTION).reduce((n, row) => n + row.qty, 0);
    expect(usedPreview + returnedPreview).toBe(1);
    clock.advanceAfterRead(3, 1); // auth, command reservation, then the service's single settlement timestamp read
    const cancelledResponse = await cancel(session, running.id);
    expect(cancelledResponse.statusCode).toBe(200);
    const cancelled = cancelledResponse.json<ExpeditionDto>();
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.endsAtMs).toBe(nextReveal - 1);
    expect(clock.nowMs()).toBe(nextReveal);
    expect(cancelled.segments.map(segment => segment.index)).toEqual(beforeCancel.segments.map(segment => segment.index));
    expect(cancelled.report).toMatchObject({ availability: 'available', outcome: 'cancelled',
      effectiveDurationMs: nextReveal - 1 - START_AT, xp: { earned: expect.any(Number), penaltyLost: 0 },
      events: expect.any(Array), loot: expect.any(Array), consumables: expect.any(Array) });
    expect(cancelled.report?.events?.join(' ')).not.toContain('death');
    expect(JSON.stringify(cancelled)).not.toMatch(/"(?:seed|budget|stateAfter|timelineCompressed|timelineHash)"\s*:/);
    expect(JSON.stringify(cancelled.report)).not.toContain('combatHash');
    clock.advance(2 * 60 * 60_000); // Past the planned end, still inside the 12-hour guest-session lifetime.
    const later = (await get(session, running.id)).json<ExpeditionDto>();
    expect(later).toEqual(cancelled);
    const listed = (await list(session, character.actorId)).json<ExpeditionDto[]>();
    expect(listed).toContainEqual(cancelled);
    const sourceId = `${running.id}:0`;
    expect(await database.db.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, 'expedition_settlement'), eq(ledgerBatches.sourceId, sourceId))))
      .toHaveLength(1);
    const potionEntries = await database.db.select().from(ledgerEntries).where(and(eq(ledgerEntries.sourceType, 'expedition_settlement'),
      eq(ledgerEntries.sourceId, sourceId), eq(ledgerEntries.assetRef, POTION)));
    expect(potionEntries.reduce((n, row) => n + (row.fromContainer?.startsWith('escrow:') && row.toContainer === null ? row.qty : 0), 0)).toBe(usedPreview);
    expect(potionEntries.reduce((n, row) => n + (row.toContainer === 'inventory' ? row.qty : 0), 0)).toBe(returnedPreview);
    const finalPotion = (await database.db.transaction(tx => getHoldings(tx, character.actorId)))
      .filter(h => h.asset.kind === 'stack' && h.asset.item === POTION && h.container === 'inventory')
      .reduce((n, h) => n + h.qty, 0);
    expect(finalPotion).toBe(returnedPreview);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId], []))).toEqual([]);
    // Simulate a pre-report terminal row. New result facts stay unavailable while the recorded safe timeline prefix remains visible.
    await database.db.update(expeditions).set({ terminalReport: null }).where(eq(expeditions.id, running.id));
    const legacy = (await get(session, running.id)).json<ExpeditionDto>();
    expect(legacy).toMatchObject({ terminalReport: null, report: { availability: 'legacy_unavailable', loot: null, consumables: null, events: null,
      effectiveDurationMs: null, enemiesDefeated: null, xp: { earned: null, penaltyLost: null, net: null }, gold: { earned: null, lost: null, secured: null } } });
    expect(legacy.segments).toEqual(cancelled.segments);
  });

  it('settles at the exact early end through lazy read and the real PostgreSQL worker only once, including death penalty and bag loss', async () => {
    const { session, character } = await fixture();
    const fatalSeed = findFatalSeed(bundle, character);
    nextSeed = fatalSeed;
    const started = await start(session, character.actorId, { durationMin: 60 });
    expect(started.response.statusCode).toBe(201);
    const dto = started.response.json<ExpeditionDto>();
    const before = await persisted(dto.id);
    expect(before.status).toBe('running');
    expect(before.outcome).toBeNull();
    expect(before.endsAtMs).toBeLessThan(before.plannedEndsAtMs);
    const [dueJob] = await database.db.select().from(scheduledJobs).where(and(eq(scheduledJobs.name, 'rpg.expedition.settle'), eq(scheduledJobs.singletonKey, `${dto.id}:0`)));
    expect(dueJob?.dueAtMs).toBe(before.endsAtMs);
    const beforeCharacter = (await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0];
    if (!beforeCharacter) throw new Error('missing test character');

    clock.set(before.endsAtMs - 1);
    const lastEarlyView = (await get(session, dto.id)).json<ExpeditionDto>();
    await assertNoFutureDisclosure(session, character.actorId, lastEarlyView);
    expect(lastEarlyView.summary).toMatchObject({ outcome: null });
    clock.set(before.endsAtMs);
    // Start the real built-in PostgresJobs worker after the exact deadline; its startup dispatch and lazy GET race
    // through the same persisted handler/settlement transaction, rather than mocking the queue or database.
    const worker = await createRpgServer({ ...config, roles: ['worker'] }, { clock });
    try {
      const [lazy, cancelAtEnd, directStale] = await Promise.all([
        get(session, dto.id),
        cancel(session, dto.id),
        database.db.transaction(tx => createExpeditionService(tx, clock, bundle as never).settleJob(dto.id, 99)),
      ]);
      expect(lazy.statusCode).toBe(200);
      const completed = lazy.json<ExpeditionDto>();
      expect(completed.state).toBe('completed');
      expect(completed.endsAtMs).toBe(before.endsAtMs);
      expect(completed.outcome).toEqual('failed');
      expect(completed.report).toMatchObject({ availability: 'available', outcome: 'failed',
        effectiveDurationMs: before.endsAtMs - before.startsAtMs, enemiesDefeated: expect.any(Number),
        xp: { earned: expect.any(Number), penaltyLost: expect.any(Number), net: expect.any(Number),
          beforeTotal: expect.any(Number), afterTotal: expect.any(Number) },
        gold: { earned: expect.any(Number), lost: expect.any(Number), secured: expect.any(Number) },
        finalState: { hp: 0 }, death: { causes: expect.any(Array), suggestions: expect.any(Array) } });
      expect(cancelAtEnd.statusCode).toBe(200);
      expect(cancelAtEnd.json<ExpeditionDto>()).toEqual(completed);
      expect(directStale).toBeUndefined();
      const terminalAgain = await get(session, dto.id);
      expect(terminalAgain.json()).toEqual(completed);
      const finalRow = await waitForState(dto.id, 'completed');
      await waitForQueueCompletion(`${dto.id}:0`);
      const queueSchedule = (await database.db.select().from(scheduledJobs).where(and(eq(scheduledJobs.name, 'rpg.expedition.settle'),
        eq(scheduledJobs.singletonKey, `${dto.id}:0`))))[0];
      expect(queueSchedule).toBeDefined();
      expect(queueSchedule?.promotedAt).toBeInstanceOf(Date);
      expect(finalRow.settledAt?.getTime()).toBe(before.endsAtMs);
      expect(finalRow.outcome).toBe('failed');
      const afterCharacter = (await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0];
      if (!afterCharacter) throw new Error('settled character missing');
      const timeline = JSON.parse(inflateSync(Buffer.from(finalRow.timelineCompressed, 'base64')).toString('utf8'));
      const progress = rpgProgress(timeline, finalRow.settledCutoff as number, 'completed');
      expect(progress).toMatchObject({ died: true, applyDeathPenalty: true });
      const xpCurve = XpCurveSchema.parse({ xpToNext: finalRow.snapshot.xpCurve, tailGrowthBp: finalRow.snapshot.xpTailGrowthBp });
      const gained = progress.actors.find(row => row.actorId === character.actorId)?.xpEarned ?? 0;
      const earnedTotalXp = totalXpFromLevelProgress(beforeCharacter.level, beforeCharacter.xp, xpCurve) + gained;
      const totalXp = applyDeathXpLoss(earnedTotalXp, xpCurve).totalXp;
      expect(totalXp).toBeLessThan(earnedTotalXp);
      expect(completed.report?.xp).toEqual({ earned: gained, penaltyLost: earnedTotalXp - totalXp, net: gained - (earnedTotalXp - totalXp),
        beforeTotal: totalXpFromLevelProgress(beforeCharacter.level, beforeCharacter.xp, xpCurve), afterTotal: totalXp });
      expect(completed.report?.finalState.xpTotal).toBe(totalXp);
      expect(completed.report?.death?.suggestions.join(' ').toLowerCase()).not.toContain('missed heal');
      const expectedProgress = xpProgress(totalXp, xpCurve);
      expect(afterCharacter).toMatchObject({ level: expectedProgress.level, xp: expectedProgress.xpIntoLevel });
      const registry = createRpgActivityRegistry(rpgIdleContentFromBundle(bundle as never));
      const simulator = registry.get(finalRow.activityId);
      if (!simulator) throw new Error('missing persisted simulator');
      const placed = placeSegments(timeline, finalRow.startsAtMs, finalRow.plannedEndsAtMs - finalRow.startsAtMs, finalRow.budget);
      const expected = settleAt(simulator as never, timeline, placed, finalRow.endsAtMs, 'complete', finalRow.config as never,
        finalRow.snapshot.participants as never);
      if (!expected.ok) throw new Error(`expected settlement was refused: ${expected.code}`);
      const rawBag = mergeDeltas(defaultSettle(timeline, finalRow.settledCutoff as number));
      const expectedBag = applyBagLoss(rawBag, DEFAULT_RPG_IDLE_TUNING.deathBagLossBp);
      expect(expected.settlement.deltas.filter(delta => delta.from === undefined))
        .toEqual(expectedBag.filter(delta => delta.from === undefined));
      const rawGrantQty = rawBag.filter(delta => delta.from === undefined).reduce((n, delta) => n + delta.qty, 0);
      const keptGrantQty = expectedBag.filter(delta => delta.from === undefined).reduce((n, delta) => n + delta.qty, 0);
      expect((completed.report?.gold.earned ?? 0) + (completed.report?.loot ?? []).reduce((n, row) => n + row.earned, 0)).toBe(rawGrantQty);
      expect((completed.report?.gold.secured ?? 0) + (completed.report?.loot ?? []).reduce((n, row) => n + row.secured, 0)).toBe(keptGrantQty);
      expect(rawGrantQty).toBeGreaterThan(0);
      expect(keptGrantQty).toBeLessThan(rawGrantQty);
      const settlementId = `${dto.id}:0`;
      const actualEntries = await database.db.select().from(ledgerEntries).where(and(eq(ledgerEntries.sourceType, 'expedition_settlement'), eq(ledgerEntries.sourceId, settlementId)));
      const expectedEntries = expected.settlement.deltas.filter(delta => delta.qty !== 0).map((delta, seq) => ({
        seq,
        assetKind: delta.asset.kind === 'unique_mint' ? 'unique_mint' : delta.asset.kind,
        assetRef: delta.asset.kind === 'stack' ? delta.asset.item : delta.asset.kind === 'currency' ? delta.asset.currency
          : delta.asset.kind === 'unique' ? delta.asset.itemId : delta.asset.item,
        qty: delta.qty, fromContainer: delta.from ?? null, toContainer: delta.to ?? null,
      }));
      expect(actualEntries.map(({ seq, assetKind, assetRef, qty, fromContainer, toContainer }) => ({ seq, assetKind, assetRef, qty, fromContainer, toContainer })))
        .toEqual(expectedEntries);
      expect((await database.db.select().from(actors).where(eq(actors.actorId, character.actorId)))[0])
        .toMatchObject({ activityState: 'none', activityId: null });
      const settlementBatches = await database.db.select().from(ledgerBatches).where(and(eq(ledgerBatches.sourceType, 'expedition_settlement'), eq(ledgerBatches.sourceId, `${dto.id}:0`)));
      expect(settlementBatches).toHaveLength(1);
      expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId], []))).toEqual([]);
    } finally { await worker.close(); }
  });

  it('survives concurrent settlement retries across many persisted seeds with ledger invariants intact', async () => {
    const actorIds: string[] = [];
    const activeIds: string[] = [];
    for (let seed = 101; seed <= 116; seed++) {
      clock.set(START_AT);
      const { session, character } = await fixture({ potionQty: seed % 2 });
      actorIds.push(character.actorId);
      nextSeed = seed;
      const started = await start(session, character.actorId, { durationMin: 30, consumableQty: seed % 2 });
      expect(started.response.statusCode).toBe(201);
      const dto = started.response.json<ExpeditionDto>();
      activeIds.push(dto.id);
    }
    const rows = await database.db.select().from(expeditions).where(eq(expeditions.status, 'running'));
    const selected = rows.filter(row => activeIds.includes(row.id));
    expect(selected).toHaveLength(activeIds.length);
    clock.set(Math.max(...selected.map(row => row.endsAtMs)));
    const settled = await Promise.all(selected.flatMap(row => [
      database.db.transaction(tx => createExpeditionService(tx, clock, bundle as never).settleJob(row.id, row.revision)),
      database.db.transaction(tx => createExpeditionService(tx, clock, bundle as never).settleJob(row.id, row.revision)),
    ]));
    expect(settled).toHaveLength(activeIds.length * 2);
    const terminal = await database.db.select().from(expeditions).where(eq(expeditions.status, 'completed'));
    expect(terminal.filter(row => activeIds.includes(row.id))).toHaveLength(activeIds.length);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, actorIds, []))).toEqual([]);
  }, 30_000);
});

/** Find a reproducible early-fatal real simulator seed for this authenticated character snapshot. */
function findFatalSeed(bundle: unknown, character: CharacterDto): number {
  return findSeed(bundle, character, DEFAULT_CONFIG, timeline => {
    if (timeline.outcome !== 'failed') return false;
    const progress = rpgProgress(timeline as never, timeline.segments.length - 1, 'completed');
    const actor = progress.actors.find(row => row.actorId === character.actorId);
    if (!progress.applyDeathPenalty || !actor?.died || actor.xpEarned === 0) return false;
    const rawBag = mergeDeltas(defaultSettle(timeline, timeline.segments.length - 1));
    const keptBag = applyBagLoss(rawBag, DEFAULT_RPG_IDLE_TUNING.deathBagLossBp);
    return rawBag.filter(delta => delta.from === undefined).reduce((n, delta) => n + delta.qty, 0) >
      keptBag.filter(delta => delta.from === undefined).reduce((n, delta) => n + delta.qty, 0);
  });
}

/** Picks a cancellation seed that has a visible prefix before its natural early end. */
function findEarlyRevealingSeed(bundle: unknown, character: CharacterDto, config: unknown): number {
  return findSeed(bundle, character, config, (timeline, placed) => timeline.outcome === 'failed' &&
    placed.endsAtMs > START_AT + 5 * 60_000 && new Set(placed.segments.filter(segment =>
      segment.revealAtMs > START_AT && segment.revealAtMs <= START_AT + 5 * 60_000).map(segment => segment.revealAtMs)).size >= 2);
}

function findSeed(bundle: unknown, character: CharacterDto, rawConfig: unknown,
  predicate: (timeline: Timeline<unknown, unknown>, placed: PlacedTimeline<unknown, unknown>) => boolean): number {
  const content = rpgIdleContentFromBundle(bundle as never);
  const registry = createRpgActivityRegistry(content);
  const simulator = registry.get(HUNT);
  if (!simulator) throw new Error(`missing simulator ${HUNT}`);
  const actors = [snapshotRpgActor(character as never, [], bundle as never)];
  const evalContext = { actor: createActorWorldState({ completedAreas: [REGION] }), game: { defeatedEnemies: new Set<string>(), level: character.level } };
  const gate = checkStart({ world: (bundle as { world: unknown }).world as never,
    request: { areaId: REGION, activityId: HUNT, durationMin: 60, paceBp: 10_000 }, activities: registry,
    simulator, rawConfig, actors, evalContexts: [evalContext], predicates: createRpgPredicateRegistry() });
  if (!gate.ok) throw new Error(`test fixture could not pass start gate: ${gate.code}`);
  for (let seed = 1; seed <= 2_000; seed++) {
    const timeline = simulator.simulate({ config: gate.config, actors, seed, budget: gate.budget, areaId: REGION, activityId: HUNT });
    const placed = placeSegments(timeline, START_AT, 60 * 60_000, gate.budget);
    if (placed.endsAtMs < placed.plannedEndsAtMs && predicate(timeline, placed)) return seed;
  }
  throw new Error('no matching deterministic simulator seed found in the fixture search range');
}
