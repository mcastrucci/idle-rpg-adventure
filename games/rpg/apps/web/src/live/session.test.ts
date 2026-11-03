import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketLike } from './client.ts';
import { LiveClient } from './client.ts';
import { LiveSession } from './session.ts';

const actorId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  authenticate(): void { this.readyState = 1; this.receive({ type: 'authenticated', accountId: actorId }); }
  receive(frame: unknown): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  drop(): void { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code: 1006 })); }
}

describe('LiveSession over the authenticated LiveClient socket', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('attaches when created around an already authenticated shared client', async () => {
    const sockets: Socket[] = [];
    const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    client.start(); await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]; if (!socket) throw new Error('missing socket');
    socket.authenticate();
    const session = new LiveSession({ client, instanceId, actorId });
    session.start();
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ type: 'command', command: { op: 'live.attach', instanceId, actorId } });
    session.dispose(); client.stop();
  });

  it('resyncs before the bounded event buffer can detach deltas from their snapshot baseline', async () => {
    const sockets: Socket[] = [];
    const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    const session = new LiveSession({ client, instanceId, actorId });
    client.start(); await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]; if (!socket) throw new Error('missing socket');
    socket.authenticate();
    socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 0, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    socket.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    for (let seq = 1; seq <= 256; seq++) socket.receive({ type: 'live.event', instanceId, epoch: 1, seq, source: 'game', event: { type: 'traveled' } });
    expect(session.state).toMatchObject({ baselineSeq: 0, seq: 256, events: { length: 256 } });
    socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 257, source: 'game', event: { type: 'traveled' } });
    expect(JSON.parse(socket.sent.at(-1) ?? '{}').command.resume).toBeUndefined();
    socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 257, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    expect(session.state).toMatchObject({ baselineSeq: 257, seq: 257, events: [] });
    for (let seq = 258; seq <= 300; seq++) {
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq, source: 'game', event: { type: 'traveled' } });
      socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    }
    expect(session.state.recentEvents).toHaveLength(256);
    expect(session.state.recentEvents[0]).toMatchObject({ epoch: 1, seq: 44 });
    expect(session.state.recentEvents.at(-1)).toMatchObject({ epoch: 1, seq: 300 });
    session.dispose(); client.stop();
  });

  it('preserves accepted event history when a same-epoch authoritative snapshot clears deltas', async () => {
    const sockets: Socket[] = [];
    const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    const session = new LiveSession({ client, instanceId, actorId });
    client.start(); await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]; if (!socket) throw new Error('missing socket');
    socket.authenticate();
    socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 0, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    socket.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    const warning = { type: 'bossRoomWarning', exitId: 'exit:boss', risk: {
      locationId: 'location:boss', enemies: [{ enemy: 'enemy:warden', rank: 'boss', level: 5 }],
      heroes: [{ actorId, hp: 20, maxHp: 30, healingConsumables: 1 }], retreatAllowed: false,
      onDeath: ['live.death.run_bag_to_corpse', 'live.death.xp_penalty'], deathConsequences: [],
    } };
    socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 1, source: 'game', event: warning });
    socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 2, view: { phase: 'combat' }, participants: [{ actorId, status: 'connected' }] });
    expect(session.state).toMatchObject({ baselineEpoch: 1, baselineSeq: 2, seq: 2, events: [], recentEvents: [
      { epoch: 1, seq: 1, source: 'game', event: warning },
    ] });

    socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 3, source: 'game', event: warning });
    socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 3, source: 'game', event: warning });
    expect(session.state.events.map(event => event.seq)).toEqual([3]);
    expect(session.state.recentEvents.map(event => event.seq)).toEqual([1, 3]);
    session.dispose(); client.stop();
  });

  it('reattaches after lease eviction, accepts a new epoch snapshot, and retains pending IDs and ACK reasons', async () => {
    const sockets: Socket[] = [];
    const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
      backoff: () => 100, pingIntervalMs: 60_000 });
    const session = new LiveSession({ client, instanceId, actorId, newId: () => commandId });
    client.start(); await vi.advanceTimersByTimeAsync(0);
    const first = sockets[0]; if (!first) throw new Error('missing first socket');
    first.authenticate();
    first.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 4, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    first.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    first.receive({ type: 'live.event', instanceId, epoch: 1, seq: 5, source: 'game', event: { type: 'traveled' } });
    session.submit({ type: 'engage', groupId: 'group:one' });
    first.receive({ type: 'live.evicted', instanceId, reason: 'lease_lost' });
    expect(session.state).toMatchObject({ attached: false, error: 'lease_lost', pendingCommandIds: [commandId], pendingCount: 1 });

    first.drop(); await vi.advanceTimersByTimeAsync(100); await vi.advanceTimersByTimeAsync(0);
    const second = sockets[1]; if (!second) throw new Error('missing reconnect socket');
    second.authenticate();
    expect(JSON.parse(second.sent[0] ?? '{}').command.resume).toEqual({ epoch: 1, seq: 5 });
    second.receive({ type: 'live.snapshot', instanceId, epoch: 2, seq: 1, view: { phase: 'combat' }, participants: [{ actorId, status: 'connected' }] });
    expect(session.state).toMatchObject({ baselineEpoch: 2, baselineSeq: 1, epoch: 2, seq: 1, events: [] });
    expect(session.state.recentEvents.map(event => [event.epoch, event.seq])).toEqual([[1, 5]]);
    second.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    expect(JSON.parse(second.sent.at(-1) ?? '{}').command.commandId).toBe(commandId);
    second.receive({ type: 'live.ack', instanceId, commandId, status: 'rejected', duplicate: false, reason: 'in_combat' });
    expect(session.state).toMatchObject({ pendingCount: 0, pendingCommandIds: [], lastAck: { commandId, status: 'rejected', reason: 'in_combat' } });
    session.dispose(); client.stop();
  });

  it('resumes from the last contiguous sequence and replays an ambiguous command with the same ID', async () => {
    const sockets: Socket[] = [];
    const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
      backoff: () => 100, pingIntervalMs: 60_000 });
    const session = new LiveSession({ client, instanceId, actorId, newId: () => commandId });
    session.start(); await vi.advanceTimersByTimeAsync(0);
    const first = sockets[0]; if (!first) throw new Error('missing first socket');
    first.authenticate();
    expect(JSON.parse(first.sent[0] ?? '{}')).toMatchObject({ command: { op: 'live.attach', instanceId, actorId } });
    first.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 4, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    first.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    expect(session.submit({ type: 'travel', exitId: 'exit:one' })).toBe(commandId);
    const firstCommand = JSON.parse(first.sent.at(-1) ?? '{}');
    expect(firstCommand.command.commandId).toBe(commandId);
    session.retryPending();
    expect(JSON.parse(first.sent.at(-1) ?? '{}').command.commandId).toBe(commandId);

    // Duplicate events are ignored, and a gap requests replay without resubmitting the action.
    first.receive({ type: 'live.event', instanceId, epoch: 1, seq: 5, source: 'game', event: { type: 'traveled' } });
    first.receive({ type: 'live.event', instanceId, epoch: 1, seq: 5, source: 'game', event: { type: 'traveled' } });
    expect(session.state.events).toHaveLength(1);
    first.receive({ type: 'live.event', instanceId, epoch: 1, seq: 7, source: 'game', event: { type: 'traveled' } });
    expect(JSON.parse(first.sent.at(-1) ?? '{}')).toMatchObject({ command: { op: 'live.attach', instanceId, actorId } });
    expect(JSON.parse(first.sent.at(-1) ?? '{}').command.resume).toBeUndefined();

    // The ack was ambiguous when the transport dropped. Reattach then replay the same logical command ID.
    first.drop(); await vi.advanceTimersByTimeAsync(100); await vi.advanceTimersByTimeAsync(0);
    const second = sockets[1]; if (!second) throw new Error('missing reconnect socket');
    second.authenticate();
    expect(JSON.parse(second.sent[0] ?? '{}')).toMatchObject({ command: { op: 'live.attach', resume: { epoch: 1, seq: 5 } } });
    second.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 6, view: { phase: 'exploring' }, participants: [{ actorId, status: 'connected' }] });
    expect(session.state.events).toEqual([]);
    second.receive({ type: 'live.attached', instanceId, mode: 'resume' });
    expect(JSON.parse(second.sent.at(-1) ?? '{}').command.commandId).toBe(commandId);
    second.receive({ type: 'live.ack', instanceId, commandId, status: 'applied', duplicate: true });
    expect(session.state.attached).toBe(true);
    second.receive({ type: 'live.closed', instanceId, outcome: 'returned', result: { area: 'area:test' } });
    expect(session.state.attached).toBe(false);
    expect(() => session.submit({ type: 'returnToSanctuary' })).toThrow('live instance is closed');
    session.dispose(); client.stop();
  });
});
