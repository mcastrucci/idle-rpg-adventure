import { describe, expect, it } from 'vitest';

import { ManualClock, parseServerConfig, SystemClock } from './index.ts';

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
