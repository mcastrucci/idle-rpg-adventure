import { describe, expect, it } from 'vitest';

import { ActivityConflictError, HostError, InstanceHost, LIVE_KERNEL_PACKAGE, MemoryInstanceStore } from './index.ts';
import type { HostMessage, JsonValue, LiveConnection, LiveGame, LiveStep } from './index.ts';

/** Minimal generic plugin: a counter that "ticks" down a timer phase. No game concepts. */
interface CounterState { counter: number; ticksLeft: number; members: string[]; log: number[] }
const counterGame: LiveGame<CounterState> = {
  id: 'test.counter', version: '1', tickIntervalMs: 500,
  init: ({ participants }) => ({ counter: 0, ticksLeft: 0, members: participants.map((p) => p.actorId), log: [] }),
  applyCommand(state, _actorId, command) {
    const op = (command as { op?: unknown } | null)?.op;
    if (op === 'add') return { state: { ...state, counter: state.counter + 1 }, events: [{ added: state.counter + 1 }], checkpoint: true };
    if (op === 'run' && state.ticksLeft === 0) {
      const ticks = (command as { ticks: number }).ticks;
      return { state: { ...state, ticksLeft: ticks }, events: [{ running: ticks }], checkpoint: true };
    }
    if (op === 'finish' && state.ticksLeft === 0) return { state, close: { outcome: 'finished', result: { counter: state.counter } } };
    return { rejected: 'invalid' };
  },
  tick(state): LiveStep<CounterState> {
    const ticksLeft = state.ticksLeft - 1;
    const next = { ...state, ticksLeft, counter: state.counter + 10, log: [...state.log, state.counter + 10] };
    return { state: next, events: [{ tick: next.counter }], checkpoint: ticksLeft === 0 };
  },
  isTicking: (state) => state.ticksLeft > 0,
  removeParticipant(state, actorId) {
    if (state.ticksLeft > 0) return null;
    return { state: { ...state, members: state.members.filter((m) => m !== actorId) } };
  },
  serialize: (state) => state as unknown as JsonValue,
  restore: (checkpoint) => structuredClone(checkpoint) as unknown as CounterState,
  view: (state) => ({ counter: state.counter, ticksLeft: state.ticksLeft }),
};

class TestClock { now = 1_000_000; nowMs(): number { return this.now; } }
function connection(id: string): LiveConnection & { messages: HostMessage[] } {
  const messages: HostMessage[] = [];
  return { id, messages, push: (message) => { messages.push(message); } };
}
const A = { actorId: '00000000-0000-4000-8000-00000000000a', accountId: 'acc-a' };
const B = { actorId: '00000000-0000-4000-8000-00000000000b', accountId: 'acc-b' };

function setup(store = new MemoryInstanceStore(), clock = new TestClock(), nodeId = 'node-1') {
  const host = new InstanceHost({ game: counterGame, store, clock, nodeId, contentHash: 'c'.repeat(64), leaseMs: 30_000, graceMs: 60_000, seed: () => 7 });
  return { host, store, clock };
}

