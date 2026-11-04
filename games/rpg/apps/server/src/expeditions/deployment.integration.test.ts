import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { compileContentDirectory } from '@engine/content-compiler';
import { createDatabase, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import { applyLedgerDeltas, checkLedgerInvariants, getHoldings, ledgerBatches, ledgerEntries, actors } from '@engine/server-kit';
import { checkStart, defaultSettle, placeSegments, settleAt, timelineHash } from '@engine/expedition-kernel';
import type { Timeline } from '@engine/expedition-kernel';
import { applyBagLoss, createRpgActivityRegistry, DEFAULT_RPG_IDLE_TUNING, mergeDeltas, rpgIdleContentFromBundle, rpgProgress } from '@rpg/rpg-sim';
import type { RpgIdleEvent, RpgIdleState } from '@rpg/rpg-sim';
import { createRpgPredicateRegistry, XpCurveSchema } from '@rpg/rpg-schema';
import { applyDeathXpLoss, applyXpLoss, deathXpLossBp, levelForXp, totalXpFromLevelProgress, xpProgress } from '@rpg/rpg-stats';
import { createActorWorldState } from '@engine/world';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { deflateSync, inflateSync } from 'node:zlib';
import plugin from '@rpg/content-plugin';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { characters } from '../characters/schema.ts';
import { recordAreaCompletion } from './progress.ts';
import { expeditions } from './schema.ts';
import { supportedSettlementPolicies } from './policy.ts';
import { snapshotRpgActor } from './service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL deployment acceptance tests');
const token = () => randomBytes(32).toString('base64url');
const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';
const START_AT = 1_800_000_000_000;
const DEFAULT_CONFIG = { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } };

interface Session { accountId: string; sessionToken: string }
interface CharacterDto { actorId: string; accountId: string; level: number; xp: number; attributes: Record<string, number>; skillLoadout: string[]; automationRules: unknown[] }
interface DeploymentDto {
  id: string; actorId: string; state: 'running' | 'completed' | 'cancelled';
  startsAtMs: number; plannedEndsAtMs: number;
  segments: readonly { index: number; revealAtMs: number; events: readonly Record<string, unknown>[] }[];
  revealedDeltas: unknown; endsAtMs?: number; outcome?: unknown; recoveryAvailable?: boolean; terminalReport?: TerminalReport | null;
  report?: { availability: string; effectiveDurationMs: number | null; outcome: string | null; enemiesDefeated: number | null;
    xp: { earned: number | null; penaltyLost: number | null; net: number | null };
    gold: { earned: number | null; lost: number | null; secured: number | null };
    loot: readonly unknown[] | null; consumables: readonly { item: string; used: number | null; returned: number | null }[] | null;
    events: readonly string[] | null; finalState: { hp: number | null; maxHp: number | null; xpTotal: number | null }; death: unknown };
  [key: string]: unknown;
}
interface TerminalReport {
  version: number; kind: 'settled' | 'escrow_returned'; summary: unknown; settledDeltas: unknown;
  xp: readonly { actorId: string; xpEarned: number; xpBefore: number; xpAfter: number;
    xpPenaltyApplied: boolean; xpPenaltyBp: number; xpPenaltyLost: number }[];
  reason: 'completed' | 'cancelled' | 'version_unavailable'; cutoff: number | null;
}
interface Fixture { session: Session; character: CharacterDto }

