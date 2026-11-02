import type { FastifyInstance } from 'fastify';

import type { ServerModule } from '../server.ts';
import { PostgresJobs } from './index.ts';
import type { JobHandler, JobsOptions } from './index.ts';

/** Worker-only server module; shutdown drains pg-boss before createServer closes its pool. */
export function createJobsModule(handlers: Readonly<Record<string, JobHandler>>, options: Omit<Partial<JobsOptions>, 'database' | 'clock' | 'handlers'> = {}): ServerModule {
  return {
    name: 'jobs', roles: ['worker'],
    async register(app: FastifyInstance, context) {
      const jobs = new PostgresJobs({ database: context.database, clock: context.clock, handlers, ...options,
        onError: options.onError ?? ((error) => {
          const safeError = error as Error & { code?: string };
          app.log.error({ code: safeError.code ?? 'JOB_QUEUE_ERROR' }, 'job queue failure');
        }) });
      app.addHook('onClose', async () => { await jobs.close(); });
      await jobs.start();
    },
  };
}
