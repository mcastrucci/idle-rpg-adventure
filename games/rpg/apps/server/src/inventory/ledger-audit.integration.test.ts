import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { applyLedgerDeltas, assetBalances, checkLedgerInvariants, createDatabase, ManualClock, parseServerConfig,
  PostgresJobs, scheduledJobs } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createLedgerAuditHandler } from '../ledger-maintenance.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL ledger audit worker tests');
const token = () => randomBytes(32).toString('base64url');
const AUDIT = 'rpg.ledger.audit';
const INTERVAL_MS = 1_000;
const START_AT = 1_800_000_000_000;

interface Session { accountId: string; sessionToken: string }
interface Character { actorId: string }

describe.skipIf(!adminUrl)('PostgreSQL ledger invariant audit worker', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let api: Awaited<ReturnType<typeof createRpgServer>>;
  let worker: Awaited<ReturnType<typeof createRpgServer>> | undefined;
  let secondWorker: Awaited<ReturnType<typeof createRpgServer>> | undefined;
  let apiClosed = false;
  let directory: string;
  const databaseName = `ledger_audit_test_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(START_AT);
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ledger-audit-integration-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(compiled.bundle));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString(), roles: ['api'] };
    database = createRpgDatabase(config);
    await database.migrate();
  }, 30_000);

  afterAll(async () => {
    await secondWorker?.close();
    await worker?.close();
    if (!apiClosed) await api?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function eventually(predicate: () => Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error(`timed out waiting for ${message}`);
  }

  it('detects corruption, scans atomically during concurrent ledger writes, and continues scheduling future windows', async () => {
    api = await createRpgServer(config, { clock });
    const createdSession = await api.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: token() } });
    expect(createdSession.statusCode).toBe(200);
    const session = createdSession.json<Session>();
    const createdCharacter = await api.inject({ method: 'POST', url: '/characters', headers: {
      authorization: `Bearer ${session.sessionToken}`,
    }, payload: { command_id: randomUUID(), operation: 'character.create', payload: { name: 'Audit fixture' } } });
    expect(createdCharacter.statusCode).toBe(201);
    const character = createdCharacter.json<Character>();
    const grantId = `${character.actorId}:audit-fixture`;
    await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: grantId }, [
      { actorId: character.actorId, asset: { kind: 'currency', currency: 'gold' }, qty: 5 },
    ]));
    await database.pool.query(`UPDATE asset_balances SET qty = 6 WHERE actor_id = $1 AND asset_kind = 'currency' AND asset_ref = 'gold'`, [character.actorId]);
    await api.close();
    apiClosed = true;

    const workerConfig = { ...config, roles: ['worker'] as const };
    async function bootWorker(intervalMs: number, errorLog: unknown[][], infoLog: unknown[][]) {
      const previousInterval = process.env['RPG_LEDGER_AUDIT_INTERVAL_MS'];
      process.env['RPG_LEDGER_AUDIT_INTERVAL_MS'] = String(intervalMs);
      let instance: Awaited<ReturnType<typeof createRpgServer>>;
      try { instance = await createRpgServer(workerConfig, { clock }); }
      finally {
        if (previousInterval === undefined) delete process.env['RPG_LEDGER_AUDIT_INTERVAL_MS'];
        else process.env['RPG_LEDGER_AUDIT_INTERVAL_MS'] = previousInterval;
      }
      const log = instance.log as unknown as { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
      log.error = (...args) => { errorLog.push(args); };
      log.info = (...args) => { infoLog.push(args); };
      return instance;
    }
    const secondErrors: unknown[][] = [];
    const secondInfos: unknown[][] = [];
    worker = await bootWorker(INTERVAL_MS, errors, infos);
    const window = Math.floor(START_AT / INTERVAL_MS);
    const scheduled = (n: number) => database.db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.name, AUDIT), eq(scheduledJobs.singletonKey, `interval:${INTERVAL_MS}:window:${n}`)));
    const loggedCodes = (rows: unknown[][]) => rows.map(args => args[0]).filter((fields): fields is Record<string, unknown> =>
      typeof fields === 'object' && fields !== null);
    await eventually(async () => loggedCodes(errors).some(fields => fields['code'] === 'LEDGER_INVARIANT_VIOLATION'), 'first audit corruption report');
    expect(loggedCodes(errors)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LEDGER_INVARIANT_VIOLATION', issueCount: 1, issueCodes: ['BALANCE_MISMATCH'] }),
    ]));
    await eventually(async () => (await scheduled(window + 1)).length === 1, 'first future durable window');
    expect(await database.db.select().from(assetBalances).where(eq(assetBalances.actorId, character.actorId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ assetRef: 'gold', qty: 6 })]));

    // Repair only the deliberate fixture corruption. Every subsequent change uses the real ledger transaction.
    await database.pool.query(`UPDATE asset_balances SET qty = 5 WHERE actor_id = $1 AND asset_kind = 'currency' AND asset_ref = 'gold'`, [character.actorId]);
    // A second process races on the same durable singleton schedule; PostgreSQL should promote and execute one job.
    secondWorker = await bootWorker(INTERVAL_MS, secondErrors, secondInfos);
    expect(await scheduled(window)).toHaveLength(1);
    let releaseWriter: (() => void) | undefined;
    let signalWriterReady: (() => void) | undefined;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writerReady = new Promise<void>(resolve => { signalWriterReady = resolve; });
    const writer = database.db.transaction(async tx => {
      await applyLedgerDeltas(tx, { type: 'test_fixture', id: `${character.actorId}:overlap-audit-write` }, [
        { actorId: character.actorId, asset: { kind: 'currency', currency: 'gold' }, qty: 1 },
      ]);
      signalWriterReady?.();
      await writerGate;
    });
    await writerReady;
    clock.set((window + 1) * INTERVAL_MS);
    let scanFailure: unknown;
    try {
      await eventually(async () => [...infos, ...secondInfos].some(args => loggedCodes([args])
        .some(fields => fields['code'] === 'LEDGER_INVARIANT_AUDIT_OK')), 'consistent scan during an uncommitted writer');
    } catch (error) { scanFailure = error; }
    finally { releaseWriter?.(); }
    await writer;
    if (scanFailure !== undefined) throw scanFailure;
    await eventually(async () => (await scheduled(window + 2)).length === 1, 'second future durable window');
    expect(loggedCodes(errors)).toHaveLength(1);
    expect([...loggedCodes(infos), ...loggedCodes(secondInfos)]).toEqual([
      expect.objectContaining({ code: 'LEDGER_INVARIANT_AUDIT_OK' }),
    ]);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [character.actorId]))).toEqual([]);

    await worker.close(); worker = undefined;
    await secondWorker.close(); secondWorker = undefined;
    // A restarted deployment with a changed interval begins a distinct idempotent schedule chain.
    const changedInterval = 2_000;
    const changedErrors: unknown[][] = [];
    const changedInfos: unknown[][] = [];
    worker = await bootWorker(changedInterval, changedErrors, changedInfos);
    const changedWindow = Math.floor(clock.nowMs() / changedInterval);
    const changedSchedule = (n: number) => database.db.select().from(scheduledJobs).where(and(
      eq(scheduledJobs.name, AUDIT), eq(scheduledJobs.singletonKey, `interval:${changedInterval}:window:${n}`)));
    await eventually(async () => loggedCodes(changedInfos).some(fields => fields['code'] === 'LEDGER_INVARIANT_AUDIT_OK'), 'changed-interval audit result after restart');
    await eventually(async () => (await changedSchedule(changedWindow + 1)).length === 1, 'restarted worker with changed interval');
    expect(loggedCodes(changedInfos)).toContainEqual(expect.objectContaining({ code: 'LEDGER_INVARIANT_AUDIT_OK' }));
    await worker.close(); worker = undefined;
  }, 30_000);

  it('persists recurrence before propagating an SQL scan failure for worker retry', async () => {
    const intervalMs = 7_000;
    const handlerJobs = new PostgresJobs({ database, clock, handlers: { [AUDIT]: async () => {} }, pollIntervalMs: 10_000 });
    const errorsLog: unknown[][] = [];
    const logger = { info: () => {}, error: (...args: unknown[]) => { errorsLog.push(args); } };
    const handler = createLedgerAuditHandler({ database, clock, jobs: handlerJobs, logger, intervalMs });
    const window = Math.floor(clock.nowMs() / intervalMs);
    const key = `interval:${intervalMs}:window:${window + 1}`;
    try {
      await database.pool.query('ALTER TABLE ledger_entries RENAME TO ledger_entries_audit_failure_fixture');
      await expect(handler({ intervalMs, window }, { clock, database, jobId: randomUUID(), singletonKey: `interval:${intervalMs}:window:${window}` }))
        .rejects.toThrow();
      expect(await database.db.select().from(scheduledJobs).where(and(
        eq(scheduledJobs.name, AUDIT), eq(scheduledJobs.singletonKey, key)))).toHaveLength(1);
    } finally {
      await database.pool.query('ALTER TABLE ledger_entries_audit_failure_fixture RENAME TO ledger_entries');
      await handlerJobs.close();
    }
    expect(errorsLog).toHaveLength(0);
  });
});