describe.skipIf(!adminUrl)('expedition deployment compatibility against real PostgreSQL', () => {
  let admin: Database;
  let database: Database;
  let appA: Awaited<ReturnType<typeof createRpgServer>>;
  let appB: Awaited<ReturnType<typeof createRpgServer>> | undefined;
  let appAClosed = false;
  let configA: ServerConfig;
  let configB: ServerConfig;
  let directory: string;
  let contentDirectoryB: string;
  let bundleA: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let bundleB: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let nextSeed = 1;
  let syntheticSettleCalls = 0;
  let syntheticSummaryCalls = 0;
  const databaseName = `expedition_deploy_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(START_AT);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'expedition-deployment-'));
    const sourceDirectory = fileURLToPath(new URL('../../../../content', import.meta.url));
    const compiledA = compileContentDirectory(sourceDirectory, plugin);
    if (!compiledA.ok) throw new Error(JSON.stringify(compiledA.errors));
    bundleA = compiledA.bundle;
    const pathA = join(directory, 'bundle-a.json');
    await writeFile(pathA, JSON.stringify(bundleA));

    // This is a second real authored bundle with the in-flight hunt activity removed from both its collection and
    // world area references; changing only hash metadata would not exercise a deployment.
    contentDirectoryB = join(directory, 'content-b');
    await cp(sourceDirectory, contentDirectoryB, { recursive: true });
    const activitiesPath = join(contentDirectoryB, 'idle-activities', 'region_1.json');
    const activities = JSON.parse(await readFile(activitiesPath, 'utf8')) as Array<Record<string, unknown>>;
    const remainingActivities = activities.filter(row => row['id'] !== HUNT);
    if (remainingActivities.length !== activities.length - 1) throw new Error('real authored hunt activity is missing');
    await writeFile(activitiesPath, `${JSON.stringify(remainingActivities, null, 2)}\n`);
    const areaPath = join(contentDirectoryB, 'world', 'areas', 'region_1.json');
    const area = JSON.parse(await readFile(areaPath, 'utf8')) as { activities: string[] };
    area.activities = area.activities.filter(activityId => activityId !== HUNT);
    await writeFile(areaPath, `${JSON.stringify(area, null, 2)}\n`);
    const compiledB = compileContentDirectory(contentDirectoryB, plugin);
    if (!compiledB.ok) throw new Error(JSON.stringify(compiledB.errors));
    bundleB = compiledB.bundle;
    expect(bundleB.contentHash).not.toBe(bundleA.contentHash);
    const activityRate = (bundle: typeof bundleA) => (bundle.collections['idleActivities'] ?? [])
      .find(value => (value as { id?: unknown }).id === HUNT) as { encountersPerHour?: unknown } | undefined;
    expect(activityRate(bundleA)?.encountersPerHour).toBe(30);
    expect(activityRate(bundleB)).toBeUndefined();
    const pathB = join(directory, 'bundle-b.json');
    await writeFile(pathB, JSON.stringify(bundleB));

    const baseA = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: pathA, LOG_LEVEL: 'silent' });
    const baseB = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: pathB, LOG_LEVEL: 'silent' });
    admin = createDatabase(baseA);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(baseA.databaseUrl); url.pathname = `/${databaseName}`;
    configA = { ...baseA, databaseUrl: url.toString(), roles: ['api'] };
    configB = { ...baseB, databaseUrl: url.toString(), roles: ['api'] };
    database = createRpgDatabase(configA);
    await database.migrate();
    appA = await createRpgServer(configA, { clock, seedSource: () => nextSeed });
  }, 30_000);

  beforeEach(async () => {
    clock.set(START_AT); nextSeed = 1;
    if (appB) { await appB.close(); appB = undefined; }
    if (appAClosed) {
      appA = await createRpgServer(configA, { clock, seedSource: () => nextSeed });
      appAClosed = false;
    }
  });

  afterAll(async () => {
    await appB?.close();
    if (!appAClosed) await appA?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const headers = (session: Session) => ({ authorization: `Bearer ${session.sessionToken}` });
  function currentAppB() {
    if (!appB) throw new Error('bundle B server is not running');
    return appB;
  }
  async function guest(): Promise<Session> {
    const response = await appA.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  }
  async function createHero(session: Session): Promise<CharacterDto> {
    const response = await appA.inject({ method: 'POST', url: '/characters', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'character.create', payload: { name: 'Deployment hero' },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<CharacterDto>();
  }
  async function fixture(potionQty = 0): Promise<Fixture> {
    const session = await guest();
    const character = await createHero(session);
    await database.db.transaction(tx => recordAreaCompletion(tx, clock, character.actorId, REGION));
    if (potionQty > 0) await database.db.transaction(tx => applyLedgerDeltas(tx,
      { type: 'test_fixture', id: `${character.actorId}:deployment-potion` }, [{ actorId: character.actorId,
        asset: { kind: 'stack', item: POTION }, qty: potionQty }]));
    return { session, character };
  }
  async function start(session: Session, actorId: string, options: { durationMin?: number; consumableQty?: number } = {}, app = appA) {
    const response = await app.inject({ method: 'POST', url: '/expeditions', headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'expedition.start', payload: { actorId,
        request: { areaId: REGION, activityId: HUNT, durationMin: options.durationMin ?? 60, paceBp: 10_000 },
        config: { ...DEFAULT_CONFIG, consumables: options.consumableQty ? [{ item: POTION, qty: options.consumableQty }] : [] } },
    } });
    return response;
  }
  async function get(session: Session, id: string, app = currentAppB()) {
    return app.inject({ url: `/expeditions/${id}`, headers: headers(session) });
  }
  async function list(session: Session, actorId: string) {
    return currentAppB().inject({ url: `/characters/${actorId}/expeditions`, headers: headers(session) });
  }
  async function cancel(session: Session, id: string, app = currentAppB()) {
    return app.inject({ method: 'POST', url: `/expeditions/${id}/cancel`, headers: headers(session), payload: {
      command_id: randomUUID(), operation: 'expedition.cancel', payload: { expeditionId: id },
    } });
  }
  async function recover(session: Session, id: string, commandId = randomUUID()) {
    return currentAppB().inject({ method: 'POST', url: `/expeditions/${id}/recover-unavailable`, headers: headers(session), payload: {
      command_id: commandId, operation: 'expedition.recoverUnavailable', payload: { expeditionId: id },
    } });
  }
  async function persisted(id: string) {
    const [row] = await database.db.select().from(expeditions).where(eq(expeditions.id, id));
    if (!row) throw new Error(`expedition ${id} missing from PostgreSQL`);
    return row;
  }
  async function terminalReport(id: string): Promise<TerminalReport | null> {
    const result = await database.pool.query<{ terminal_report: TerminalReport | null }>(
      'SELECT terminal_report FROM rpg_expeditions WHERE id=$1', [id]);
    if (!result.rows[0]) throw new Error(`expedition ${id} missing terminal report row`);
    return result.rows[0].terminal_report;
  }
  async function waitForQueueCompletion(singletonKey: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await database.pool.query<{ count: string }>(
        "SELECT count(*) FROM pgboss.job WHERE name='rpg.expedition.settle' AND singleton_key=$1 AND state='completed'", [singletonKey]);
      if (Number(result.rows[0]?.count ?? '0') === 1) return;
      await delay(25);
    }
    throw new Error(`PostgreSQL queue did not complete ${singletonKey}`);
  }
  async function startAndVerify(session: Session, actorId: string, options: { durationMin?: number; consumableQty?: number } = {}, app = appA) {
    const response = await start(session, actorId, options, app);
    expect(response.statusCode).toBe(201);
    return response.json<DeploymentDto>();
  }
  function deploymentPolicies() {
    const old = supportedSettlementPolicies.find(policy => policy.kernelVersion === '0.3.0' &&
      policy.simulatorId === 'rpg.hunt' && policy.simulatorVersion === 'rpg-idle@2.0.0+rpg-sim@1.1.0');
    if (!old) throw new Error('expected deployed settlement policy tuple is missing');
    const next = { ...old, kernelVersion: '0.4.0-test', simulatorVersion: 'rpg-idle@3.0.0+rpg-sim@1.1.0',
      simulator: { ...old.simulator,
        summarize: (...args: Parameters<typeof old.simulator.summarize>) => {
          syntheticSummaryCalls++;
          return old.simulator.summarize(...args);
        },
        settle: (...args: Parameters<typeof old.simulator.settle>) => {
          syntheticSettleCalls++;
          return old.simulator.settle(...args);
        } } };
    return [...supportedSettlementPolicies, next];
  }
  async function deployBundleB(policies = deploymentPolicies()) {
    if (!appAClosed) { await appA.close(); appAClosed = true; }
    if (appB) await appB.close();
    appB = await createRpgServer(configB, { clock, settlementPolicies: policies });
  }
  function assertRunningDoesNotLeak(dto: DeploymentDto) {
    expect(dto.state).toBe('running');
    expect(dto.endsAtMs).toBeUndefined();
    expect(dto.outcome).toBeUndefined();
    expect(dto.segments.every(segment => segment.revealAtMs <= clock.nowMs())).toBe(true);
    expect(dto.segments.flatMap(segment => segment.events).map(event => event['type']))
      .not.toEqual(expect.arrayContaining(['death', 'retreat']));
    expect(JSON.stringify(dto)).not.toMatch(/"(?:seed|budget|stateAfter|timelineCompressed|timelineHash|endsAtMs)"\s*:/);
    expect(dto.summary).toMatchObject({ outcome: null });
  }

  it('keeps an in-flight run, partial cancellation, and lazy completion readable after a real content deploy', async () => {
    const cancelledFixture = await fixture(1);
    const completedFixture = await fixture();
    // Both rows are created with bundle A, before any process loads bundle B.
    nextSeed = findPartialCancelSeed(bundleA, cancelledFixture.character);
    const cancelledStart = await startAndVerify(cancelledFixture.session, cancelledFixture.character.actorId, { consumableQty: 1 });
    nextSeed = findFatalSeed(bundleA, completedFixture.character);
    const completedStart = await startAndVerify(completedFixture.session, completedFixture.character.actorId);
    const [cancelledOriginal, completedOriginal] = await Promise.all([persisted(cancelledStart.id), persisted(completedStart.id)]);
    expect([cancelledOriginal.contentHash, completedOriginal.contentHash]).toEqual([bundleA.contentHash, bundleA.contentHash]);

    syntheticSettleCalls = 0; syntheticSummaryCalls = 0;
    await deployBundleB();
    expect(bundleB.contentHash).not.toBe(cancelledOriginal.contentHash);
    clock.advance(5 * 60_000);
    const live = await get(cancelledFixture.session, cancelledStart.id);
    expect(live.statusCode).toBe(200);
    const liveDto = live.json<DeploymentDto>();
    assertRunningDoesNotLeak(liveDto);
    expect(liveDto.segments.length).toBeGreaterThan(0);
    expect((await persisted(cancelledStart.id)).contentHash).toBe(bundleA.contentHash);

    const cancelledResponse = await cancel(cancelledFixture.session, cancelledStart.id);
    expect(cancelledResponse.statusCode).toBe(200);
    const cancelledDto = cancelledResponse.json<DeploymentDto>();
    expect(cancelledDto.state).toBe('cancelled');
    expect(cancelledDto.outcome).toBe('cancelled');
    expect(cancelledDto.endsAtMs).toBe(START_AT + 5 * 60_000);
    expect(cancelledDto.endsAtMs).toBeLessThan(cancelledDto.plannedEndsAtMs);
    expect(cancelledDto.segments).toHaveLength(liveDto.segments.length);
    expect(cancelledDto.terminalReport).toMatchObject({ version: 1, kind: 'settled', reason: 'cancelled' });
    const cancelReport = await terminalReport(cancelledStart.id);
    expect(cancelReport).toEqual(cancelledDto.terminalReport);
    const cancelTimeline = JSON.parse(inflateSync(Buffer.from(cancelledOriginal.timelineCompressed, 'base64')).toString('utf8')) as Timeline<RpgIdleEvent, RpgIdleState>;
    const originalSimulator = createRpgActivityRegistry(rpgIdleContentFromBundle(bundleA as never)).get(HUNT);
    if (!originalSimulator) throw new Error(`missing bundle A simulator ${HUNT}`);
    const originalPlaced = placeSegments(cancelTimeline, cancelledOriginal.startsAtMs,
      cancelledOriginal.plannedEndsAtMs - cancelledOriginal.startsAtMs, cancelledOriginal.budget);
    const expectedCancellation = settleAt(originalSimulator as never, cancelTimeline, originalPlaced,
      START_AT + 5 * 60_000, 'cancel', cancelledOriginal.config as never, cancelledOriginal.snapshot.participants as never);
    if (!expectedCancellation.ok) throw new Error(`bundle A cancel calculation failed: ${expectedCancellation.code}`);
    expect(cancelReport?.settledDeltas).toEqual(expectedCancellation.settlement.deltas);
    expect(cancelReport?.xp[0]?.xpAfter).toBeGreaterThanOrEqual(cancelReport?.xp[0]?.xpBefore ?? 0);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [cancelledFixture.character.actorId], []))).toEqual([]);
    await database.pool.query("UPDATE rpg_expeditions SET timeline_compressed='cancel timeline intentionally unreadable' WHERE id=$1", [cancelledStart.id]);

    // The completed row exercises lazy settlement under B, after B changed authored encounter tuning. It must still
    // use the A timeline and its registered policy tuple. No 24-hour jump: guest sessions live for 12 hours.
    clock.set(completedOriginal.endsAtMs);
    const completionResponse = await get(completedFixture.session, completedStart.id);
    expect(completionResponse.statusCode).toBe(200);
    const completedDto = completionResponse.json<DeploymentDto>();
    expect(completedDto.state).toBe('completed');
    expect(completedDto.terminalReport).toMatchObject({ version: 1, kind: 'settled', reason: 'completed' });
    const completedReport = await terminalReport(completedStart.id);
    const completedRow = await persisted(completedStart.id);
    expect(completedReport).toEqual(completedDto.terminalReport);
    expect(completedReport?.summary).toEqual(completedDto.summary);
    expect(syntheticSummaryCalls).toBe(0);
    expect(completedReport?.xp[0]).toMatchObject({ xpPenaltyApplied: true, xpPenaltyBp: expect.any(Number) });
    // Started under the current release (rpg-idle@2.1.0): level-scaled rate of the level reached with the XP earned (#129).
    const curveA = XpCurveSchema.parse({ xpToNext: completedOriginal.snapshot.xpCurve, tailGrowthBp: completedOriginal.snapshot.xpTailGrowthBp });
    expect(completedOriginal.simulatorVersion).toBe('rpg-idle@2.1.0+rpg-sim@1.1.0');
    expect(completedReport?.xp[0]?.xpPenaltyBp).toBe(deathXpLossBp(levelForXp(
      (completedReport?.xp[0]?.xpBefore ?? 0) + (completedReport?.xp[0]?.xpEarned ?? 0), curveA)));
    const completedTimeline = JSON.parse(inflateSync(Buffer.from(completedRow.timelineCompressed, 'base64')).toString('utf8')) as Timeline<RpgIdleEvent, RpgIdleState>;
    const rawGrants = mergeDeltas(defaultSettle(completedTimeline, completedRow.settledCutoff as number));
    const oldPolicyGrants = applyBagLoss(rawGrants, DEFAULT_RPG_IDLE_TUNING.deathBagLossBp);
    expect(completedReport?.settledDeltas).toEqual(oldPolicyGrants);
    expect(syntheticSettleCalls).toBe(0);
    const actorAfter = (await database.db.select().from(characters).where(eq(characters.actorId, completedFixture.character.actorId)))[0];
    expect(totalXpFromLevelProgress(actorAfter?.level ?? 1, actorAfter?.xp ?? 0, curveA)).toBe(completedReport?.xp[0]?.xpAfter);
    expect(completedRow.contentHash).toBe(bundleA.contentHash);

    // A report read must not need either the old simulator bundle or a parseable saved timeline.
    await database.pool.query("UPDATE rpg_expeditions SET timeline_compressed='intentionally unreadable after durable report' WHERE id=$1", [completedStart.id]);
    await currentAppB().close();
    appB = await createRpgServer(configB, { clock, settlementPolicies: [] });
    const reportOnly = await get(completedFixture.session, completedStart.id);
    expect(reportOnly.statusCode).toBe(200);
    expect(reportOnly.json<DeploymentDto>().terminalReport).toEqual(completedReport);
    expect(await get(cancelledFixture.session, cancelledStart.id).then(response => response.json<DeploymentDto>().terminalReport))
      .toEqual(cancelReport);
    const cancelledAgain = await cancel(cancelledFixture.session, cancelledStart.id);
    expect(cancelledAgain.statusCode).toBe(200);
    expect(cancelledAgain.json<DeploymentDto>().terminalReport).toEqual(cancelReport);
  }, 30_000);

  it('uses a registered compatible kernel tuple, keeps old policy output, and bounds history to the newest 20', async () => {
    const { session, character } = await fixture();
    // Seed 20 terminal rows through bundle A before deployment. Bundle B removes this activity, so its list/read path
    // must not consult the current activity catalog to render those persisted reports.
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      clock.set(START_AT + index * 60_000);
      const created = await startAndVerify(session, character.actorId, { durationMin: 15 });
      ids.push(created.id);
      clock.set(START_AT + index * 60_000 + 30_000);
      const cancelled = await cancel(session, created.id, appA);
      expect(cancelled.statusCode).toBe(200);
    }
    clock.set(START_AT + 20 * 60_000);
    const started = await startAndVerify(session, character.actorId, { durationMin: 15 });
    const row = await persisted(started.id);
    // DB-only fixture marks this old timeline as produced by a different kernel generation. Bundle B explicitly
    // registers that compatible tuple; no client payload can choose it.
    await database.pool.query("UPDATE rpg_expeditions SET kernel_version='0.4.0-test', simulator_version='rpg-idle@3.0.0+rpg-sim@1.1.0' WHERE id=$1", [started.id]);
    syntheticSettleCalls = 0; syntheticSummaryCalls = 0;
    await deployBundleB();
    const compatibleRunning = await get(session, started.id);
    expect(compatibleRunning.statusCode).toBe(200);
    expect(compatibleRunning.json<DeploymentDto>().state).toBe('running');
    expect(syntheticSummaryCalls).toBe(1);
    expect(syntheticSettleCalls).toBe(1); // running cancelPreview uses this policy's settle function
    syntheticSettleCalls = 0;
    clock.set(row.endsAtMs);
    const settled = await get(session, started.id);
    expect(settled.statusCode).toBe(200);
    expect(settled.json<DeploymentDto>().state).toBe('completed');
    expect(syntheticSettleCalls).toBe(1); // final lazy settlement also selects the registered compatible tuple
    expect(syntheticSummaryCalls).toBe(2);

    // A legacy terminal without a migrated report can still expose the immutable, already-settled timeline prefix
    // when its frozen producer tuple and compressed timeline remain readable. It does not invent settlement facts.
    await database.pool.query('UPDATE rpg_expeditions SET terminal_report=NULL WHERE id=$1', [started.id]);
    const legacy = await get(session, started.id);
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json<DeploymentDto>()).toMatchObject({ terminalReport: null, report: { availability: 'legacy_unavailable',
      effectiveDurationMs: null, enemiesDefeated: null, loot: null, consumables: null, events: null } });
    expect(legacy.json<DeploymentDto>().segments).toEqual(settled.json<DeploymentDto>().segments);
    expect((await list(session, character.actorId)).statusCode).toBe(200);
    expect(syntheticSummaryCalls).toBe(2);

    // Unreadable legacy timelines keep the safe minimal projection.
    await database.pool.query("UPDATE rpg_expeditions SET timeline_compressed='legacy damaged timeline' WHERE id=$1", [started.id]);
    const unreadableLegacy = await get(session, started.id);
    expect(unreadableLegacy.statusCode).toBe(200);
    expect(unreadableLegacy.json<DeploymentDto>()).toMatchObject({ state: 'completed', segments: [], terminalReport: null,
      report: { availability: 'legacy_unavailable', effectiveDurationMs: null, enemiesDefeated: null } });

    // A valid compressed JSON payload with a matching hash can still be structurally invalid for placement. Legacy
    // terminal projection catches failures after inflation/hash validation too, without trying current simulators.
    const malformedTimeline = { segments: [], outcome: 'unknown' } as unknown as Timeline<unknown, unknown>;
    const malformedHash = String(timelineHash(malformedTimeline));
    const malformedCompressed = deflateSync(Buffer.from(JSON.stringify(malformedTimeline))).toString('base64');
    await database.pool.query('UPDATE rpg_expeditions SET timeline_compressed=$2,timeline_hash=$3 WHERE id=$1',
      [started.id, malformedCompressed, malformedHash]);
    const malformedLegacy = await get(session, started.id);
    expect(malformedLegacy.statusCode).toBe(200);
    expect(malformedLegacy.json<DeploymentDto>()).toMatchObject({ id: started.id, actorId: character.actorId,
      state: 'completed', segments: [], terminalReport: null });
    const malformedHistory = await list(session, character.actorId);
    expect(malformedHistory.statusCode).toBe(200);
    expect(malformedHistory.json<DeploymentDto[]>()).toContainEqual(expect.objectContaining({ id: started.id, terminalReport: null }));
    const cancelMalformedTerminal = await cancel(session, started.id);
    expect(cancelMalformedTerminal.statusCode).toBe(200);
    expect(cancelMalformedTerminal.json<DeploymentDto>()).toMatchObject({ id: started.id, actorId: character.actorId,
      state: 'completed', segments: [], terminalReport: null });
    expect(syntheticSummaryCalls).toBe(2);

    const historyA = await currentAppB().inject({ url: `/characters/${character.actorId}/expeditions`, headers: headers(session) });
    expect(historyA.statusCode).toBe(200);
    const history = historyA.json<DeploymentDto[]>();
    expect(history).toHaveLength(20);
    const expectedOrder = await database.pool.query<{ id: string }>(
      'SELECT id FROM rpg_expeditions WHERE actor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [character.actorId]);
    expect(history.map(dto => dto.id)).toEqual(expectedOrder.rows.map(row => row.id));
    expect(history.map(dto => dto.id)).not.toContain(ids[0]);
    const historyAgain = await currentAppB().inject({ url: `/characters/${character.actorId}/expeditions`, headers: headers(session) });
    expect(historyAgain.json<DeploymentDto[]>()).toEqual(history);
  }, 60_000);

  it('settles an expedition started under rpg-idle@2.0.0 with the old death rule while a new start uses the level-scaled rule (#129)', async () => {
    const oldHero = await fixture();
    const newHero = await fixture();
    for (const { character } of [oldHero, newHero]) {
      await database.db.update(characters).set({ level: 1, xp: 90 }).where(eq(characters.actorId, character.actorId));
    }
    const startFatal = async (hero: Fixture) => {
      nextSeed = findFatalSeed(bundleA, { ...hero.character, xp: 90 });
      return startAndVerify(hero.session, hero.character.actorId);
    };
    const oldStart = await startFatal(oldHero);
    const newStart = await startFatal(newHero);
    // The new release stamps the new contract and stores the open-ended curve with the snapshot.
    const newRow = await persisted(newStart.id);
    expect(newRow.simulatorVersion).toBe('rpg-idle@2.1.0+rpg-sim@1.1.0');
    expect(newRow.snapshot).toMatchObject({ xpCurve: [100, 250, 450, 700, 1000], xpTailGrowthBp: 12_500 });
    // DB-only fixture: this row is what the previous release persisted (its version tuple, a snapshot without a tail).
    await database.pool.query(`UPDATE rpg_expeditions SET simulator_version='rpg-idle@2.0.0+rpg-sim@1.1.0',
      snapshot = snapshot - 'xpTailGrowthBp' WHERE id=$1`, [oldStart.id]);
    const oldRow = await persisted(oldStart.id);
    expect(oldRow.snapshot).not.toHaveProperty('xpTailGrowthBp');

    clock.set(Math.max(oldRow.endsAtMs, newRow.endsAtMs));
    const settledOld = (await get(oldHero.session, oldStart.id, appA)).json<DeploymentDto>();
    const settledNew = (await get(newHero.session, newStart.id, appA)).json<DeploymentDto>();
    expect([settledOld.state, settledNew.state]).toEqual(['completed', 'completed']);
    const [oldReport, newReport] = [await terminalReport(oldStart.id), await terminalReport(newStart.id)];
    const oldXp = oldReport?.xp[0];
    const newXp = newReport?.xp[0];
    if (!oldXp || !newXp) throw new Error('settled reports have no XP rows');
    expect([oldXp.xpPenaltyApplied, newXp.xpPenaltyApplied]).toEqual([true, true]);

    const table = [100, 250, 450, 700, 1000];
    const capped = { xpToNext: table };
    const open = { xpToNext: table, tailGrowthBp: 12_500 };
    // Old contract: 10% of the XP the next level needs, from the capped table (exactly the pre-#129 helper).
    const oldTotal = oldXp.xpBefore + oldXp.xpEarned;
    const oldExpected = applyXpLoss(oldTotal, 1_000, capped);
    expect(oldXp).toMatchObject({ xpBefore: 90, xpPenaltyBp: 1_000, xpPenaltyLost: oldExpected.xpLost, xpAfter: oldExpected.totalXp });
    // New contract: level-scaled share of the total, with the one-level cap.
    const newTotal = newXp.xpBefore + newXp.xpEarned;
    const newExpected = applyDeathXpLoss(newTotal, open);
    expect(newXp).toMatchObject({ xpBefore: 90, xpPenaltyBp: deathXpLossBp(levelForXp(newTotal, open)),
      xpPenaltyLost: newExpected.xpLost, xpAfter: newExpected.totalXp });
    // The two rules really differ for the same kind of run, so this test would catch a policy mix-up.
    expect(oldExpected.xpLost).not.toBe(applyDeathXpLoss(oldTotal, open).xpLost);
    // The persisted pairs follow each outcome (both read and written with the open-ended curve).
    for (const [hero, expected] of [[oldHero, oldExpected.totalXp], [newHero, newExpected.totalXp]] as const) {
      const row = (await database.db.select().from(characters).where(eq(characters.actorId, hero.character.actorId)))[0];
      const progress = xpProgress(expected, open);
      expect(row).toMatchObject({ level: progress.level, xp: progress.xpIntoLevel });
    }
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [oldHero.character.actorId, newHero.character.actorId], []))).toEqual([]);
  }, 60_000);

  it('migration 0009 normalizes characters that piled XP up at the old level cap and leaves everyone else untouched (#129)', async () => {
    const sql = await readFile(fileURLToPath(new URL('../../migrations/0009_open_xp_curve.sql', import.meta.url)), 'utf8');
    const rows = [
      { label: 'legacy overflow', level: 6, xp: 3_000, expected: { level: 8, xp: 3_000 + 2_500 - 5_312 } }, // total 5500
      { label: 'just at the old cap boundary', level: 6, xp: 1_250, expected: { level: 7, xp: 0 } }, // total 3750
      { label: 'level 6 below the new requirement', level: 6, xp: 1_249, expected: { level: 6, xp: 1_249 } },
      { label: 'level 5', level: 5, xp: 999, expected: { level: 5, xp: 999 } },
      { label: 'level 1', level: 1, xp: 0, expected: { level: 1, xp: 0 } },
      { label: 'level 7 already', level: 7, xp: 100, expected: { level: 7, xp: 100 } },
    ];
    const fixtures: { actorId: string; expected: { level: number; xp: number }; label: string }[] = [];
    for (const row of rows) {
      const { character } = await fixture();
      await database.db.update(characters).set({ level: row.level, xp: row.xp }).where(eq(characters.actorId, character.actorId));
      fixtures.push({ actorId: character.actorId, expected: row.expected, label: row.label });
    }
    await database.pool.query(sql);
    await database.pool.query(sql); // idempotent
    for (const { actorId, expected, label } of fixtures) {
      const row = (await database.db.select().from(characters).where(eq(characters.actorId, actorId)))[0];
      expect(row, label).toMatchObject(expected);
    }
  }, 60_000);

  it('migration 0010 widens every XP column to bigint without changing existing rows (#129)', async () => {
    const sql = await readFile(fileURLToPath(new URL('../../migrations/0010_xp_bigint.sql', import.meta.url)), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
    const columns = [['rpg_characters', 'xp'], ['rpg_live_deaths', 'xp_before_into_level'], ['rpg_live_deaths', 'xp_before_total'],
      ['rpg_live_deaths', 'xp_lost'], ['rpg_live_deaths', 'xp_after_into_level'], ['rpg_live_deaths', 'xp_after_total']] as const;
    const typeOf = async (table: string, column: string) => (await database.pool.query<{ data_type: string }>(
      'SELECT data_type FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, column])).rows[0]?.data_type;
    for (const [table, column] of columns) expect(await typeOf(table, column), `${table}.${column}`).toBe('bigint');
    // Rebuild the pre-migration state (32-bit columns and the old CHECKs), put known rows in it, then re-apply 0010.
    const { character } = await fixture();
    for (const [table, column] of columns) await database.pool.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE integer`);
    await database.pool.query('UPDATE rpg_characters SET level=9, xp=2147483647 WHERE actor_id=$1', [character.actorId]);
    await database.pool.query(`INSERT INTO rpg_live_deaths (death_id, actor_id, instance_id, area_id, location_id, occurred_at, expires_at, status,
      xp_before_level, xp_before_into_level, xp_before_total, xp_lost, xp_after_level, xp_after_into_level, xp_after_total, causes, bag_snapshot)
      VALUES ($1,$2,$3,'area:a','loc:a',now(),now(),'expired',9,2147483647,2147483647,5,9,2147483642,2147483642,'[]','{"stacks":[],"gold":0,"uniques":[]}')`,
      [randomUUID(), character.actorId, randomUUID()]);
    for (const statement of statements) await database.pool.query(statement);
    for (const [table, column] of columns) expect(await typeOf(table, column), `${table}.${column}`).toBe('bigint');
    const migrated = await database.pool.query('SELECT level, xp::text AS xp FROM rpg_characters WHERE actor_id=$1', [character.actorId]);
    expect(migrated.rows[0]).toEqual({ level: 9, xp: '2147483647' });
    const death = await database.pool.query(`SELECT xp_before_into_level::text a, xp_before_total::text b, xp_lost::text c, xp_after_into_level::text d,
      xp_after_total::text e FROM rpg_live_deaths WHERE actor_id=$1`, [character.actorId]);
    expect(death.rows[0]).toEqual({ a: '2147483647', b: '2147483647', c: '5', d: '2147483642', e: '2147483642' });
    // 64-bit values now fit, up to the safe-integer ceiling; beyond it the CHECK refuses the write.
    await database.pool.query('UPDATE rpg_characters SET xp=9007199254740991 WHERE actor_id=$1', [character.actorId]);
    await expect(database.pool.query('UPDATE rpg_characters SET xp=9007199254740992 WHERE actor_id=$1', [character.actorId]))
      .rejects.toMatchObject({ code: '23514' });
    await database.pool.query('UPDATE rpg_characters SET level=1, xp=0 WHERE actor_id=$1', [character.actorId]);
    await database.pool.query('DELETE FROM rpg_live_deaths WHERE actor_id=$1', [character.actorId]);
  }, 60_000);

  it('settles XP across the 32-bit boundary under the 2.1.0 policy at level 71 and the same grant under 2.0.0 (#129)', async () => {
    const INT32_MAX = 2_147_483_647;
    const open = { xpToNext: [100, 250, 450, 700, 1000], tailGrowthBp: 12_500 };
    const hero = await fixture();
    const legacy = await fixture();
    for (const { character } of [hero, legacy]) {
      await database.db.update(characters).set({ level: 71, xp: INT32_MAX - 20 }).where(eq(characters.actorId, character.actorId));
    }
    const settle = async (who: Fixture, legacyPolicy: boolean) => {
      const character = { ...who.character, level: 71, xp: INT32_MAX - 20 };
      nextSeed = findSurvivingSeed(bundleA, character);
      const started = await startAndVerify(who.session, who.character.actorId);
      if (legacyPolicy) await database.pool.query(`UPDATE rpg_expeditions SET simulator_version='rpg-idle@2.0.0+rpg-sim@1.1.0',
        snapshot = snapshot - 'xpTailGrowthBp' WHERE id=$1`, [started.id]);
      const row = await persisted(started.id);
      clock.set(row.endsAtMs);
      expect((await get(who.session, started.id, appA)).json<DeploymentDto>().state).toBe('completed');
      const report = (await terminalReport(started.id))?.xp[0];
      if (!report) throw new Error('missing settled XP row');
      return report;
    };
    for (const [who, legacyPolicy] of [[hero, false], [legacy, true]] as const) {
      const report = await settle(who, legacyPolicy);
      const total = totalXpFromLevelProgress(71, INT32_MAX - 20, open);
      expect(report).toMatchObject({ xpBefore: total, xpPenaltyApplied: false, xpAfter: total + report.xpEarned });
      expect(report.xpEarned).toBeGreaterThan(20); // crosses INT32_MAX inside level 71
      const progress = xpProgress(total + report.xpEarned, open);
      const row = (await database.db.select().from(characters).where(eq(characters.actorId, who.character.actorId)))[0];
      expect(row).toMatchObject({ level: progress.level, xp: progress.xpIntoLevel });
      expect(progress.xpIntoLevel).toBeGreaterThan(INT32_MAX);
      expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [who.character.actorId], []))).toEqual([]);
      clock.set(START_AT);
    }
  }, 90_000);

  it('recovers an unknown simulator tuple by returning exact escrow once, without XP or rewards, across job and cancel races', async () => {
    const { session, character } = await fixture(2);
    const started = await startAndVerify(session, character.actorId, { consumableQty: 1 });
    const row = await persisted(started.id);
    await deployBundleB();
    // Privileged fixture simulates a binary version unavailable to this deployment; clients cannot set version data.
    await database.pool.query("UPDATE rpg_expeditions SET simulator_version='simulator:unknown-test-v99', timeline_compressed='unreadable unknown-version timeline' WHERE id=$1", [started.id]);
    const beforeXp = (await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0]?.xp;
    clock.set(row.endsAtMs + 1);
    const unavailableRead = await get(session, started.id);
    expect(unavailableRead.statusCode).toBe(200);
    const unavailableDto = unavailableRead.json<DeploymentDto>();
    expect(unavailableDto).toMatchObject({ state: 'running', recoveryAvailable: true });
    expect(unavailableDto.segments).toHaveLength(0);
    expect(unavailableDto.outcome).toBeUndefined();
    expect(JSON.stringify(unavailableDto)).not.toMatch(/"(?:seed|budget|timelineCompressed|timelineHash|endsAtMs)"\s*:/);
    const historyWithUnavailable = await list(session, character.actorId);
    expect(historyWithUnavailable.statusCode).toBe(200);
    expect(historyWithUnavailable.json<DeploymentDto[]>()).toContainEqual(expect.objectContaining({ id: started.id, recoveryAvailable: true }));
    // The player can be offline past the planned end and still recover; this remains inside the 12-hour session TTL.
    clock.set(row.plannedEndsAtMs + 1);
    const recoveryCommandId = randomUUID();
    const workerPromise = createRpgServer({ ...configB, roles: ['worker'] }, { clock, settlementPolicies: deploymentPolicies() });
    const [worker, firstRecovery, duplicateRecovery, cancelAttempt] = await Promise.all([
      workerPromise, recover(session, started.id, recoveryCommandId), recover(session, started.id, recoveryCommandId), cancel(session, started.id),
    ]);
    try { await waitForQueueCompletion(`${started.id}:${row.revision}`); }
    finally { await worker.close(); }
    expect([firstRecovery.statusCode, duplicateRecovery.statusCode].sort()).toEqual([200, 200]);
    expect([firstRecovery.json(), duplicateRecovery.json()][0]).toEqual([firstRecovery.json(), duplicateRecovery.json()][1]);
    expect([200, 409, 503]).toContain(cancelAttempt.statusCode);

    const recovered = firstRecovery.json<DeploymentDto>();
    expect(recovered.terminalReport).toMatchObject({ version: 1, kind: 'escrow_returned', reason: 'version_unavailable', summary: null, xp: [], cutoff: null });
    expect(recovered.report).toMatchObject({ availability: 'returned_escrow', outcome: 'version_unavailable',
      effectiveDurationMs: null, enemiesDefeated: null,
      xp: { earned: null, penaltyLost: null, net: null }, gold: { earned: null, lost: null, secured: null },
      loot: null, events: null, finalState: { hp: null, maxHp: null, xpTotal: null } });
    const expectedRefund = (row.escrow as readonly { actorId: string; asset: { kind: string; item?: string }; qty: number; from: string; to: string }[])
      .map(delta => ({ ...delta, from: 'escrow', to: delta.from }));
    const returnedPotion = expectedRefund.filter(delta => delta.actorId === character.actorId && delta.asset.kind === 'stack' &&
      delta.asset.item === POTION && delta.to === 'inventory')
      .reduce((total, delta) => total + delta.qty, 0);
    expect(recovered.report?.consumables).toEqual([{ item: POTION, used: null, returned: returnedPotion }]);
    const report = await terminalReport(started.id);
    expect(report).toEqual(recovered.terminalReport);
    expect(report?.settledDeltas).toEqual(expectedRefund);
    const final = await persisted(started.id);
    expect(final.status).toBe('cancelled');
    expect(final.outcome).toBeNull();
    expect((await database.db.select().from(characters).where(eq(characters.actorId, character.actorId)))[0]?.xp).toBe(beforeXp);
    const holdings = await database.db.transaction(tx => getHoldings(tx, character.actorId));
    expect(holdings.filter(item => item.asset.kind === 'stack' && item.asset.item === POTION && item.container === 'inventory')
      .reduce((sum, item) => sum + item.qty, 0)).toBe(2);
    expect(holdings.some(item => item.container === `escrow:${started.id}`)).toBe(false);
    expect((await database.db.select().from(actors).where(eq(actors.actorId, character.actorId)))[0])
      .toMatchObject({ activityState: 'none', activityId: null });
    const recoverySourceId = `${started.id}:${row.revision}:version-recovery`;
    expect(await database.db.select().from(ledgerBatches).where(and(
      eq(ledgerBatches.sourceType, 'expedition_settlement'), eq(ledgerBatches.sourceId, recoverySourceId)))).toHaveLength(1);
    const recoveryEntries = await database.db.select().from(ledgerEntries).where(and(
      eq(ledgerEntries.sourceType, 'expedition_settlement'), eq(ledgerEntries.sourceId, recoverySourceId)));
    expect(recoveryEntries).toHaveLength(1);
    expect(recoveryEntries[0]).toMatchObject({ assetRef: POTION, qty: 1,
      fromContainer: `escrow:${started.id}`, toContainer: 'inventory' });
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId], []))).toEqual([]);
    const replay = await recover(session, started.id, recoveryCommandId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(recovered);
    expect(await database.db.select().from(ledgerBatches).where(and(
      eq(ledgerBatches.sourceType, 'expedition_settlement'), eq(ledgerBatches.sourceId, recoverySourceId)))).toHaveLength(1);
  }, 30_000);
});

