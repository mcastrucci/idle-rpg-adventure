/**
 * Spike 3 comparison tests for the throwaway Colyseus room. Real time only: Colyseus' room clock, simulation interval
 * and reconnection timeout cannot take an injected clock, so grace/tick values are scaled down (ms instead of s).
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { matchMaker, Server } from '@colyseus/core';
import type { Room as ServerRoom } from '@colyseus/core';
import { Client } from '@colyseus/sdk';
import type { Room } from '@colyseus/sdk';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuoRoom } from './room.ts';

interface Received { seq: number; type: string; [key: string]: unknown }

describe('Colyseus duo room (spike comparison)', () => {
  let server: Server;
  let endpoint: string;
  const transport = new WebSocketTransport({ pingInterval: 0 });

  beforeAll(async () => {
    server = new Server({ transport, gracefullyShutdown: false, greet: false } as ConstructorParameters<typeof Server>[0]);
    server.define('duo', DuoRoom, { graceSeconds: 1, tickMs: 50 });
    await server.listen(0, '127.0.0.1');
    const address = (transport as unknown as { server: { address(): AddressInfo } }).server.address();
    endpoint = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await server.gracefullyShutdown(false); });

  function track(room: Room): Received[] {
    const events: Received[] = [];
    room.onMessage('event', (event: Received) => { events.push(event); });
    room.onMessage('ack', () => {});
    return events;
  }
  async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    for (let waited = 0; !predicate(); waited += 10) {
      if (waited > timeoutMs) throw new Error('timeout');
      await delay(10);
    }
  }
  function serverRoom(roomId: string): DuoRoom {
    const room = matchMaker.getLocalRoomById(roomId) as ServerRoom | undefined;
    if (!room) throw new Error('room not found');
    return room as unknown as DuoRoom;
  }
  /** Network loss: the server-side socket dies without a consented leave. */
  function dropTransport(room: DuoRoom, sessionId: string): void {
    const client = room.clients.find((c) => c.sessionId === sessionId);
    (client?.ref as unknown as { terminate(): void } | undefined)?.terminate();
  }

  it('keeps ticking while a client is dropped, reconnects with state, but missed broadcasts are lost', async () => {
    const a = await new Client(endpoint).create('duo');
    const b = await new Client(endpoint).joinById(a.roomId);
    a.reconnection.enabled = false; // reconnect explicitly with the token to observe the semantics
    const eventsA = track(a); const eventsB = track(b);
    const room = serverRoom(a.roomId);
    const commandId = 'engage-1';
    a.send('command', { commandId, type: 'engage' });
    await until(() => room.state.tick >= 2);
    const tokenA = a.reconnectionToken;
    const lastSeenByA = eventsA.at(-1)?.seq ?? 0;
    dropTransport(room, a.sessionId);
    await until(() => room.statuses.get(a.sessionId) === 'disconnected');
    const tickAtDrop = room.state.tick;
    await delay(300);
    expect(room.state.tick).toBeGreaterThan(tickAtDrop); // no pause exploit
    const a2 = await new Client(endpoint).reconnect(tokenA);
    const eventsA2 = track(a2);
    await until(() => a2.state !== undefined && (a2.state as { tick: number }).tick > 0);
    expect(room.statuses.get(a2.sessionId)).toBe('connected');
    expect(a2.sessionId).toBe(a.sessionId);
    // State is re-synced in full, but broadcast events emitted while A was away are not replayed.
    await until(() => eventsA2.length > 0);
    const firstAfter = eventsA2[0]?.seq ?? 0;
    expect(firstAfter - lastSeenByA).toBeGreaterThan(1);
    // command_id dedupe only exists because the room implements it (in memory; lost on crash).
    const acks: unknown[] = [];
    a2.onMessage('ack', (ack: unknown) => { acks.push(ack); });
    a2.send('command', { commandId, type: 'engage' });
    await until(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ duplicate: true });
    expect(eventsB.length).toBeGreaterThan(0);
    await a2.leave(); await b.leave();
  });

  it('marks a participant left after the reconnection grace while the other keeps playing', async () => {
    const a = await new Client(endpoint).create('duo');
    const b = await new Client(endpoint).joinById(a.roomId);
    a.reconnection.enabled = false;
    track(a); track(b);
    const room = serverRoom(a.roomId);
    dropTransport(room, a.sessionId);
    await until(() => room.statuses.get(a.sessionId) === 'left', 4000);
    expect(room.statuses.get(b.sessionId)).toBe('connected');
    await expect(new Client(endpoint).reconnect(a.reconnectionToken)).rejects.toThrow();
    await b.leave();
  });
});
