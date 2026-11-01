export const PROCESS_ROLES = ['api', 'live', 'worker'] as const;
export type ProcessRole = typeof PROCESS_ROLES[number];
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export interface ServerConfig {
  readonly databaseUrl: string;
  readonly contentBundlePath: string;
  readonly roles: readonly ProcessRole[];
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly poolMax: number;
  readonly databaseTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly migrateOnBoot: boolean;
}

/** Validates configuration before any sockets, database connections or modules are started. */
export function parseServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname === '' || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must name a PostgreSQL host and database');
  }
  const roles = (env['ROLES'] ?? PROCESS_ROLES.join(',')).split(',').map((r) => r.trim());
  if (roles.length === 0 || roles.some((r) => !(PROCESS_ROLES as readonly string[]).includes(r)) || new Set(roles).size !== roles.length) {
    throw new Error('ROLES must be a non-empty, unique list of api,live,worker');
  }
  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new Error('invalid LOG_LEVEL');
  const migrate = env['MIGRATE_ON_BOOT'] ?? 'false';
  if (migrate !== 'true' && migrate !== 'false') throw new Error('MIGRATE_ON_BOOT must be true or false');
  return {
    databaseUrl, contentBundlePath: required(env, 'CONTENT_BUNDLE_PATH'), roles: roles as ProcessRole[],
    host: env['HOST']?.trim() || '0.0.0.0', port: integer(env, 'PORT', 3000, 0, 65535), logLevel: logLevel as LogLevel,
    poolMax: integer(env, 'DB_POOL_MAX', 10, 1, 100), databaseTimeoutMs: integer(env, 'DB_TIMEOUT_MS', 5000, 1, 120000),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 10000, 1, 120000), migrateOnBoot: migrate === 'true',
  };
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