/** Use the production snapshot helper so BASIC_ATTACK and future snapshot fields stay covered by this fixture. */
function findFatalSeed(bundle: unknown, character: CharacterDto): number {
  const content = rpgIdleContentFromBundle(bundle as never);
  const registry = createRpgActivityRegistry(content);
  const simulator = registry.get(HUNT);
  if (!simulator) throw new Error(`missing simulator ${HUNT}`);
  const snapshots = [snapshotRpgActor(character as never, [], bundle as never)];
  const evalContexts = [{ actor: createActorWorldState({ completedAreas: [REGION] }), game: { defeatedEnemies: new Set<string>(), level: character.level } }];
  const gate = checkStart({ world: (bundle as { world: unknown }).world as never,
    request: { areaId: REGION, activityId: HUNT, durationMin: 60, paceBp: 10_000 }, activities: registry,
    simulator, rawConfig: DEFAULT_CONFIG, actors: snapshots, evalContexts, predicates: createRpgPredicateRegistry() });
  if (!gate.ok) throw new Error(`fatal seed fixture failed start gate: ${gate.code}`);
  for (let seed = 1; seed <= 2_000; seed++) {
    const timeline = simulator.simulate({ config: gate.config, actors: snapshots, seed, budget: gate.budget, areaId: REGION, activityId: HUNT }) as Timeline<RpgIdleEvent, RpgIdleState>;
    if (timeline.outcome !== 'failed') continue;
    const progress = rpgProgress(timeline, timeline.segments.length - 1, 'completed');
    if (!progress.applyDeathPenalty || !progress.actors.some(actor => actor.actorId === character.actorId && actor.died && actor.xpEarned > 0)) continue;
    const raw = mergeDeltas(defaultSettle(timeline, timeline.segments.length - 1));
    const kept = applyBagLoss(raw, DEFAULT_RPG_IDLE_TUNING.deathBagLossBp);
    if (raw.filter(delta => delta.from === undefined).reduce((sum, delta) => sum + delta.qty, 0) >
      kept.filter(delta => delta.from === undefined).reduce((sum, delta) => sum + delta.qty, 0)) return seed;
  }
  throw new Error('no fatal simulator seed with both XP and bag rewards found');
}

