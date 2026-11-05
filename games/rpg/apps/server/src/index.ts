import { createAuthModule, createCommandMaintenanceModule, createServer } from '@engine/server-kit';
import type { Clock, JobHandler, ServerConfig, ServerModule } from '@engine/server-kit';

import { validateRpgBundle } from './content.ts';
import { RPG_MIGRATIONS } from './migrations.ts';
import { characterModule } from './characters/http.ts';
import { executeCharacterSocketCommand } from './character-commands.ts';
import { createRpgLiveHost } from './live/index.ts';
import type { RpgLiveHost } from './live/index.ts';
import { createLiveEntryModule } from './live/entry-http.ts';
import { handleRpgLiveSocketCommand } from './live/protocol.ts';
import { createExpeditionModule } from './expeditions/http.ts';
import { createRpgJobsModule } from './expeditions/jobs.ts';
import { supportedSettlementPolicies } from './expeditions/policy.ts';
import type { SettlementPolicy } from './expeditions/policy.ts';
import type { EstimateServiceOptions } from './expeditions/estimates.ts';
import { createRpgDebugTools } from './debug/index.ts';
import type { RpgDebugToolsConfig } from './debug/index.ts';
import { createWorldModule } from './world/http.ts';
import { persistRpgConnectionLifecycle } from './telemetry/sessions.ts';

export { createRpgDatabase, RPG_MIGRATIONS } from './migrations.ts';
export * from './live/index.ts';
export { DebugToolsRefusedError, parseRpgDebugToolsConfig } from './debug/index.ts';
export type { RpgDebugToolsConfig } from './debug/index.ts';

export const SERVER_APP = '@rpg/server';
/** API path prefixes the web app's SPA fallback must never answer with `index.html` (keeps JSON 404s for API typos). */
export const RPG_API_PREFIXES = ['/auth', '/characters', '/content', '/debug', '/expeditions', '/health', '/live', '/merchant'] as const;
/** RPG composition: game data stays here; generic infrastructure lives in server-kit. */
export function createRpgServer(config: ServerConfig, options: { clock?: Clock; modules?: readonly ServerModule[];
  jobHandlers?: Readonly<Record<string, JobHandler>>; seedSource?: () => number;
  settlementPolicies?: readonly SettlementPolicy[]; live?: RpgLiveHost; debug?: RpgDebugToolsConfig;
  estimates?: EstimateServiceOptions } = {}) {
  const settlementPolicies = options.settlementPolicies ?? supportedSettlementPolicies;
  // Debug tools (#31) wrap the app clock for time travel; disabled → null, production config → throws.
  const debug = createRpgDebugTools(options.debug, options.clock, config.roles);
  // Technical seed areas (#156) are player-hidden unless the debug tools are enabled in a non-production environment.
  const exposeTechnicalAreas = debug !== null;
  const live = options.live ?? createRpgLiveHost();
  const content: ServerModule = {
    name: 'content', roles: ['api'],
    async register(app, context) {
      // Expose version metadata only; full bundles may contain server-only game data.
      app.get('/content', async () => ({ game: context.content.game, contentHash: context.content.contentHash,
        format: context.content.format }));
    },
  };
  return createServer({ config, game: 'rpg', validateContent: validateRpgBundle,
    staticReservedPrefixes: RPG_API_PREFIXES, ...options, ...(debug ? { clock: debug.clock } : {}),
    migrationSets: [RPG_MIGRATIONS],
    modules: [content, ...(debug ? [debug.module] : []), createAuthModule({
      allowedOrigins: config.allowedOrigins, enableHttp: config.roles.includes('api'), enableLive: config.roles.includes('live'),
      createLifecycleHandler: context => event => persistRpgConnectionLifecycle(context.database, event),
      // `live.*` operations go to the instance host; everything else is a character command envelope.
      onCommand: async (payload, identity, context, connection) => await handleRpgLiveSocketCommand(payload, identity, connection, live)
        ?? executeCharacterSocketCommand(context, identity.accountId, payload, options.seedSource, settlementPolicies, exposeTechnicalAreas),
    }), characterModule, createWorldModule(exposeTechnicalAreas), createLiveEntryModule(live, exposeTechnicalAreas), live.module,
    createExpeditionModule(options.seedSource, settlementPolicies, options.estimates, exposeTechnicalAreas), createCommandMaintenanceModule(),
    createRpgJobsModule(options.jobHandlers ?? {}, settlementPolicies), ...(options.modules ?? [])] });
}
