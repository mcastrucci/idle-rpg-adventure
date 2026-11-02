import { and, eq, isNull, lte } from 'drizzle-orm';

import type { Clock } from '../clock.ts';
import type { Database } from '../database.ts';
import type { ServerModule } from '../server.ts';

import { commandLog } from './schema.ts';

/** Compact at most one indexed batch; permanent keys prevent old retries from repeating a mutation. */
export async function cleanupExpiredCommands(database: Database, clock: Clock, batchSize = 100): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('invalid command cleanup batch size');
  const now = new Date(clock.nowMs());
  return database.db.transaction(async (tx) => {
    const rows = await tx.select({ accountId: commandLog.accountId, commandId: commandLog.commandId }).from(commandLog)
      .where(and(isNull(commandLog.tombstonedAt), lte(commandLog.expiresAt, now)))
      .orderBy(commandLog.expiresAt).limit(batchSize).for('update', { skipLocked: true });
    for (const row of rows) {
      await tx.update(commandLog).set({ responseStatus: null, responseBody: null, tombstonedAt: now })
        .where(and(eq(commandLog.accountId, row.accountId), eq(commandLog.commandId, row.commandId)));
    }
    return rows.length;
  });
}

/** Small worker maintenance loop, deliberately separate from the future durable job queue. */
export function createCommandMaintenanceModule(options: { readonly intervalMs?: number; readonly batchSize?: number } = {}): ServerModule {
  const intervalMs = options.intervalMs ?? 60_000;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 2_147_483_647) throw new RangeError('invalid command cleanup interval');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('invalid command cleanup batch size');
  return { name: 'commands', roles: ['worker'], async register(app, { database, clock }) {
    let running: Promise<void> | undefined;
    const tick = () => {
      running ??= cleanupExpiredCommands(database, clock, batchSize).then(() => undefined)
        .catch((error: unknown) => { app.log.error({ err: error }, 'command cleanup failed'); })
        .finally(() => { running = undefined; });
    };
    await cleanupExpiredCommands(database, clock, batchSize);
    const timer = setInterval(tick, intervalMs); timer.unref();
    app.addHook('onClose', async () => { clearInterval(timer); await running; });
  } };
}
