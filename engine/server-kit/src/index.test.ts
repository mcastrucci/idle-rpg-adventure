import { describe, expect, it } from 'vitest';

import { ManualClock, parseAllowedOrigins, parseServerConfig, parseTrustProxy, SystemClock } from './index.ts';

const env = { DATABASE_URL: 'postgres://test:secret@localhost/test', CONTENT_BUNDLE_PATH: '/tmp/content.json' };

describe('validated server config', () => {
  it('defaults to all process roles and supports separate deployments', () => {
    expect(parseServerConfig(env)).toMatchObject({ roles: ['api', 'live', 'worker'], port: 3000, migrateOnBoot: false });
    expect(parseServerConfig({ ...env, ROLES: 'live, worker', PORT: '0' })).toMatchObject({ roles: ['live', 'worker'], port: 0 });
  });
  it('rejects invalid values before boot', () => {
    for (const override of [{ DATABASE_URL: 'https://example.com/db' }, { DATABASE_URL: 'postgres://localhost' },
      { ROLES: '' }, { ROLES: 'api,api' }, { ROLES: 'workre' }, { PORT: '1.5' }, { PORT: '65536' },
      { DB_POOL_MAX: '0' }, { DB_TIMEOUT_MS: '-1' }, { LOG_LEVEL: 'verbose' }, { CONTENT_BUNDLE_PATH: '' },
      { MIGRATE_ON_BOOT: 'yes' }]) {
      expect(() => parseServerConfig({ ...env, ...override })).toThrow();
    }
  });
});

describe('reverse-proxy and web hosting configuration', () => {
  it('defaults to the strict same-origin posture with static hosting disabled', () => {
    expect(parseServerConfig(env)).toMatchObject({ trustProxy: false, allowedOrigins: [] });
    expect(parseServerConfig(env).staticDir).toBeUndefined();
    expect(parseServerConfig({ ...env, TRUST_PROXY: '', ALLOWED_ORIGINS: ' ', WEB_DIST_DIR: ' ' })).toMatchObject({ trustProxy: false, allowedOrigins: [] });
  });
  it('parses TRUST_PROXY switches and restricted proxy lists', () => {
    for (const off of [undefined, '', '0', 'false', ' FALSE ']) expect(parseTrustProxy(off)).toBe(false);
    for (const on of ['1', 'true', ' True ']) expect(parseTrustProxy(on)).toBe(true);
    expect(parseTrustProxy('loopback, uniquelocal')).toEqual(['loopback', 'uniquelocal']);
    expect(parseTrustProxy('10.0.0.0/8,172.16.0.5,::1,fd00::/8,loopback,loopback')).toEqual(['10.0.0.0/8', '172.16.0.5', '::1', 'fd00::/8', 'loopback']);
    expect(parseServerConfig({ ...env, TRUST_PROXY: 'loopback' }).trustProxy).toEqual(['loopback']);
  });
  it('rejects malformed TRUST_PROXY values', () => {
    for (const bad of ['yes', '2', 'enabled', 'loopback,', ',loopback', '10.0.0.0/33', '::1/129', '10.0.0.0/', '10.0.0.0/8/8', 'example.com', '300.1.1.1', '*']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
      expect(() => parseServerConfig({ ...env, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });
  it('parses ALLOWED_ORIGINS as exact normalized origins', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('https://a-b.trycloudflare.com, http://localhost:5173,https://Example.test:443,https://a-b.trycloudflare.com'))
      .toEqual(['https://a-b.trycloudflare.com', 'http://localhost:5173', 'https://example.test']);
    expect(parseServerConfig({ ...env, ALLOWED_ORIGINS: 'https://game.example' }).allowedOrigins).toEqual(['https://game.example']);
  });
  it('rejects wildcards, paths, credentials, other schemes and empty entries in ALLOWED_ORIGINS', () => {
    for (const bad of ['*', 'https://*.trycloudflare.com', 'example.com', 'ftp://example.com', 'https://example.com/', 'https://example.com/path',
      'https://example.com?x=1', 'https://example.com#x', 'https://user:pw@example.com', 'https://', 'https://exa mple.com', 'https://example.com,',
      ',https://example.com', 'https://a.test,,https://b.test', 'null', 'https://example.com:99999']) {
      expect(() => parseAllowedOrigins(bad), bad).toThrow(/ALLOWED_ORIGINS/);
    }
  });
  it('resolves WEB_DIST_DIR to an absolute directory', () => {
    const dir = parseServerConfig({ ...env, WEB_DIST_DIR: 'games/rpg/apps/web/dist' }).staticDir;
    expect(dir?.startsWith('/') || /^[A-Za-z]:/.test(dir ?? '')).toBe(true);
    expect(dir).toMatch(/dist$/);
  });
});

describe('injected clocks', () => {
  it('supports deterministic time travel without reading wall time', () => {
    const clock = new ManualClock(1000);
    clock.advance(60000); expect(clock.nowMs()).toBe(61000);
    clock.set(500); expect(clock.nowMs()).toBe(500);
    expect(() => clock.advance(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => clock.set(-1)).toThrow();
    expect(clock.nowMs()).toBe(500);
    expect(new SystemClock().nowMs()).toBeGreaterThan(0);
  });
});
