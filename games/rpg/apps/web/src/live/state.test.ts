import { describe, expect, it } from 'vitest';

import type { LiveEvent, LiveState } from './state.ts';
import { INITIAL_LIVE_STATE, transition } from './state.ts';

const backoff = (attempt: number) => attempt * 1000;

function run(events: readonly LiveEvent[], from: LiveState = INITIAL_LIVE_STATE) {
  const effects: string[] = [];
  let state = from;
  for (const event of events) {
    const next = transition(state, event, backoff);
    state = next.state;
    effects.push(next.effect.type === 'scheduleRetry' ? `scheduleRetry:${next.effect.delayMs}` : next.effect.type);
  }
  return { state, effects };
}

describe('live connection state machine', () => {
  it('connects, authenticates and opens', () => {
    const { state, effects } = run([{ type: 'start' }, { type: 'authenticated' }]);
    expect(state.status).toBe('open');
    expect(effects).toEqual(['connect', 'none']);
  });

  it('backs off with increasing attempts until it authenticates again, then resets', () => {
    const { state, effects } = run([
      { type: 'start' }, { type: 'authenticated' },
      { type: 'closed', code: 1006 }, { type: 'retry' },
      { type: 'closed', code: 1006 }, { type: 'retry' },
      { type: 'closed', code: 4409 },
    ]);
    expect(effects).toEqual(['connect', 'none', 'scheduleRetry:1000', 'connect', 'scheduleRetry:2000', 'connect', 'scheduleRetry:3000']);
    expect(state).toMatchObject({ status: 'reconnecting', attempt: 3, retryInMs: 3000, lastCloseCode: 4409 });
    const reopened = run([{ type: 'retry' }, { type: 'authenticated' }], state).state;
    expect(reopened).toMatchObject({ status: 'open', attempt: 0, retryInMs: null });
  });

  it('skips the remaining backoff when the browser comes back online', () => {
    const { state, effects } = run([{ type: 'start' }, { type: 'closed', code: 1006 }, { type: 'online' }]);
    expect(state.status).toBe('connecting');
    expect(effects.at(-1)).toBe('connect');
  });

  it('ignores events that do not apply to the current state', () => {
    const open = run([{ type: 'start' }, { type: 'authenticated' }]).state;
    for (const event of [{ type: 'start' }, { type: 'retry' }, { type: 'online' }, { type: 'authenticated' }] as const) {
      expect(transition(open, event, backoff)).toEqual({ state: open, effect: { type: 'none' } });
    }
    expect(transition(INITIAL_LIVE_STATE, { type: 'closed', code: 1006 }, backoff).effect.type).toBe('none');
  });

  it('fails on a fatal error and can be restarted', () => {
    const failed = run([{ type: 'start' }, { type: 'fatal', error: 'guest_credential_disabled' }]);
    expect(failed.state).toMatchObject({ status: 'failed', error: 'guest_credential_disabled' });
    expect(failed.effects.at(-1)).toBe('disconnect');
    expect(transition(failed.state, { type: 'closed', code: 1006 }, backoff).effect.type).toBe('none');
    expect(run([{ type: 'start' }], failed.state).state).toMatchObject({ status: 'connecting', error: null, attempt: 0 });
  });

  it('stops from any state and stays stopped', () => {
    const stopped = run([{ type: 'start' }, { type: 'closed', code: 1006 }, { type: 'stop' }]);
    expect(stopped.state.status).toBe('stopped');
    expect(stopped.effects.at(-1)).toBe('disconnect');
    expect(transition(stopped.state, { type: 'retry' }, backoff).effect.type).toBe('none');
  });
});
