import { createAuthModule, createCommandMaintenanceModule, createServer, LIVE_HOST_MIGRATIONS } from '@engine/server-kit';
import type { Clock, JobHandler, ServerConfig, ServerModule } from '@engine/server-kit';

import { validateRpgBundle } from './content.ts';
import { RPG_MIGRATIONS } from './migrations.ts';
import { characterModule } from './characters/http.ts';
import { executeCharacterSocketCommand } from './character-commands.ts';
import { createRpgLiveHost } from './live/index.ts';
import type { RpgLiveHost } from './live/index.ts';
import { createExpeditionModule } from './expeditions/http.ts';
import { createRpgJobsModule } from './expeditions/jobs.ts';
import { supportedSettlementPolicies } from './expeditions/policy.ts';
import type { SettlementPolicy } from './expeditions/policy.ts';
import { createRpgDebugTools } from './debug/index.ts';
import type { RpgDebugToolsConfig } from './debug/index.ts';

export { createRpgDatabase, RPG_MIGRATIONS } from './migrations.ts';
export * from './live/index.ts';
export { DebugToolsRefusedError, parseRpgDebugToolsConfig } from './debug/index.ts';
export type { RpgDebugToolsConfig } from './debug/index.ts';

export const SERVER_APP = '@rpg/server';
/** RPG composition: game data stays here; generic infrastructure lives in server-kit. */
export function createRpgServer(config: ServerConfig, options: { clock?: Clock; modules?: readonly ServerModule[];
  jobHandlers?: Readonly<Record<string, JobHandler>>; seedSource?: () => number;
  settlementPolicies?: readonly SettlementPolicy[]; live?: RpgLiveHost; debug?: RpgDebugToolsConfig } = {}) {
  const settlementPolicies = options.settlementPolicies ?? supportedSettlementPolicies;
  // Debug tools (#31) wrap the app clock for time travel; disabled → null, production config → throws.
  const debug = createRpgDebugTools(options.debug, options.clock, config.roles);
  const live = options.live ?? createRpgLiveHost();
  const content: ServerModule = {
    name: 'content', roles: ['api'],
    async register(app, context) {
      // Expose version metadata only; full bundles may contain server-only game data.
      app.get('/content', async () => ({ game: context.content.game, contentHash: context.content.contentHash,
        format: context.content.format }));
    },
  };
  return createServer({ config, game: 'rpg', validateContent: validateRpgBundle, ...options, ...(debug ? { clock: debug.clock } : {}),
    migrationSets: [LIVE_HOST_MIGRATIONS, RPG_MIGRATIONS],
    modules: [content, ...(debug ? [debug.module] : []), createAuthModule({
      enableHttp: config.roles.includes('api'), enableLive: config.roles.includes('live'),
      // `live.*` operations go to the instance host; everything else is a character command envelope.
      onCommand: async (payload, identity, context, connection) => await live.handleSocketCommand(payload, identity, connection)
        ?? executeCharacterSocketCommand(context, identity.accountId, payload, options.seedSource, settlementPolicies),
    }), characterModule, live.module, createExpeditionModule(options.seedSource, settlementPolicies), createCommandMaintenanceModule(),
    createRpgJobsModule(options.jobHandlers ?? {}, settlementPolicies), ...(options.modules ?? [])] });
}
