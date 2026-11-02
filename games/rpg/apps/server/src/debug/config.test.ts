import { describe, expect, it } from 'vitest';

import { ManualClock } from '@engine/server-kit';

import { assertDebugToolsAllowed, DebugToolsRefusedError, parseRpgDebugToolsConfig } from './config.ts';
import { TimeTravelClock } from './clock.ts';
import { createRpgDebugTools } from './index.ts';

describe('debug tools production guard', () => {
  it('is disabled by default and when the flag is off', () => {
    expect(parseRpgDebugToolsConfig({}).enabled).toBe(false);
    expect(parseRpgDebugToolsConfig({ RPG_DEBUG_TOOLS: '0', APP_ENV: 'production' }).enabled).toBe(false);
    expect(createRpgDebugTools(parseRpgDebugToolsConfig({ APP_ENV: 'qa' }), undefined, ['api'])).toBeNull();
  });

  it('enables only with an explicit allowlisted non-production environment', () => {
    expect(parseRpgDebugToolsConfig({ RPG_DEBUG_TOOLS: '1', APP_ENV: 'qa' })).toMatchObject({ enabled: true, environment: 'qa' });
    expect(parseRpgDebugToolsConfig({ RPG_DEBUG_TOOLS: 'true', APP_ENV: 'development', NODE_ENV: 'development' }).enabled).toBe(true);
  });

  it('refuses production configuration, unknown environments and malformed flags', () => {
    for (const env of [
      { RPG_DEBUG_TOOLS: '1', APP_ENV: 'production' },
      { RPG_DEBUG_TOOLS: '1', APP_ENV: 'PROD' },
      { RPG_DEBUG_TOOLS: '1', APP_ENV: 'qa', NODE_ENV: 'production' },
      { RPG_DEBUG_TOOLS: '1' },
      { RPG_DEBUG_TOOLS: '1', APP_ENV: 'live' },
    ]) expect(() => parseRpgDebugToolsConfig(env)).toThrow(DebugToolsRefusedError);
    expect(() => parseRpgDebugToolsConfig({ RPG_DEBUG_TOOLS: 'yes', APP_ENV: 'qa' })).toThrow(/RPG_DEBUG_TOOLS/);
    expect(() => createRpgDebugTools({ enabled: true, environment: 'production' }, undefined, ['api'])).toThrow(DebugToolsRefusedError);
    expect(() => assertDebugToolsAllowed({ enabled: false, environment: 'qa' })).toThrow(DebugToolsRefusedError);
  });
});

describe('TimeTravelClock', () => {
  it('adds a forward-only offset to the base clock', () => {
    const base = new ManualClock(1_000);
    const clock = new TimeTravelClock(base);
    expect(clock.nowMs()).toBe(1_000);
    clock.observeOffset(500);
    expect(clock.nowMs()).toBe(1_500);
    clock.observeOffset(100); // stale refresh never moves time backwards
    expect(clock.nowMs()).toBe(1_500);
    base.advance(10);
    expect([clock.nowMs(), clock.baseNowMs(), clock.offsetMs]).toEqual([1_510, 1_010, 500]);
    expect(() => clock.observeOffset(-1)).toThrow(RangeError);
    expect(() => clock.observeOffset(1.5)).toThrow(RangeError);
  });
});
