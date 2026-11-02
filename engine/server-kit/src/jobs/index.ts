import { PgBoss } from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import type { Db as IDatabase, QueuePolicy } from 'pg-boss';
import type { PoolClient } from 'pg';

import type { Clock } from '../clock.ts';
import type { Database } from '../database.ts';
import { scheduledJobs } from '../schema.ts';
import type { ActorTransaction } from '../actors/service.ts';

export interface JobContext {
  readonly clock: Clock;
  readonly database: Database;
  readonly jobId: string;
  readonly singletonKey: string | null;
}

export type JobHandler = (payload: Readonly<Record<string, unknown>>, context: JobContext) => Promise<void>;

export interface ScheduledJob {
  readonly id: string;
  readonly name: string;
  readonly singletonKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dueAtMs: number;
}

/** Persist a named job in a caller's transaction, so domain state and its wake-up commit or roll back together. */
export async function scheduleJobInTransaction(tx: ActorTransaction, clock: Clock,
  job: Omit<ScheduledJob, 'id'>): Promise<string> {
  requireName(job.name, 'job name');
  requireName(job.singletonKey, 'singleton key');
  if (!Number.isSafeInteger(job.dueAtMs) || job.dueAtMs < 0) throw new RangeError('job due time must be a non-negative safe integer');
  const payload = JSON.parse(serializePayload(job.payload)) as Record<string, unknown>;
  const [inserted] = await tx.insert(scheduledJobs).values({ ...job, payload,
    createdAt: new Date(clock.nowMs()) }).onConflictDoNothing().returning({ id: scheduledJobs.id });
  if (inserted) return inserted.id;
  const [existing] = await tx.select().from(scheduledJobs).where(and(eq(scheduledJobs.name, job.name),
    eq(scheduledJobs.singletonKey, job.singletonKey))).for('update');
  if (!existing) throw new Error('scheduled job conflict disappeared');
  if (existing.dueAtMs !== job.dueAtMs || stableJson(existing.payload) !== stableJson(payload)) {
    throw new Error('singleton schedule already exists with different due time or payload');
  }
  return existing.id;
}

export interface JobsOptions {
  readonly database: Database;
  readonly clock: Clock;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly pollIntervalMs?: number;
  readonly concurrency?: number;
  readonly onError?: (error: Error) => void;
}

const QUEUE_POLICY: QueuePolicy = 'short';
const RETRY = { retryLimit: 8, retryDelay: 1, retryBackoff: true, retryDelayMax: 300 } as const;

/**
 * PostgreSQL-backed scheduled jobs. pg-boss owns execution, retries, and queue locking. The
 * small scheduled_jobs table maps application-clock deadlines to immediately runnable pg-boss
 * work. Promotion and pg-boss insertion share a transaction, so a process crash cannot lose or
 * double-promote a due schedule.
 */
export class PostgresJobs {
  readonly #database: Database;
  readonly #clock: Clock;
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  readonly #pollIntervalMs: number;
  readonly #concurrency: number;
  readonly #onError: (error: Error) => void;
  readonly #boss: PgBoss;
  #timer: NodeJS.Timeout | undefined;
  #dispatching: Promise<number> | undefined;
  #starting: Promise<void> | undefined;
  #started = false;
  #bossStarted = false;
  #bossAttempted = false;
  #closing: Promise<void> | undefined;

