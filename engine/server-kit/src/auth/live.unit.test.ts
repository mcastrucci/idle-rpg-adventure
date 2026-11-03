import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import type { AuthContext } from './http.ts';
import { guardLiveSocket } from './live.ts';
import type { AuthService, LiveLease } from './service.ts';

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 2; }
  terminate(): void { this.readyState = 3; }
}

const lease: LiveLease = { accountId: 'account-a', sessionHash: 'opaque-hash', leaseId: 'lease-a' };

describe('live socket lifecycle', () => {
  it('captures close time before draining work and releases once when lifecycle callbacks reject', async () => {
    const socket = new FakeSocket();
    let now = 100;
    let commandCompleted = false;
    let releaseCommand: (() => void) | undefined;
    let commandStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseCommand = resolve; });
    let releases = 0;
    const events: { type: string; atMs: number }[] = [];
    const service = {
      async acquireLive() { return lease; },
      async renewLive() { return { accountId: lease.accountId, sessionHash: lease.sessionHash, expiresAtMs: 9999 }; },
      async releaseLive() { releases++; },
    } as unknown as AuthService;
    const context = { clock: { nowMs: () => now } } as AuthContext;
    const guard = guardLiveSocket(socket as unknown as WebSocket, service, 'test-token', context, 60_000,
      () => {}, async () => { commandStarted?.(); await held; commandCompleted = true; return { ok: true }; }, async (event) => {
        events.push({ type: event.type, atMs: event.atMs });
        throw new Error('telemetry unavailable');
      });

    await waitFor(() => socket.sent.some((message) => message.includes('authenticated')));
    socket.emit('message', Buffer.from('{"type":"command","command":{}}'), false);
    await started;
    now = 150;
    const stopping = guard.stop();
    now = 900;
    releaseCommand?.();
    await stopping;

    expect(events.filter((event) => event.type === 'stopped')).toEqual([{ type: 'stopped', atMs: 150 }]);
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1);
    expect(releases).toBe(1);
    expect(commandCompleted).toBe(true);
  });

  it('does not emit a heartbeat when renewal finishes after close was requested', async () => {
    const socket = new FakeSocket();
    let resolveRenew: (() => void) | undefined;
    let renewStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { renewStarted = resolve; });
    const renewing = new Promise<void>((resolve) => { resolveRenew = resolve; });
    const events: string[] = [];
    const service = {
      async acquireLive() { return lease; },
      async renewLive() { renewStarted?.(); await renewing; return { accountId: lease.accountId, sessionHash: lease.sessionHash, expiresAtMs: 9999 }; },
      async releaseLive() {},
    } as unknown as AuthService;
    const context = { clock: { nowMs: () => 100 } } as AuthContext;
    const guard = guardLiveSocket(socket as unknown as WebSocket, service, 'test-token', context, 60_000,
      () => {}, undefined, async (event) => { events.push(event.type); });

    await waitFor(() => socket.sent.some((message) => message.includes('authenticated')));
    socket.emit('message', Buffer.from('ping'), false);
    await started;
    const stopping = guard.stop();
    resolveRenew?.();
    await stopping;

    expect(events).toEqual(['authenticated', 'stopped']);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition did not become true');
}
