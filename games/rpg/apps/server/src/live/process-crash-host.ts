/** Child-process entrypoint for process-crash.integration.test.ts. It deliberately has no shutdown IPC. */
import { ManualClock, parseServerConfig } from '@engine/server-kit';
import { createRpgServer } from '../index.ts';
import { createRpgLiveHost } from './index.ts';

const config = parseServerConfig({ DATABASE_URL: process.env['DATABASE_URL'], CONTENT_BUNDLE_PATH: process.env['CONTENT_BUNDLE_PATH'],
  LOG_LEVEL: 'silent', ROLES: 'api,live' });
const clock = new ManualClock(Number(process.env['CLOCK_START'] ?? 1_800_000_000_000));
const live = createRpgLiveHost({ autoStart: false, nodeId: process.env['NODE_ID'] ?? 'process-crash-child', leaseMs: 30_000, graceMs: 60_000 });
const app = await createRpgServer(config, { clock, live, seedSource: () => 7 });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ type: 'ready', address });

let operation = Promise.resolve();
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const requestId = 'requestId' in message ? message.requestId : undefined;
  operation = operation.then(async () => {
    try {
      if (message.type === 'advance' && 'ms' in message && typeof message.ms === 'number') {
        for (let elapsed = 0; elapsed < message.ms; elapsed += 250) {
          clock.advance(Math.min(250, message.ms - elapsed));
          await live.host().pump();
        }
        process.send?.({ type: 'result', requestId, value: 'advanced' });
      } else if (message.type === 'recoverExpired') {
        process.send?.({ type: 'result', requestId, value: await live.host().recoverExpired() });
      } else if (message.type === 'recover' && 'instanceId' in message && typeof message.instanceId === 'string') {
        process.send?.({ type: 'result', requestId, value: await live.host().recover(message.instanceId) });
      } else throw new Error('unsupported process fixture operation');
    } catch (error) {
      process.send?.({ type: 'error', requestId, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
