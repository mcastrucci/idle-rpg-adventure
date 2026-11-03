import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Clock } from './clock.ts';
import { SystemClock } from './clock.ts';
import type { ServerConfig, ProcessRole } from './config.ts';
import type { LoadedContent } from './content.ts';
import { loadContentBundle } from './content.ts';
import type { Database, MigrationSet } from './database.ts';
import { createDatabase } from './database.ts';
import { contentReleases } from './schema.ts';

/** Domain boundaries are extension points, not preinstalled empty services. Each module owns its routes/state. */
export const MODULE_NAMES = ['auth', 'character', 'commands', 'ledger', 'content', 'conquest', 'live-host', 'live-entry', 'expeditions', 'party', 'jobs', 'debug', 'world'] as const;
export type ModuleName = typeof MODULE_NAMES[number];
export interface ModuleContext {
  readonly clock: Clock;
  readonly database: Database;
  readonly content: LoadedContent;
}
export interface ServerModule {
  readonly name: ModuleName;
  readonly roles: readonly ProcessRole[];
  /** Each module runs inside a Fastify encapsulation scope. Register onClose hooks for its resources. */
  register(app: FastifyInstance, context: ModuleContext): Promise<void>;
}
export interface ServerOptions {
  readonly config: ServerConfig;
  readonly game: string;
  readonly clock?: Clock;
  readonly modules?: readonly ServerModule[];
  readonly migrationSets?: readonly MigrationSet[];
  /** Additional game schema validation runs before database connections are acquired. */
  readonly validateContent?: (content: LoadedContent) => void;
}

/** Builds a fully ready server without listening; inject() works for tests. app.close() drains modules then DB. */
export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { config } = options;
  const content = await loadContentBundle(config.contentBundlePath, options.game);
  options.validateContent?.(content);
  const modules = options.modules ?? [];
  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.name)) throw new Error(`duplicate server module: ${module.name}`);
    if (module.roles.length === 0) throw new Error(`module ${module.name} must declare roles`);
    names.add(module.name);
  }
  const clock = options.clock ?? new SystemClock();
  const app = Fastify({ logger: { level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'databaseUrl', 'config.databaseUrl'] },
    return503OnClosing: true, forceCloseConnections: 'idle' });
  const database = createDatabase(config, options);
  app.addHook('onClose', async () => { await database.close(); });
  // pg emits idle-client errors outside requests; handle them to prevent an unhandled EventEmitter crash.
  database.pool.on('error', (error: Error & { code?: string }) => {
    // pg can attach the client (including connection credentials) to idle errors. Never serialize that object.
    app.log.error({ code: error.code ?? 'DATABASE_CONNECTION_ERROR' }, 'idle database connection failed');
  });
  try {
    await database.ping();
    if (config.migrateOnBoot) await database.migrate();
    await database.verifyMigrations();
    await database.db.insert(contentReleases).values({ contentHash: content.contentHash, game: content.game,
      format: content.format, firstSeenAt: new Date(clock.nowMs()) }).onConflictDoNothing();
    app.get('/health/live', async () => ({ status: 'ok' }));
    app.get('/health/ready', async (_request, reply) => {
      try { await database.ping(); }
      catch { return reply.code(503).send({ status: 'unavailable' }); }
      return { status: 'ok', contentHash: content.contentHash, roles: config.roles };
    });
    for (const module of modules) {
      if (!module.roles.some((role) => config.roles.includes(role))) continue;
      app.register(async (scope) => {
        await module.register(scope, { clock, database, content });
        scope.log.info({ module: module.name }, 'module started');
      });
    }
    await app.ready();
    app.log.info({ roles: config.roles, contentHash: content.contentHash }, 'server ready');
    return app;
  } catch (error) {
    try { await app.close(); }
    finally { await database.close(); }
    throw error;
  }
}