/** A seed whose run ends without a death and earns more than 20 XP (so XP can cross a boundary without a penalty). */
function findSurvivingSeed(bundle: unknown, character: CharacterDto): number {
  const content = rpgIdleContentFromBundle(bundle as never);
  const registry = createRpgActivityRegistry(content);
  const simulator = registry.get(HUNT);
  if (!simulator) throw new Error(`missing simulator ${HUNT}`);
  const snapshots = [snapshotRpgActor(character as never, [], bundle as never)];
  const evalContexts = [{ actor: createActorWorldState({ completedAreas: [REGION] }), game: { defeatedEnemies: new Set<string>(), level: character.level } }];
  const gate = checkStart({ world: (bundle as { world: unknown }).world as never,
    request: { areaId: REGION, activityId: HUNT, durationMin: 60, paceBp: 10_000 }, activities: registry,
    simulator, rawConfig: DEFAULT_CONFIG, actors: snapshots, evalContexts, predicates: createRpgPredicateRegistry() });
  if (!gate.ok) throw new Error(`surviving seed fixture failed start gate: ${gate.code}`);
  for (let seed = 1; seed <= 200; seed++) {
    const timeline = simulator.simulate({ config: gate.config, actors: snapshots, seed, budget: gate.budget, areaId: REGION, activityId: HUNT }) as Timeline<RpgIdleEvent, RpgIdleState>;
    if (timeline.outcome === 'failed') continue;
    const progress = rpgProgress(timeline, timeline.segments.length - 1, 'completed');
    if ((progress.actors.find(actor => actor.actorId === character.actorId)?.xpEarned ?? 0) > 20) return seed;
  }
  throw new Error('no surviving simulator seed with XP found');
}

