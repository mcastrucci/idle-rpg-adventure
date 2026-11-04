import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ManualClock } from '../clock.ts';
import { createDatabase } from '../database.ts';
import type { Database } from '../database.ts';
import { PostgresJobs } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for real PostgreSQL job tests');

describe.skipIf(!adminUrl)('PostgreSQL jobs against real PostgreSQL', () => {
  const databaseName = `jobs_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    const base = { databaseUrl: adminUrl as string, poolMax: 10, databaseTimeoutMs: 5000 };
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...base, databaseUrl: url.toString() });
    await database.migrate();
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  }, 30000);

  it('persists a future schedule across stop/recreate and runs it only when the injected clock reaches T', async () => {
    const clock = new ManualClock(1000);
    let calls = 0;
    const handlers = { settle: async () => { calls += 1; } };
    const producer = new PostgresJobs({ database, clock, handlers, pollIntervalMs: 50 });
    const id = await producer.schedule({ name: 'settle', singletonKey: 'settle:expedition-1:4', payload: { expeditionId: 'expedition-1' }, dueAtMs: 2000 });
    await producer.start({ workers: false });
    await producer.close();
    expect(calls).toBe(0);

    const restarted = new PostgresJobs({ database, clock, handlers, pollIntervalMs: 50 });
    await restarted.start();
    try {
      await restarted.dispatchDue();
      await delay(100);
      expect(calls).toBe(0);
      clock.set(2000);
      await restarted.dispatchDue();
      await until(() => calls === 1);
      await restarted.dispatchDue();
      await delay(100);
      expect(calls).toBe(1);
      const row = await database.pool.query<{ id: string; promoted_at: Date }>(
        'SELECT id,promoted_at FROM scheduled_jobs WHERE id=$1', [id]);
      expect(row.rows[0]?.promoted_at).toBeInstanceOf(Date);
    } finally { await restarted.close(); }
  }, 30000);

  it('deduplicates repeated singleton schedules and retries a failed handler with backoff', async () => {
    const clock = new ManualClock(10_000);
    let attempts = 0;
    let succeeded = 0;
    const jobs = new PostgresJobs({ database, clock, pollIntervalMs: 50, handlers: {
      retryable: async () => { attempts += 1; if (attempts === 1) throw new Error('transient failure'); succeeded += 1; },
    } });
    const spec = { name: 'retryable', singletonKey: 'retry:entity-1:9', payload: { entityId: 'entity-1' }, dueAtMs: clock.nowMs() };
    try {
      const first = await jobs.schedule(spec);
      const duplicate = await jobs.schedule(spec);
      expect(duplicate).toBe(first);
      await expect(jobs.schedule({ ...spec, payload: { entityId: 'different' } })).rejects.toThrow('different due time or payload');
      await expect(jobs.schedule({ ...spec, dueAtMs: spec.dueAtMs + 1 })).rejects.toThrow('different due time or payload');
      const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
      await expect(jobs.schedule({ ...spec, singletonKey: 'retry:cycle', payload: cyclic })).rejects.toThrow('cycles');
      await expect(jobs.schedule({ ...spec, singletonKey: 'retry:array', payload: [] as unknown as Record<string, unknown> })).rejects.toThrow('plain JSON object');
      await expect(jobs.schedule({ ...spec, singletonKey: 'retry:undefined', payload: { bad: undefined } })).rejects.toThrow('JSON values');
      await expect(jobs.schedule({ ...spec, name: 'unregistered' })).rejects.toThrow('unknown job name');
      const count = await database.pool.query<{ count: string }>(
        'SELECT count(*) FROM scheduled_jobs WHERE name=$1 AND singleton_key=$2', [spec.name, spec.singletonKey]);
      expect(Number(count.rows[0]?.count)).toBe(1);
      await jobs.start();
      await jobs.dispatchDue();
      await until(() => succeeded === 1, 15000);
      expect(attempts).toBe(2);
      expect(succeeded).toBe(1);
    } finally { await jobs.close(); }
  }, 30000);

  it('cleans up a failed initial dispatch and shares concurrent starts and closes', async () => {
    const clock = { nowMs: () => { if (failClock) throw new Error('clock failure'); return 1_000; } };
    let failClock = true;
    const jobs = new PostgresJobs({ database, clock, handlers: { lifecycle: async () => {} }, pollIntervalMs: 50 });
    await expect(jobs.start()).rejects.toThrow('clock failure');
    failClock = false;
    await Promise.all([jobs.start(), jobs.start()]);
    await Promise.all([jobs.close(), jobs.close()]);
    await expect(jobs.start()).rejects.toThrow('closing or closed');
  }, 30000);

  it('coordinates two worker processes so one singleton job has one successful handler completion', async () => {
    const clock = new ManualClock(20_000);
    let active = 0;
    let maxActive = 0;
    let completions = 0;
    const handler = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(100);
      completions += 1;
      active -= 1;
    };
    const handlers = { concurrent: handler };
    const workerA = new PostgresJobs({ database, clock, handlers, pollIntervalMs: 50, concurrency: 2 });
    const workerB = new PostgresJobs({ database, clock, handlers, pollIntervalMs: 50, concurrency: 2 });
    try {
      await Promise.all([workerA.start(), workerB.start()]);
      const spec = { name: 'concurrent', singletonKey: 'concurrent:actor-1:3', payload: { actorId: 'actor-1' }, dueAtMs: clock.nowMs() };
      await Promise.all([workerA.schedule(spec), workerB.schedule(spec)]);
      await Promise.all([workerA.dispatchDue(), workerB.dispatchDue()]);
      await until(() => completions === 1);
      await delay(700);
      expect(maxActive).toBe(1);
      expect(completions).toBe(1);
      const completed = await database.pool.query<{ count: string }>(
        "SELECT count(*) FROM pgboss.job WHERE name=$1 AND singleton_key=$2 AND state='completed'",
        [spec.name, spec.singletonKey]);
      expect(Number(completed.rows[0]?.count)).toBe(1);
    } finally { await Promise.all([workerA.close(), workerB.close()]); }
  }, 30000);

  it('applies the configured local concurrency to handlers', async () => {
    const clock = new ManualClock(25_000);
    let active = 0;
    let maxActive = 0;
    let completions = 0;
    const jobs = new PostgresJobs({ database, clock, concurrency: 2, pollIntervalMs: 50, handlers: {
      parallel: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Hold each handler until a second one runs alongside it (bounded), so the assertion does not depend on how
        // quickly a slow runner fetches the queued jobs. A worker capped at 1 never overlaps and leaves maxActive at 1.
        await until(() => maxActive >= 2, 5000).catch(() => undefined);
        await delay(50);
        completions += 1;
        active -= 1;
      },
    } });
    try {
      await jobs.start();
      await Promise.all([1, 2, 3].map((id) => jobs.schedule({ name: 'parallel', singletonKey: `parallel:${id}`,
        payload: { id }, dueAtMs: clock.nowMs() })));
      await jobs.dispatchDue();
      await until(() => completions === 3);
      expect(maxActive).toBe(2);
    } finally { await jobs.close(); }
  }, 30000);

  it('promotes only schedules for queues registered by the local worker', async () => {
    const clock = new ManualClock(27_000);
    const workerA = new PostgresJobs({ database, clock, handlers: { queue_a: async () => {} } });
    const workerB = new PostgresJobs({ database, clock, handlers: { queue_b: async () => {} } });
    const keyB = `queue-b:${randomUUID()}`;
    try {
      const idB = await workerB.schedule({ name: 'queue_b', singletonKey: keyB, payload: {}, dueAtMs: clock.nowMs() });
      await workerA.start();
      await workerA.dispatchDue();
      const untouched = await database.pool.query<{ promoted_at: Date | null }>(
        'SELECT promoted_at FROM scheduled_jobs WHERE id=$1', [idB]);
      expect(untouched.rows[0]?.promoted_at).toBeNull();
      await workerB.start();
      await workerB.dispatchDue();
      const promoted = await database.pool.query<{ promoted_at: Date | null }>(
        'SELECT promoted_at FROM scheduled_jobs WHERE id=$1', [idB]);
      expect(promoted.rows[0]?.promoted_at).toBeInstanceOf(Date);
    } finally { await Promise.all([workerA.close(), workerB.close()]); }
  }, 30000);

  it('drains an active handler before the worker client stops', async () => {
    const clock = new ManualClock(30_000);
    let release!: () => void;
    let finished = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = new PostgresJobs({ database, clock, pollIntervalMs: 50, handlers: {
      drain: async () => { await gate; finished = true; },
    } });
    await jobs.start();
    try {
      await jobs.schedule({ name: 'drain', singletonKey: 'drain:1', payload: {}, dueAtMs: clock.nowMs() });
      await jobs.dispatchDue();
      await until(async () => (await database.pool.query<{ count: string }>(
        "SELECT count(*) FROM pgboss.job WHERE name='drain' AND state='active'")).rows[0]?.count === '1');
      let closed = false;
      const closing = jobs.close().then(() => { closed = true; });
      await delay(100);
      expect(closed).toBe(false);
      release();
      await closing;
      expect(finished).toBe(true);
    } finally { release(); await jobs.close(); }
  }, 30000);
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await delay(25);
  }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
