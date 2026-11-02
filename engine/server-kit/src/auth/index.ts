import type { ModuleContext, ServerModule } from '../server.ts';
import { registerAuthHttp } from './http.ts';
import type { HttpAuthOptions } from './http.ts';
import { registerLiveAuth } from './live.ts';
import { AuthService } from './service.ts';
import type { AuthIdentity, AuthServiceOptions } from './service.ts';

export * from './schema.ts';
export * from './service.ts';
export * from './errors.ts';
export { checkOrigin, requireAccount, sessionToken, SESSION_COOKIE } from './http.ts';
export { guardLiveSocket } from './live.ts';
export type { LiveSocketGuard } from './live.ts';
export type AuthModuleOptions = AuthServiceOptions & HttpAuthOptions & {
  readonly enableHttp?: boolean;
  readonly enableLive?: boolean;
  readonly heartbeatMs?: number;
  readonly onCommand?: (payload: unknown, identity: AuthIdentity, context: ModuleContext) => Promise<unknown>;
};
/** Composition passes role flags explicitly; no shared Fastify decorator crosses module scopes. */
export function createAuthModule(options: AuthModuleOptions = {}): ServerModule {
  const heartbeat = options.heartbeatMs ?? 10000;
  if (!Number.isSafeInteger(heartbeat) || heartbeat <= 0 || heartbeat >= (options.liveLeaseMs ?? 30000)) throw new RangeError('heartbeat must be shorter than the live lease');
  return {
    name: 'auth', roles: ['api', 'live'],
    async register(app, context) {
      const service = new AuthService(context.database, context.clock, options);
      const onCommand = options.onCommand;
      if (options.enableLive !== false) registerLiveAuth(app, context, service, { heartbeatMs: heartbeat,
        ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
        ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
        ...(onCommand === undefined ? {} : { onCommand: (payload, identity) => onCommand(payload, identity, context) }) });
      if (options.enableHttp !== false) registerAuthHttp(app, context, service, options);
    },
  };
}
