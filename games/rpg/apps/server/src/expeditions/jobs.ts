import { PostgresJobs } from '@engine/server-kit';
import type { JobHandler, ServerModule } from '@engine/server-kit';
import { z } from 'zod';

import { createExpeditionService } from './service.ts';
import { supportedSettlementPolicies } from './policy.ts';
import type { SettlementPolicy } from './policy.ts';

const JobPayload = z.strictObject({ expeditionId: z.uuid().transform(id => id.toLowerCase()), revision: z.number().int().nonnegative() });
export const EXPEDITION_SETTLEMENT_JOB = 'rpg.expedition.settle';

/** RPG worker owns the content-aware handler; the durable job row itself is scheduled in the start transaction. */
export function createRpgJobsModule(extra: Readonly<Record<string, JobHandler>> = {},
  settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies): ServerModule {
  return {
    name: 'jobs', roles: ['worker'],
    async register(app, context) {
      const settlement: JobHandler = async (payload, { clock, database }) => {
        const parsed = JobPayload.parse(payload);
        await database.db.transaction(async tx => {
          await createExpeditionService(tx, clock, context.content, undefined, settlementPolicies).settleJob(parsed.expeditionId, parsed.revision);
        });
      };
      const jobs = new PostgresJobs({ database: context.database, clock: context.clock,
        handlers: { ...extra, [EXPEDITION_SETTLEMENT_JOB]: settlement },
        onError: error => app.log.error({ code: (error as Error & { code?: string }).code ?? 'JOB_QUEUE_ERROR' }, 'job queue failure') });
      app.addHook('onClose', async () => { await jobs.close(); });
      await jobs.start();
    },
  };
}
