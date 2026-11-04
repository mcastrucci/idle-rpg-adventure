import { isIP } from 'node:net';
import { resolve } from 'node:path';

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
  /**
   * Reverse-proxy trust for `X-Forwarded-*` headers (Fastify `trustProxy`). `false` (default) ignores them. `true` trusts
   * every peer (only safe when the listener is reachable solely by your proxy; `request.ip` then becomes the left-most,
   * client-controlled forwarded address). A list restricts trust to proxies whose socket address matches an IP, CIDR or
   * `loopback`/`linklocal`/`uniquelocal`.
   */
  readonly trustProxy: boolean | readonly string[];
  /** Extra exact browser origins (`https://host[:port]`) accepted by the cookie same-origin check, e.g. a TLS proxy's public origin. */
  readonly allowedOrigins: readonly string[];
  /** Absolute directory of a built single-page web app served on the same origin; undefined disables static hosting. */
  readonly staticDir?: string;
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
  const staticDir = env['WEB_DIST_DIR']?.trim();
  return {
    databaseUrl, contentBundlePath: required(env, 'CONTENT_BUNDLE_PATH'), roles: roles as ProcessRole[],
    host: env['HOST']?.trim() || '0.0.0.0', port: integer(env, 'PORT', 3000, 0, 65535), logLevel: logLevel as LogLevel,
    poolMax: integer(env, 'DB_POOL_MAX', 10, 1, 100), databaseTimeoutMs: integer(env, 'DB_TIMEOUT_MS', 5000, 1, 120000),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 10000, 1, 120000), migrateOnBoot: migrate === 'true',
    trustProxy: parseTrustProxy(env['TRUST_PROXY']), allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS']),
    ...(staticDir ? { staticDir: resolve(staticDir) } : {}),
  };
}

const TRUST_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
/** `TRUST_PROXY`: unset/empty/`false`/`0` off; `true`/`1` trust every peer; otherwise a comma-separated IP/CIDR/keyword list. */
export function parseTrustProxy(raw: string | undefined): boolean | readonly string[] {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) if (!validTrustEntry(entry)) {
    throw new Error('TRUST_PROXY must be true/false or a comma-separated list of IPs, CIDRs, loopback, linklocal or uniquelocal');
  }
  return [...new Set(entries)];
}
function validTrustEntry(entry: string): boolean {
  if (TRUST_KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** `ALLOWED_ORIGINS`: comma-separated exact origins `http(s)://host[:port]`; no wildcards, paths, credentials or query. */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const origins = new Set<string>();
  for (const entry of raw.split(',').map((item) => item.trim())) {
    let url: URL | undefined;
    if (/^https?:\/\/[^/?#@*\s]+$/i.test(entry)) { try { url = new URL(entry); } catch { /* reported below */ } }
    if (url === undefined || url.hostname === '') throw new Error('ALLOWED_ORIGINS must be comma-separated exact origins like https://host[:port] (no wildcards, paths or credentials)');
    origins.add(url.origin);
  }
  return [...origins];
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
