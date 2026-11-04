import { installShutdownHandlers, parseServerConfig } from '@engine/server-kit';
import type { ServerConfig } from '@engine/server-kit';

import { createRpgServer, parseRpgDebugToolsConfig } from './index.ts';
import type { RpgDebugToolsConfig } from './index.ts';

// Entrypoint has no import-time lifecycle side effects in the library/composition modules.
let config: ServerConfig;
let debug: RpgDebugToolsConfig;
try {
  config = parseServerConfig(process.env);
  // RPG_DEBUG_TOOLS=1 requires APP_ENV in development/test/qa/staging; production configuration refuses to boot.
  debug = parseRpgDebugToolsConfig(process.env);
} catch (error) {
  // Configuration messages name variables and rules only (never values), so they are safe and make a bad
  // TRUST_PROXY / ALLOWED_ORIGINS / WEB_DIST_DIR / RPG_DEBUG_TOOLS setting diagnosable from `docker compose logs`.
  process.stderr.write(`Invalid server configuration: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
}
try {
  const app = await createRpgServer(config, { debug });
  const remove = installShutdownHandlers(app, config.shutdownTimeoutMs);
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) { remove(); await app.close(); throw error; }
} catch {
  // Driver errors can contain credentials. Detailed request logs never include DATABASE_URL.
  process.stderr.write('Server startup failed; check configuration, compiled content and database availability.\n');
  process.exitCode = 1;
}
