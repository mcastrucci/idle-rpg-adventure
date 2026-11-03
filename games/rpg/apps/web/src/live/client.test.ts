import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/http.ts';
import type { WebSocketLike } from './client.ts';
import { CLOSE_PONG_TIMEOUT, LiveClient } from './client.ts';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  closedWith: number | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number): void { this.closedWith = code ?? 1000; this.readyState = 3; }
  /** Server side of the handshake: upgrade accepted, lease acquired. */
  authenticate(): void {
    this.readyState = 1;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'authenticated', accountId: '11111111-1111-4111-8111-111111111111' }) }));
  }
  receive(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
  drop(code: number): void { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code })); }
}

function setup(options: { beforeConnect?: () => Promise<void> } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new LiveClient({
    url: 'ws://test/auth/live',
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    backoff: (attempt) => attempt * 1000,
    pingIntervalMs: 15_000,
    pongTimeoutMs: 5_000,
    ...options,
  });
  const latest = () => { const socket = sockets.at(-1); if (!socket) throw new Error('no socket'); return socket; };
  return { client, sockets, latest };
}

/** Lets the awaited beforeConnect hook settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('LiveClient reconnect', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens only after the server acknowledges authentication', async () => {
    const { client, latest } = setup();
    client.start();
    await flush();
    expect(client.state.status).toBe('connecting');
    latest().authenticate();
    expect(client.state.status).toBe('open');
  });

  it('reconnects with backoff after a dropped connection and resolves waiting commands once open again', async () => {
    const { client, sockets, latest } = setup();
    client.start();
    await flush();
    latest().authenticate();
    latest().drop(1006);
    expect(client.state).toMatchObject({ status: 'reconnecting', attempt: 1, retryInMs: 1000, lastCloseCode: 1006 });

    let released = false;
    void client.waitUntilOpen().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    latest().drop(4409); // previous lease still held server-side
    expect(client.state).toMatchObject({ status: 'reconnecting', attempt: 2, retryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(released).toBe(false);
    latest().authenticate();
    await flush();
    expect(released).toBe(true);
    expect(client.state).toMatchObject({ status: 'open', attempt: 0 });
  });

  it('ignores late events from a replaced socket', async () => {
    const { client, sockets, latest } = setup();
    client.start();
    await flush();
    const first = latest();
    first.authenticate();
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    latest().authenticate();
    first.drop(1006);
    expect(sockets).toHaveLength(2);
    expect(client.state.status).toBe('open');
  });

  it('pings while open and treats a missing pong as a dead connection', async () => {
    const { client, latest } = setup();
    client.start();
    await flush();
    const socket = latest();
    socket.authenticate();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent).toEqual(['ping']);
    socket.receive('pong');
    await vi.advanceTimersByTimeAsync(15_000 + 4_999);
    expect(client.state.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closedWith).toBe(CLOSE_PONG_TIMEOUT);
    expect(client.state).toMatchObject({ status: 'reconnecting', lastCloseCode: CLOSE_PONG_TIMEOUT });
  });

  it('reconnects immediately when the browser is back online', async () => {
    const { client, sockets, latest } = setup();
    client.start();
    await flush();
    latest().authenticate();
    client.offline();
    expect(client.state.status).toBe('reconnecting');
    client.online();
    await flush();
    expect(sockets).toHaveLength(2);
    expect(client.state.status).toBe('connecting');
  });

  it('renews the session before each attempt; a refused credential is fatal, network errors are retried', async () => {
    const outcomes: Array<Error | null> = [new TypeError('Failed to fetch'), new ApiError(401, 'guest_credential_disabled')];
    const { client, sockets } = setup({ beforeConnect: async () => { const next = outcomes.shift(); if (next) throw next; } });
    client.start();
    await flush();
    expect(client.state).toMatchObject({ status: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.state).toMatchObject({ status: 'failed', error: 'guest_credential_disabled' });
    expect(sockets).toHaveLength(0);
    client.start();
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it('stop closes the socket and cancels pending reconnects', async () => {
    const { client, sockets, latest } = setup();
    client.start();
    await flush();
    latest().drop(1006);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.state.status).toBe('stopped');
  });
});
