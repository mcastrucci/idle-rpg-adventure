import { fileURLToPath } from 'node:url';

import { createDatabase, LIVE_HOST_MIGRATIONS } from '@engine/server-kit';
import type { MigrationSet, ServerConfig } from '@engine/server-kit';

/** RPG SQL stays game-owned; the engine journal (then the optional live-host journal) is applied and verified first. */
export const RPG_MIGRATIONS: MigrationSet = {
  id: 'rpg', schema: 'rpg_migrations', directory: fileURLToPath(new URL('../migrations', import.meta.url)),
};

export function createRpgDatabase(config: Pick<ServerConfig, 'databaseUrl' | 'poolMax' | 'databaseTimeoutMs'>) {
  return createDatabase(config, { migrationSets: [LIVE_HOST_MIGRATIONS, RPG_MIGRATIONS] });
}
