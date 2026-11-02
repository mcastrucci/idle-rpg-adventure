import { and, eq } from 'drizzle-orm';

import { actors, checkLedgerInvariants } from '@engine/server-kit';
import type { Database, JobHandler, PostgresJobs } from '@engine/server-kit';
import type { Clock } from '@engine/server-kit';

import { expeditions } from './expeditions/schema.ts';

export const RPG_LEDGER_AUDIT_JOB = 'rpg.ledger.audit';
export const DEFAULT_LEDGER_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface AuditPayload { readonly intervalMs: number; readonly window: number }
interface AuditLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * Build the recurring audit handler. Its full scan and the game-owned active-expedition query share one
 * read-only REPEATABLE READ snapshot, so a concurrent activity transition cannot look like orphan escrow.
 */
export function createLedgerAuditHandler(options: {
  readonly database: Database;
  readonly clock: Clock;
  readonly jobs: PostgresJobs;
  readonly logger: AuditLogger;
  readonly intervalMs?: number;
}): JobHandler {
  const intervalMs = options.intervalMs ?? DEFAULT_LEDGER_AUDIT_INTERVAL_MS;
  validateInterval(intervalMs);
  return async (payload) => {
    const parsed = parsePayload(payload);
    const now = options.clock.nowMs();
    const currentWindow = Math.floor(now / intervalMs);

    // A changed deployment interval starts a distinct schedule chain; retire the old wake-up into this interval.
    if (parsed.intervalMs !== intervalMs) {
      await scheduleWindow(options.jobs, currentWindow, intervalMs);
      return;
    }

    // A process may be down for many windows. Consume a stale wake-up without replaying an unbounded backlog.
    if (parsed.window < currentWindow) {
      await scheduleWindow(options.jobs, currentWindow, intervalMs);
      return;
    }

    // Persist the next interval before scanning. SQL or transient failures can exhaust retries without ending recurrence.
    const nextWindow = Math.max(parsed.window + 1, currentWindow + 1);
    await scheduleWindow(options.jobs, nextWindow, intervalMs);

    const issues = await options.database.db.transaction(async (tx) => {
      const active = await tx.select({ id: expeditions.id })
        .from(expeditions)
        .innerJoin(actors, and(eq(actors.actorId, expeditions.actorId),
          eq(actors.activityState, 'expedition'), eq(actors.activityId, expeditions.id)))
        .where(eq(expeditions.status, 'running'));
      return checkLedgerInvariants(tx, [], active.map(row => row.id));
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });

    if (issues.length) {
      options.logger.error({ code: 'LEDGER_INVARIANT_VIOLATION', issueCount: issues.length,
        issueCodes: [...new Set(issues.map(issueCode))].sort() }, 'ledger invariant audit found inconsistencies');
    } else {
      options.logger.info({ code: 'LEDGER_INVARIANT_AUDIT_OK' }, 'ledger invariant audit completed');
    }

  };
}

/** Idempotent bootstrap entry point; every process races on the same named window key. */
export async function scheduleInitialLedgerAudit(jobs: PostgresJobs, clock: Clock, intervalMs = DEFAULT_LEDGER_AUDIT_INTERVAL_MS): Promise<void> {
  validateInterval(intervalMs);
  const now = clock.nowMs();
  await scheduleWindow(jobs, Math.floor(now / intervalMs), intervalMs);
}

async function scheduleWindow(jobs: PostgresJobs, window: number, intervalMs: number): Promise<void> {
  await jobs.schedule({ name: RPG_LEDGER_AUDIT_JOB, singletonKey: `interval:${intervalMs}:window:${window}`,
    payload: { intervalMs, window } satisfies AuditPayload, dueAtMs: window * intervalMs });
}

function parsePayload(payload: Readonly<Record<string, unknown>>): AuditPayload {
  if (Object.keys(payload).length !== 2 || !Number.isSafeInteger(payload['intervalMs']) ||
      !Number.isSafeInteger(payload['window']) || (payload['intervalMs'] as number) < 1_000 ||
      (payload['window'] as number) < 0) {
    throw new Error('invalid ledger audit job payload');
  }
  return { intervalMs: payload['intervalMs'] as number, window: payload['window'] as number };
}

function issueCode(issue: string): string {
  switch (issue) {
    case 'balance mismatch': return 'BALANCE_MISMATCH';
    case 'ledger batch entry count mismatch': return 'BATCH_ENTRY_COUNT_MISMATCH';
    case 'unique ledger references an unminted instance': return 'UNMINTED_UNIQUE_REFERENCE';
    case 'unique ledger source container mismatch': return 'UNIQUE_SOURCE_CONTAINER_MISMATCH';
    case 'unique instance count differs from mint history': return 'UNIQUE_INSTANCE_COUNT_MISMATCH';
    case 'unique instance differs from mint and ownership history': return 'UNIQUE_HISTORY_MISMATCH';
    case 'unique instance has no mint ledger entry': return 'UNMINTED_UNIQUE_INSTANCE';
    case 'orphan expedition escrow': return 'ORPHAN_EXPEDITION_ESCROW';
    default: return 'UNKNOWN_INVARIANT';
  }
}

function validateInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 365 * 24 * 60 * 60 * 1000) {
    throw new RangeError('ledger audit interval must be between 1000ms and 365 days');
  }
}
