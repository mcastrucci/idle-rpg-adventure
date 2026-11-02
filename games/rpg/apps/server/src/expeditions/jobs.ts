import { PostgresJobs } from '@engine/server-kit';
import type { JobHandler, ServerModule } from '@engine/server-kit';
import { z } from 'zod';

import { createExpeditionService } from './service.ts';
import { supportedSettlementPolicies } from './policy.ts';
import type { SettlementPolicy } from './policy.ts';
import { createLedgerAuditHandler, DEFAULT_LEDGER_AUDIT_INTERVAL_MS, RPG_LEDGER_AUDIT_JOB,
  scheduleInitialLedgerAudit } from '../ledger-maintenance.ts';

const JobPayload = z.strictObject({ expeditionId: z.uuid().transform(id => id.toLowerCase()), revision: z.number().int().nonnegative() });
export const EXPEDITION_SETTLEMENT_JOB = 'rpg.expedition.settle';

/** RPG worker owns the content-aware handler; the durable job row itself is scheduled in the start transaction. */
export function createRpgJobsModule(extra: Readonly<Record<string, JobHandler>> = {},
  settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies,
  ledgerAuditIntervalMs = configuredLedgerAuditInterval()): ServerModule {
  return {
    name: 'jobs', roles: ['worker'],
    async register(app, context) {
      const jobsRef: { current?: PostgresJobs } = {};
      const settlement: JobHandler = async (payload, { clock, database }) => {
        const parsed = JobPayload.parse(payload);
        await database.db.transaction(async tx => {
          await createExpeditionService(tx, clock, context.content, undefined, settlementPolicies).settleJob(parsed.expeditionId, parsed.revision);
        });
      };
      const audit: JobHandler = async (payload, jobContext) => {
        const jobs = jobsRef.current;
        if (!jobs) throw new Error('ledger audit worker is not initialized');
        return createLedgerAuditHandler({ database: context.database, clock: context.clock,
          jobs, logger: app.log, intervalMs: ledgerAuditIntervalMs })(payload, jobContext);
      };
      const jobs = new PostgresJobs({ database: context.database, clock: context.clock,
        handlers: { ...extra, [EXPEDITION_SETTLEMENT_JOB]: settlement,
          [RPG_LEDGER_AUDIT_JOB]: audit },
        onError: error => app.log.error({ code: (error as Error & { code?: string }).code ?? 'JOB_QUEUE_ERROR' }, 'job queue failure') });
      jobsRef.current = jobs;
      app.addHook('onClose', async () => { await jobs.close(); });
      await jobs.start();
      await scheduleInitialLedgerAudit(jobs, context.clock, ledgerAuditIntervalMs);
    },
  };
}

function configuredLedgerAuditInterval(): number {
  const raw = process.env['RPG_LEDGER_AUDIT_INTERVAL_MS'];
  if (raw === undefined) return DEFAULT_LEDGER_AUDIT_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) throw new Error('RPG_LEDGER_AUDIT_INTERVAL_MS must be a positive integer');
  return Number(raw);
}
