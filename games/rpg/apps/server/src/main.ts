import { installShutdownHandlers, parseServerConfig } from '@engine/server-kit';

import { createRpgServer, parseRpgDebugToolsConfig } from './index.ts';

// Entrypoint has no import-time lifecycle side effects in the library/composition modules.
try {
  const config = parseServerConfig(process.env);
  // RPG_DEBUG_TOOLS=1 requires APP_ENV in development/test/qa/staging; production configuration refuses to boot.
  const app = await createRpgServer(config, { debug: parseRpgDebugToolsConfig(process.env) });
  const remove = installShutdownHandlers(app, config.shutdownTimeoutMs);
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) { remove(); await app.close(); throw error; }
} catch {
  // Configuration/driver errors can contain credentials. Detailed request logs never include DATABASE_URL.
  process.stderr.write('Server startup failed; check configuration, compiled content and database availability.\n');
  process.exitCode = 1;
}
