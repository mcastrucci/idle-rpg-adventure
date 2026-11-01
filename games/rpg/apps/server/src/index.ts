import { createServer } from '@engine/server-kit';
import type { Clock, ServerConfig, ServerModule } from '@engine/server-kit';

import { validateRpgBundle } from './content.ts';

export const SERVER_APP = '@rpg/server';
/** RPG composition: game data stays here; generic infrastructure lives in server-kit. */
export function createRpgServer(config: ServerConfig, options: { clock?: Clock; modules?: readonly ServerModule[] } = {}) {
  const content: ServerModule = {
    name: 'content', roles: ['api'],
    async register(app, context) {
      // Expose version metadata only; full bundles may contain server-only game data.
      app.get('/content', async () => ({ game: context.content.game, contentHash: context.content.contentHash,
        format: context.content.format }));
    },
  };
  return createServer({ config, game: 'rpg', validateContent: validateRpgBundle, ...options,
    modules: [content, ...(options.modules ?? [])] });
}