/** Picks a real simulator seed with a visible partial prefix before its natural early end. */
function findPartialCancelSeed(bundle: unknown, character: CharacterDto): number {
  const content = rpgIdleContentFromBundle(bundle as never);
  const registry = createRpgActivityRegistry(content);
  const simulator = registry.get(HUNT);
  if (!simulator) throw new Error(`missing simulator ${HUNT}`);
  const snapshots = [snapshotRpgActor(character as never, [], bundle as never)];
  const evalContexts = [{ actor: createActorWorldState({ completedAreas: [REGION] }), game: { defeatedEnemies: new Set<string>(), level: character.level } }];
  const gate = checkStart({ world: (bundle as { world: unknown }).world as never,
    request: { areaId: REGION, activityId: HUNT, durationMin: 60, paceBp: 10_000 }, activities: registry,
    simulator, rawConfig: { ...DEFAULT_CONFIG, consumables: [{ item: POTION, qty: 1 }] },
    actors: snapshots, evalContexts, predicates: createRpgPredicateRegistry() });
  if (!gate.ok) throw new Error(`partial cancellation fixture failed start gate: ${gate.code}`);
  for (let seed = 1; seed <= 2_000; seed++) {
    const timeline = simulator.simulate({ config: gate.config, actors: snapshots, seed, budget: gate.budget, areaId: REGION, activityId: HUNT }) as Timeline<RpgIdleEvent, RpgIdleState>;
    if (timeline.outcome !== 'failed') continue;
    const placed = placeSegments(timeline, START_AT, 60 * 60_000, gate.budget);
    const reveals = new Set(placed.segments.filter(segment => segment.revealAtMs > START_AT && segment.revealAtMs <= START_AT + 5 * 60_000)
      .map(segment => segment.revealAtMs));
    if (placed.endsAtMs > START_AT + 5 * 60_000 && reveals.size >= 2) return seed;
  }
  throw new Error('no deterministic seed with a partial prefix before natural end');
}