describe('@engine/live-kernel InstanceHost', () => {
  it('exports its package name', () => {
    expect(LIVE_KERNEL_PACKAGE).toBe('@engine/live-kernel');
  });

  it('locks participants on create and rejects a second instance for a busy participant', async () => {
    const { host, store } = setup();
    const id = await host.create({ participants: [B, A], setup: null });
    expect(store.activities.get(A.actorId)).toBe(id);
    expect(store.activities.get(B.actorId)).toBe(id);
    await expect(host.create({ participants: [A], setup: null })).rejects.toBeInstanceOf(ActivityConflictError);
  });

  it('ticks only while the game is ticking, on a drift-free schedule, with bounded catch-up', async () => {
    const { host, clock } = setup();
    const id = await host.create({ participants: [A], setup: null });
    await host.attach(id, A.actorId, A.accountId, connection('c1'));
    clock.now += 5_000; await host.pump();
    expect(host.stats.ticks).toBe(0);
    await host.submit(id, A.actorId, A.accountId, 'cmd-1', { op: 'run', ticks: 100 });
    const start = clock.now;
    // Irregular wake-ups: due ticks are start+500·k regardless of when the pump runs.
    for (const step of [499, 2, 740, 1, 1258]) { clock.now += step; await host.pump(); }
    expect(host.stats.ticks).toBe(Math.floor((clock.now - start) / 500));
    // A long stall runs at most maxCatchUpTicks and skips the rest instead of bursting.
    clock.now += 20_000; await host.pump();
    expect(host.stats.skippedTicks).toBeGreaterThan(0);
    const ticks = host.stats.ticks;
    clock.now += 500; await host.pump();
    expect(host.stats.ticks).toBe(ticks + 1);
  });

  it('applies a replayed command_id once, including after a crash restore', async () => {
    const { host, store, clock } = setup();
    const id = await host.create({ participants: [A], setup: null });
    await host.attach(id, A.actorId, A.accountId, connection('c1'));
    const first = await host.submit(id, A.actorId, A.accountId, 'cmd-add', { op: 'add' });
    const replay = await host.submit(id, A.actorId, A.accountId, 'cmd-add', { op: 'add' });
    expect(first).toEqual({ ack: { status: 'applied' }, duplicate: false });
    expect(replay).toEqual({ ack: { status: 'applied' }, duplicate: true });
    expect(host.inspect(id)?.state.counter).toBe(1);
    host.abandonForTesting();
    clock.now += 30_001;
    const other = setup(store, clock, 'node-2').host;
    expect(await other.recover(id)).toBe(true);
    await other.attach(id, A.actorId, A.accountId, connection('c2'));
    expect((await other.submit(id, A.actorId, A.accountId, 'cmd-add', { op: 'add' })).duplicate).toBe(true);
    expect(other.inspect(id)?.state.counter).toBe(1);
  });

  it('resumes with exactly the missed events, and falls back to a snapshot after a restore (new epoch)', async () => {
    const { host, store, clock } = setup();
    const id = await host.create({ participants: [A, B], setup: null });
    const a = connection('a1');
    await host.attach(id, A.actorId, A.accountId, a);
    await host.attach(id, B.actorId, B.accountId, connection('b1'));
    await host.submit(id, A.actorId, A.accountId, 'c1', { op: 'add' });
    const seen = host.inspect(id)?.seq ?? 0;
    await host.detach(id, A.actorId, 'a1');
    await host.submit(id, B.actorId, B.accountId, 'c2', { op: 'add' });
    await host.submit(id, B.actorId, B.accountId, 'c3', { op: 'add' });
    const a2 = connection('a2');
    expect(await host.attach(id, A.actorId, A.accountId, a2, { epoch: 1, seq: seen })).toEqual({ mode: 'resume' });
    const seqs = a2.messages.map((m) => (m.type === 'live.event' ? m.seq : -1));
    expect(seqs[0]).toBe(seen + 1);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    host.abandonForTesting(); clock.now += 30_001;
    const node2 = setup(store, clock, 'node-2').host;
    await node2.recover(id);
    const a3 = connection('a3');
    expect(await node2.attach(id, A.actorId, A.accountId, a3, { epoch: 1, seq: seen })).toEqual({ mode: 'snapshot' });
    expect(a3.messages[0]).toMatchObject({ type: 'live.snapshot', epoch: 2, view: { counter: 3 } });
  });

  it('keeps ticking while disconnected, defers leaving until the ticking phase ends, then releases the lock', async () => {
    const { host, store, clock } = setup();
    const id = await host.create({ participants: [A, B], setup: null });
    await host.attach(id, A.actorId, A.accountId, connection('a1'));
    await host.attach(id, B.actorId, B.accountId, connection('b1'));
    await host.submit(id, A.actorId, A.accountId, 'run', { op: 'run', ticks: 130 });
    await host.detach(id, A.actorId, 'a1');
    for (let i = 0; i < 120; i += 1) { clock.now += 500; await host.pump(); } // 60 s grace elapsed while ticking
    expect(host.inspect(id)?.participants).toContainEqual({ actorId: A.actorId, status: 'leaving' });
    expect(store.activities.has(A.actorId)).toBe(true);
    await expect(host.submit(id, A.actorId, A.accountId, 'late', { op: 'add' })).rejects.toMatchObject({ code: 'participant_left' });
    for (let i = 0; i < 12; i += 1) { clock.now += 500; await host.pump(); }
    expect(host.inspect(id)?.ticking).toBe(false);
    expect(host.inspect(id)?.state.counter).toBe(1300);
    expect(host.inspect(id)?.participants).toContainEqual({ actorId: A.actorId, status: 'left' });
    expect(store.activities.has(A.actorId)).toBe(false);
    expect(store.activities.get(B.actorId)).toBe(id);
    await host.detach(id, B.actorId, 'b1');
    for (let i = 0; i < 6; i += 1) { clock.now += 10_000; await host.pump(); } // pumps keep renewing the lease
    expect(host.has(id)).toBe(false);
    expect(store.closes).toEqual([{ instanceId: id, outcome: 'abandoned', result: null }]);
    expect(store.activities.size).toBe(0);
  });

  it('fences a stale node: after another node restores, its writes fail and it evicts the instance', async () => {
    const { host: stale, store, clock } = setup();
    const id = await stale.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await stale.attach(id, A.actorId, A.accountId, conn);
    clock.now += 30_001; // stale node paused past its lease (no renewal)
    const fresh = setup(store, clock, 'node-2').host;
    expect(await fresh.recover(id)).toBe(true);
    await expect(stale.submit(id, A.actorId, A.accountId, 'x', { op: 'add' })).rejects.toBeInstanceOf(HostError);
    expect(stale.has(id)).toBe(false);
    expect(conn.messages.at(-1)).toMatchObject({ type: 'live.evicted', reason: 'lease_lost' });
    await fresh.attach(id, A.actorId, A.accountId, connection('a2'));
    await fresh.submit(id, A.actorId, A.accountId, 'f', { op: 'finish' });
    expect(store.closes).toHaveLength(1);
    expect(await stale.recover(id)).toBe(false);
  });
});
