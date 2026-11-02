import { exponentialBackoff } from '../api/backoff.ts';
import { ApiError } from '../api/http.ts';
import type { LiveEvent, LiveState } from './state.ts';
import { INITIAL_LIVE_STATE, transition } from './state.ts';

/** The subset of the browser WebSocket the client uses (injectable for tests). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveClientOptions {
  /** Absolute ws(s) URL of `/auth/live`. The HTTP session cookie authenticates the upgrade; no token in the URL. */
  readonly url: string;
  readonly createSocket?: (url: string) => WebSocketLike;
  /**
   * Runs before every connection attempt. The browser reports a rejected upgrade (401) only as close code 1006, so
   * the app re-validates/renews its cookie session here. Throwing an `ApiError` with a 4xx status is fatal (the
   * credential cannot be renewed); any other error counts as a failed attempt and is retried with backoff.
   */
  readonly beforeConnect?: () => Promise<void>;
  readonly backoff?: (attempt: number) => number;
  /** Client ping cadence; the server answers `pong` and renews the live lease on each ping. */
  readonly pingIntervalMs?: number;
  /** A connection with no inbound frame for this long after a ping is considered dead. */
  readonly pongTimeoutMs?: number;
}

/** Locally initiated close after a missed pong; never sent by the server. */
export const CLOSE_PONG_TIMEOUT = 4000;
/** Browser code for an abnormal close (network loss, rejected upgrade). */
export const CLOSE_ABNORMAL = 1006;

/**
 * Drives the authenticated live socket: connects, waits for the server's `authenticated` acknowledgement, keeps the
 * lease alive with pings, detects dead connections, and reconnects with exponential backoff. It carries no game
 * protocol; commands are gated on `status === 'open'` by the app.
 *
 * The server allows one live connection per account and refuses a second one with 4409 until the previous lease is
 * released or expires (30 s after a crash/network loss), so 4409 is retried with backoff like other closes.
 */
export class LiveClient {
  #state: LiveState = INITIAL_LIVE_STATE;
  readonly #listeners = new Set<(state: LiveState) => void>();
  readonly #options: Required<Omit<LiveClientOptions, 'beforeConnect'>> & Pick<LiveClientOptions, 'beforeConnect'>;
  #socket: WebSocketLike | null = null;
  #generation = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveClientOptions) {
    this.#options = {
      createSocket: (url) => new WebSocket(url),
      backoff: exponentialBackoff({ baseMs: 1000, maxMs: 30_000 }),
      pingIntervalMs: 15_000,
      pongTimeoutMs: 10_000,
      ...options,
    };
  }

  get state(): LiveState { return this.#state; }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  start(): void { this.#dispatch({ type: 'start' }); }
  stop(): void { this.#dispatch({ type: 'stop' }); }
  /** Browser regained connectivity: skip the remaining backoff. */
  online(): void { this.#dispatch({ type: 'online' }); }
  /** Browser lost connectivity: fail fast instead of waiting for the pong timeout. */
  offline(): void {
    if (this.#socket) this.#lost(CLOSE_ABNORMAL);
  }

  /** Resolves once the socket is authenticated (immediately if it already is). */
  waitUntilOpen(): Promise<void> {
    if (this.#state.status === 'open') return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe((state) => {
        if (state.status === 'open') { unsubscribe(); resolve(); }
      });
    });
  }

  #dispatch(event: LiveEvent): void {
    const { state, effect } = transition(this.#state, event, this.#options.backoff);
    if (state !== this.#state) {
      this.#state = state;
      for (const listener of [...this.#listeners]) listener(state);
    }
    // A no-op event leaves any pending reconnect timer alone.
    if (effect.type === 'none') return;
    this.#clearRetry();
    switch (effect.type) {
      case 'connect': void this.#connect(); break;
      case 'scheduleRetry':
        this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#dispatch({ type: 'retry' }); }, effect.delayMs);
        break;
      case 'disconnect': this.#teardown(1000); break;
    }
  }

  async #connect(): Promise<void> {
    this.#teardown(1000);
    const generation = ++this.#generation;
    try {
      await this.#options.beforeConnect?.();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        this.#dispatch({ type: 'fatal', error: error.code });
      } else {
        this.#dispatch({ type: 'closed', code: CLOSE_ABNORMAL });
      }
      return;
    }
    if (generation !== this.#generation || this.#state.status !== 'connecting') return;
    let socket: WebSocketLike;
    try {
      socket = this.#options.createSocket(this.#options.url);
    } catch {
      this.#dispatch({ type: 'closed', code: CLOSE_ABNORMAL });
      return;
    }
    this.#socket = socket;
    socket.onmessage = (event) => {
      if (generation !== this.#generation) return;
      this.#clearPong();
      if (event.data === 'pong') return;
      if (typeof event.data !== 'string') return;
      let frame: unknown;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame !== null && typeof frame === 'object' && (frame as { type?: unknown }).type === 'authenticated') {
        this.#startPing(generation);
        this.#dispatch({ type: 'authenticated' });
      }
    };
    socket.onclose = (event) => {
      if (generation !== this.#generation) return;
      this.#lost(event.code);
    };
    // An error is always followed by close; the close handler reports it.
    socket.onerror = () => {};
  }

  #lost(code: number): void {
    // Browsers only accept 1000 or 3000-4999 from scripts; a network loss (1006) is closed normally.
    this.#teardown(code === CLOSE_PONG_TIMEOUT ? CLOSE_PONG_TIMEOUT : 1000);
    this.#dispatch({ type: 'closed', code });
  }

  #startPing(generation: number): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      const socket = this.#socket;
      if (generation !== this.#generation || !socket || socket.readyState !== 1) return;
      socket.send('ping');
      if (this.#pongTimer === null) {
        this.#pongTimer = setTimeout(() => {
          this.#pongTimer = null;
          if (generation === this.#generation) this.#lost(CLOSE_PONG_TIMEOUT);
        }, this.#options.pongTimeoutMs);
      }
    }, this.#options.pingIntervalMs);
  }

  /** Detaches and closes the current socket; late events from it are ignored via the generation counter. */
  #teardown(code: number): void {
    this.#stopPing();
    const socket = this.#socket;
    this.#socket = null;
    this.#generation++;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(code); } catch { /* already closed */ }
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    this.#clearPong();
  }
  #clearPong(): void {
    if (this.#pongTimer !== null) clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
  }
  #clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }
}
