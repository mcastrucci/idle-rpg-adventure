/**
 * Pure connection state machine for the authenticated live socket (`GET /auth/live`). The driver (`LiveClient`)
 * performs the returned effect; keeping the policy pure makes reconnect behaviour exhaustively testable.
 *
 *   idle --start--> connecting --authenticated--> open
 *   connecting|open --closed--> reconnecting --retry|online--> connecting
 *   connecting|open|reconnecting --fatal--> failed --start--> connecting
 *   any --stop--> stopped --start--> connecting
 */
export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed' | 'stopped';

export interface LiveState {
  readonly status: LiveStatus;
  /** Consecutive failed connection attempts since the last successful authentication. */
  readonly attempt: number;
  /** Delay before the scheduled reconnect, while `reconnecting`. */
  readonly retryInMs: number | null;
  /** Close code of the last lost connection (4401 session revoked, 4409 another live session, 1006 network…). */
  readonly lastCloseCode: number | null;
  /** Stable reason for `failed` (e.g. an auth error code); null otherwise. */
  readonly error: string | null;
}

export type LiveEvent =
  | { readonly type: 'start' }
  | { readonly type: 'authenticated' }
  | { readonly type: 'closed'; readonly code: number }
  | { readonly type: 'retry' }
  | { readonly type: 'online' }
  | { readonly type: 'fatal'; readonly error: string }
  | { readonly type: 'stop' };

export type LiveEffect =
  | { readonly type: 'none' }
  | { readonly type: 'connect' }
  | { readonly type: 'scheduleRetry'; readonly delayMs: number }
  | { readonly type: 'disconnect' };

export interface LiveTransition {
  readonly state: LiveState;
  readonly effect: LiveEffect;
}

export const INITIAL_LIVE_STATE: LiveState = { status: 'idle', attempt: 0, retryInMs: null, lastCloseCode: null, error: null };

const NONE: LiveEffect = { type: 'none' };

export function transition(state: LiveState, event: LiveEvent, backoff: (attempt: number) => number): LiveTransition {
  switch (event.type) {
    case 'start':
      if (state.status === 'idle' || state.status === 'stopped' || state.status === 'failed') {
        return { state: { ...state, status: 'connecting', attempt: 0, retryInMs: null, error: null }, effect: { type: 'connect' } };
      }
      return { state, effect: NONE };
    case 'authenticated':
      if (state.status !== 'connecting') return { state, effect: NONE };
      return { state: { ...state, status: 'open', attempt: 0, retryInMs: null, error: null }, effect: NONE };
    case 'closed': {
      if (state.status !== 'connecting' && state.status !== 'open') return { state, effect: NONE };
      const attempt = state.attempt + 1;
      const delayMs = backoff(attempt);
      return {
        state: { ...state, status: 'reconnecting', attempt, retryInMs: delayMs, lastCloseCode: event.code },
        effect: { type: 'scheduleRetry', delayMs },
      };
    }
    case 'retry':
    case 'online':
      if (state.status !== 'reconnecting') return { state, effect: NONE };
      return { state: { ...state, status: 'connecting', retryInMs: null }, effect: { type: 'connect' } };
    case 'fatal':
      if (state.status === 'stopped' || state.status === 'idle') return { state, effect: NONE };
      return { state: { ...state, status: 'failed', retryInMs: null, error: event.error }, effect: { type: 'disconnect' } };
    case 'stop':
      if (state.status === 'stopped') return { state, effect: NONE };
      return { state: { ...state, status: 'stopped', retryInMs: null }, effect: { type: 'disconnect' } };
  }
}