  constructor(options: JobsOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#handlers = options.handlers;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#concurrency = options.concurrency ?? 4;
    this.#onError = options.onError ?? (() => {});
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 10) throw new RangeError('job poll interval must be at least 10ms');
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) throw new RangeError('job concurrency must be positive');
    this.#boss = new PgBoss({ connectionString: options.database.pool.options.connectionString as string,
      max: Math.max(2, options.database.pool.options.max ?? 10), schema: 'pgboss',
      application_name: 'rpg-jobs', supervise: true });
    this.#boss.on('error', (error: Error) => { this.#onError(error); });
  }

  /** Starts the persistent queue and optionally its in-process handlers. */
  async start(options: { readonly workers?: boolean } = {}): Promise<void> {
    if (this.#closing) throw new Error('jobs service is closing or closed');
    if (this.#started) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start(options);
    try { await this.#starting; }
    finally { this.#starting = undefined; }
  }

  async #start(options: { readonly workers?: boolean }): Promise<void> {
    try {
      this.#bossAttempted = true;
      await this.#boss.start();
      this.#bossStarted = true;
      for (const name of Object.keys(this.#handlers)) {
        requireName(name, 'job name');
        await this.#boss.createQueue(name, { policy: QUEUE_POLICY, ...RETRY, deleteAfterSeconds: 604800 });
      }
      if (options.workers ?? true) {
        for (const [name, handler] of Object.entries(this.#handlers)) {
          await this.#boss.work(name, { localConcurrency: this.#concurrency, includeMetadata: true, batchSize: 1, pollingIntervalSeconds: 0.5 },
            async (jobs) => {
              for (const job of jobs) {
                await handler(asPayload(job.data), { clock: this.#clock, database: this.#database, jobId: job.id,
                  singletonKey: job.singletonKey ?? null });
              }
            });
        }
      }
      this.#started = true;
      await this.dispatchDue();
      this.#timer = setInterval(() => {
        void this.dispatchDue().catch((error: unknown) => { this.#onError(asError(error)); });
      }, this.#pollIntervalMs);
      this.#timer.unref();
    } catch (error) {
      this.#started = false;
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
      try { if (this.#bossAttempted) await this.#boss.stop({ graceful: true, timeout: 10_000 }); }
      catch (stopError) { throw new AggregateError([error, stopError], 'jobs startup and cleanup failed', { cause: stopError }); }
      finally { this.#bossStarted = false; this.#bossAttempted = false; }
      throw error;
    }
  }

  /** Idempotently persists a one-off schedule. A (name, singletonKey) remains reserved permanently. */
  async schedule(job: Omit<ScheduledJob, 'id'>): Promise<string> {
    requireName(job.name, 'job name');
    if (!Object.hasOwn(this.#handlers, job.name)) throw new Error(`unknown job name: ${job.name}`);
    requireName(job.singletonKey, 'singleton key');
    if (!Number.isSafeInteger(job.dueAtMs) || job.dueAtMs < 0) throw new RangeError('job due time must be a non-negative safe integer');
    const payload = serializePayload(job.payload);
    const result = await this.#database.pool.query<{ id: string }>(
      `INSERT INTO scheduled_jobs (name, singleton_key, payload, due_at_ms, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (name, singleton_key) DO NOTHING RETURNING id`,
      [job.name, job.singletonKey, payload, job.dueAtMs, new Date(this.#clock.nowMs())]);
    if (result.rows[0]) return result.rows[0].id;
    const existing = await this.#database.pool.query<{ id: string; payload: Record<string, unknown>; due_at_ms: string }>(
      'SELECT id, payload, due_at_ms FROM scheduled_jobs WHERE name=$1 AND singleton_key=$2', [job.name, job.singletonKey]);
    const existingRow = existing.rows[0];
    if (!existingRow) throw new Error('scheduled job conflict disappeared');
    if (Number(existingRow.due_at_ms) !== job.dueAtMs || stableJson(existingRow.payload) !== stableJson(JSON.parse(payload))) {
      throw new Error('singleton schedule already exists with different due time or payload');
    }
    return existingRow.id;
  }

  /**
   * Promotes currently due schedules according to the injected app clock. This method is public
   * for deterministic time-travel tests; it does not change PostgreSQL NOW().
   */
  async dispatchDue(limit = 100): Promise<number> {
    if (!this.#started) throw new Error('jobs service is not started');
    if (this.#dispatching) return this.#dispatching;
    this.#dispatching = this.#promoteDue(limit);
    try { return await this.#dispatching; }
    finally { this.#dispatching = undefined; }
  }

  async close(options: { readonly timeout?: number } = {}): Promise<void> {
    this.#closing ??= this.#stop(options);
    return this.#closing;
  }

  async #stop(options: { readonly timeout?: number }): Promise<void> {
    let dispatchError: unknown;
    let stopError: unknown;
    try { if (this.#starting) await this.#starting; }
    catch (error) { dispatchError = error; }
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    try { if (this.#dispatching) await this.#dispatching; }
    catch (error) { dispatchError = error; }
    try { if (this.#bossStarted) await this.#boss.stop({ graceful: true, timeout: options.timeout ?? 10_000 }); }
    catch (error) { stopError = error; }
    this.#started = false;
    this.#bossStarted = false;
    this.#bossAttempted = false;
    if (dispatchError && stopError) throw new AggregateError([dispatchError, stopError], 'jobs dispatch and worker shutdown failed');
    if (stopError) throw stopError;
    if (dispatchError) throw dispatchError;
  }

  async #promoteDue(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('dispatch limit must be in [1, 1000]');
    const names = Object.keys(this.#handlers);
    if (names.length === 0) return 0;
    const client = await this.#database.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{ id: string; name: string; singleton_key: string; payload: Record<string, unknown> }>(
        `SELECT id, name, singleton_key, payload FROM scheduled_jobs
         WHERE promoted_at IS NULL AND due_at_ms <= $1 AND name = ANY($2::text[])
         ORDER BY due_at_ms, id LIMIT $3 FOR UPDATE SKIP LOCKED`, [this.#clock.nowMs(), names, limit]);
      const txDatabase = postgresTransactionAdapter(client);
      for (const row of due.rows) {
        const jobId = await this.#boss.send(row.name, row.payload, { singletonKey: row.singleton_key, ...RETRY, db: txDatabase });
        if (!jobId) throw new Error('pg-boss did not persist the scheduled job');
        await client.query('UPDATE scheduled_jobs SET promoted_at=$2 WHERE id=$1', [row.id, new Date(this.#clock.nowMs())]);
      }
      await client.query('COMMIT');
      return due.rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}

function postgresTransactionAdapter(client: PoolClient): IDatabase {
  return { async executeSql(text: string, values?: unknown[]) {
    const result = await client.query(text, values);
    return { rows: result.rows };
  } };
}

function requireName(value: string, label: string): void {
  if (!value || value.length > 250 || value.includes('\0')) throw new Error(`${label} must be non-empty and at most 250 characters`);
}

function asPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('job payload must be an object');
  return value as Readonly<Record<string, unknown>>;
}

function serializePayload(value: Readonly<Record<string, unknown>>): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('job payload must be a plain JSON object');
  }
  const seen = new Set<object>();
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('job payload must contain only finite JSON numbers');
      return;
    }
    if (typeof item !== 'object') throw new TypeError('job payload must contain only JSON values');
    if (seen.has(item)) throw new TypeError('job payload must not contain cycles');
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) validate(child);
    } else if (Object.getPrototypeOf(item) === Object.prototype) {
      for (const child of Object.values(item)) validate(child);
    } else {
      throw new TypeError('job payload must contain only plain JSON objects');
    }
    seen.delete(item);
  };
  validate(value);
  return JSON.stringify(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error('job queue operation failed'); }

export const JOBS_QUEUE_POLICY = QUEUE_POLICY;
