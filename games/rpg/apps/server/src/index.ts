import { createAuthModule, createCommandMaintenanceModule, createJobsModule, createServer } from '@engine/server-kit';
import type { Clock, JobHandler, ServerConfig, ServerModule } from '@engine/server-kit';

import { validateRpgBundle } from './content.ts';
import { RPG_MIGRATIONS } from './migrations.ts';
import { characterModule } from './characters/http.ts';
import { executeCharacterSocketCommand } from './character-commands.ts';

export { createRpgDatabase, RPG_MIGRATIONS } from './migrations.ts';

export const SERVER_APP = '@rpg/server';
/** RPG composition: game data stays here; generic infrastructure lives in server-kit. */
export function createRpgServer(config: ServerConfig, options: { clock?: Clock; modules?: readonly ServerModule[];
  jobHandlers?: Readonly<Record<string, JobHandler>> } = {}) {
  const content: ServerModule = {
    name: 'content', roles: ['api'],
    async register(app, context) {
      // Expose version metadata only; full bundles may contain server-only game data.
      app.get('/content', async () => ({ game: context.content.game, contentHash: context.content.contentHash,
        format: context.content.format }));
    },
  };
  return createServer({ config, game: 'rpg', validateContent: validateRpgBundle, ...options, migrationSets: [RPG_MIGRATIONS],
    modules: [content, createAuthModule({
      enableHttp: config.roles.includes('api'), enableLive: config.roles.includes('live'),
      onCommand: (payload, identity, context) => executeCharacterSocketCommand(context, identity.accountId, payload),
    }), characterModule, createCommandMaintenanceModule(), createJobsModule(options.jobHandlers ?? {}), ...(options.modules ?? [])] });
}
