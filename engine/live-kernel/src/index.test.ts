import { describe, expect, it } from 'vitest';

import { ActivityConflictError, HostError, InstanceHost, LIVE_KERNEL_PACKAGE, LiveEffectRejectedError, MemoryInstanceStore } from './index.ts';
import type { HostMessage, InstanceLease, JsonValue, LiveConnection, LiveGame, LiveStep } from './index.ts';

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
    if (op === 'finish' && state.ticksLeft === 0) {
      return { state, effects: [{ finished: state.counter }], close: { outcome: 'finished', result: { counter: state.counter } } };
    }
    // Durable record without an explicit checkpoint flag: effects alone force the write they commit with.
    if (op === 'record') return { state: { ...state, counter: state.counter + 1 }, effects: [{ recorded: state.counter + 1 }] };
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

class FailureStore extends MemoryInstanceStore {
  checkpointError: Error | null = null;
  closeError: Error | null = null;
  releaseError: Error | null = null;
  checkpointFenced = false;
  closeFenced = false;
  override async checkpoint(lease: InstanceLease, checkpoint: JsonValue, nowMs: number, effects: readonly JsonValue[] = []) {
    if (this.checkpointError) { const error = this.checkpointError; this.checkpointError = null; throw error; }
    if (this.checkpointFenced) { this.checkpointFenced = false; return null; }
    return super.checkpoint(lease, checkpoint, nowMs, effects);
  }
  override async close(lease: InstanceLease, input: Parameters<MemoryInstanceStore['close']>[1], nowMs: number) {
    if (this.closeError) { const error = this.closeError; this.closeError = null; throw error; }
    if (this.closeFenced) { this.closeFenced = false; return false; }
    return super.close(lease, input, nowMs);
  }
  override async releaseParticipant(lease: InstanceLease, actorId: string, checkpoint: JsonValue, nowMs: number,
    effects: readonly JsonValue[] = []) {
    if (this.releaseError) { const error = this.releaseError; this.releaseError = null; throw error; }
    return super.releaseParticipant(lease, actorId, checkpoint, nowMs, effects);
  }
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

  it('separates preparation, durable create, and idempotent post-commit adoption', async () => {
    const { host, store } = setup();
    const prepared = host.prepareCreate({ participants: [A], setup: null });
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(host.has(prepared.input.instanceId)).toBe(false);
    expect(store.rows.has(prepared.input.instanceId)).toBe(false);
    const lease = await store.create(prepared.input);
    expect(host.adoptCreated(prepared, lease)).toBe(prepared.input.instanceId);
    expect(host.has(prepared.input.instanceId)).toBe(true);
    expect(host.adoptCreated(prepared, lease)).toBe(prepared.input.instanceId);
    expect(host.inspect(prepared.input.instanceId)?.state).toMatchObject({ counter: 0 });
    expect(() => host.adoptCreated(prepared, { ...lease, generation: 2 })).toThrow('prepared instance lease mismatch');
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

  it('publishes a fresh owner view after each authoritative tick', async () => {
    const { host, clock } = setup();
    const id = await host.create({ participants: [A], setup: null });
    const client = connection('view-client');
    await host.attach(id, A.actorId, A.accountId, client);
    await host.submit(id, A.actorId, A.accountId, 'run-view', { op: 'run', ticks: 2 });
    clock.now += 500; await host.pump();
    const views = client.messages.filter((message) => message.type === 'live.snapshot');
    expect(views.at(-1)).toMatchObject({ type: 'live.snapshot', instanceId: id, seq: host.inspect(id)?.seq, view: { counter: 10, ticksLeft: 1 } });
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

  it('preserves previously persisted command dedupe through a tick checkpoint', async () => {
    const { host, store, clock } = setup();
    const id = await host.create({ participants: [A], setup: null });
    await host.attach(id, A.actorId, A.accountId, connection('c1'));
    await host.submit(id, A.actorId, A.accountId, 'run-1', { op: 'run', ticks: 1 });
    clock.now += 500;
    await host.pump();
    expect(host.inspect(id)?.state.counter).toBe(10);
    host.abandonForTesting();
    clock.now += 30_001;
    const other = setup(store, clock, 'node-2').host;
    expect(await other.recover(id)).toBe(true);
    await other.attach(id, A.actorId, A.accountId, connection('c2'));
    expect(await other.submit(id, A.actorId, A.accountId, 'run-1', { op: 'run', ticks: 1 }))
      .toEqual({ ack: { status: 'applied' }, duplicate: true });
    expect(other.inspect(id)?.state.counter).toBe(10);
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

  it('passes the attaching actor to snapshot projection without persisting viewer-private fields', async () => {
    const store = new MemoryInstanceStore();
    const clock = new TestClock();
    const viewerGame: LiveGame<CounterState> = {
      ...counterGame,
      view(state, viewerActorId) {
        return { counter: state.counter, corpseHotspots: viewerActorId === A.actorId ? [{ id: 'corpse-1', ownerHint: 'private' }] : [] };
      },
    };
    const host = new InstanceHost({ game: viewerGame, store, clock, nodeId: 'node-1', contentHash: 'c'.repeat(64),
      leaseMs: 30_000, graceMs: 60_000, seed: () => 7 });
    const id = await host.create({ participants: [A, B], setup: null });
    const a = connection('a1');
    const b = connection('b1');
    await host.attach(id, A.actorId, A.accountId, a);
    await host.attach(id, B.actorId, B.accountId, b);
    expect(a.messages[0]).toMatchObject({ type: 'live.snapshot', view: { corpseHotspots: [{ id: 'corpse-1', ownerHint: 'private' }] } });
    expect(b.messages[0]).toMatchObject({ type: 'live.snapshot', view: { corpseHotspots: [] } });
    const checkpoint = store.rows.get(id)?.record.checkpoint;
    expect(store.rows.get(id)?.checkpointSeq).toBe(0);
    expect(JSON.stringify(checkpoint)).not.toContain('corpseHotspots');
    expect(JSON.stringify(checkpoint)).not.toContain('ownerHint');
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
    expect(await fresh.submit(id, A.actorId, A.accountId, 'f', { op: 'finish' }))
      .toEqual({ ack: { status: 'applied' }, duplicate: false });
    expect(fresh.has(id)).toBe(false);
    expect(store.closes).toHaveLength(1);
    expect(await stale.recover(id)).toBe(false);
  });

  it('commits step effects with the checkpoint or close they belong to, never with a fenced-out write', async () => {
    const { host, store, clock } = setup();
    const id = await host.create({ participants: [A], setup: null });
    await host.attach(id, A.actorId, A.accountId, connection('a1'));
    await host.submit(id, A.actorId, A.accountId, 'r1', { op: 'record' });
    expect(store.effects).toEqual([{ instanceId: id, effect: { recorded: 1 } }]);
    expect(store.rows.get(id)?.checkpointSeq).toBe(1); // effects alone forced a checkpoint
    expect(store.rows.get(id)?.record.checkpoint).toMatchObject({ state: { counter: 1 } });
    clock.now += 30_001; // lease lost: the next write is fenced out, so its effect must not be committed
    const fresh = setup(store, clock, 'node-2').host;
    expect(await fresh.recover(id)).toBe(true);
    await expect(host.submit(id, A.actorId, A.accountId, 'r2', { op: 'record' })).rejects.toBeInstanceOf(HostError);
    expect(store.effects).toHaveLength(1);
    await fresh.attach(id, A.actorId, A.accountId, connection('a2'));
    await fresh.submit(id, A.actorId, A.accountId, 'f', { op: 'finish' });
    expect(store.effects.at(-1)).toEqual({ instanceId: id, effect: { finished: 1 } });
    expect(store.closes).toHaveLength(1);
  });

  it('turns an effect transaction rejection into a rejected ACK without publishing or applying its command', async () => {
    const store = new FailureStore();
    const { host } = setup(store);
    const id = await host.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    const seq = host.inspect(id)?.seq;
    store.checkpointError = new LiveEffectRejectedError('corpse_unavailable');
    const rejected = await host.submit(id, A.actorId, A.accountId, 'loot-1', { op: 'record' });
    expect(rejected).toEqual({ ack: { status: 'rejected', reason: 'corpse_unavailable' }, duplicate: false });
    expect(host.inspect(id)).toMatchObject({ state: { counter: 0 }, seq });
    expect(conn.messages.filter((message) => message.type === 'live.event' && message.source === 'game')).toHaveLength(0);
    expect(store.rows.get(id)?.checkpointSeq).toBe(0);
    expect(await host.submit(id, A.actorId, A.accountId, 'loot-1', { op: 'record' })).toEqual({ ...rejected, duplicate: true });
    expect(await host.submit(id, A.actorId, A.accountId, 'loot-2', { op: 'record' })).toEqual({ ack: { status: 'applied' }, duplicate: false });
    expect(host.inspect(id)?.state.counter).toBe(1);
    expect(store.effects).toEqual([{ instanceId: id, effect: { recorded: 1 } }]);
  });

  it('evicts after an ambiguous checkpoint failure without caching an applied command or exposing candidate events', async () => {
    const store = new FailureStore();
    const { host } = setup(store);
    const id = await host.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    store.checkpointError = new Error('database unavailable');
    await expect(host.submit(id, A.actorId, A.accountId, 'add-1', { op: 'add' })).rejects.toThrow('database unavailable');
    expect(host.has(id)).toBe(false);
    expect(conn.messages.filter((message) => message.type === 'live.event' && message.source === 'game')).toHaveLength(0);
    expect(store.rows.get(id)?.checkpointSeq).toBe(0);
  });

  it('returns no applied ACK when a checkpoint or close write reports lost fencing', async () => {
    const checkpointStore = new FailureStore();
    const checkpointHost = setup(checkpointStore).host;
    const checkpointId = await checkpointHost.create({ participants: [A], setup: null });
    const checkpointConn = connection('checkpoint');
    await checkpointHost.attach(checkpointId, A.actorId, A.accountId, checkpointConn);
    checkpointStore.checkpointFenced = true;
    await expect(checkpointHost.submit(checkpointId, A.actorId, A.accountId, 'fenced-add', { op: 'add' }))
      .rejects.toBeInstanceOf(HostError);
    expect(checkpointHost.has(checkpointId)).toBe(false);
    expect(checkpointConn.messages.filter((message) => message.type === 'live.event' && message.source === 'game')).toHaveLength(0);

    const closeStore = new FailureStore();
    const closeHost = setup(closeStore).host;
    const closeId = await closeHost.create({ participants: [A], setup: null });
    const closeConn = connection('close');
    await closeHost.attach(closeId, A.actorId, A.accountId, closeConn);
    closeStore.closeFenced = true;
    await expect(closeHost.submit(closeId, A.actorId, A.accountId, 'fenced-close', { op: 'finish' }))
      .rejects.toBeInstanceOf(HostError);
    expect(closeHost.has(closeId)).toBe(false);
    expect(closeConn.messages.some((message) => message.type === 'live.closed')).toBe(false);
  });

  it('does not publish close events or closed notices before the close transaction succeeds', async () => {
    const store = new FailureStore();
    const { host } = setup(store);
    const id = await host.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    store.closeError = new Error('close failed');
    await expect(host.submit(id, A.actorId, A.accountId, 'finish-1', { op: 'finish' })).rejects.toThrow('close failed');
    expect(conn.messages.filter((message) => message.type === 'live.event' && message.source === 'game')).toHaveLength(0);
    expect(conn.messages.some((message) => message.type === 'live.closed')).toBe(false);
    expect(store.closes).toHaveLength(0);
  });

  it('retries a rejected tick effect from the prior state without publishing its event early', async () => {
    const store = new FailureStore();
    const clock = new TestClock();
    const effectTickGame: LiveGame<CounterState> = {
      ...counterGame,
      tick(state) {
        const next = { ...state, counter: state.counter + 1, ticksLeft: state.ticksLeft - 1 };
        return { state: next, events: [{ tick: next.counter }], effects: [{ ticked: next.counter }], checkpoint: true };
      },
    };
    const host = new InstanceHost({ game: effectTickGame, store, clock, nodeId: 'node-1', contentHash: 'c'.repeat(64),
      leaseMs: 30_000, graceMs: 60_000, seed: () => 7 });
    const id = await host.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    await host.submit(id, A.actorId, A.accountId, 'run-1', { op: 'run', ticks: 1 });
    store.checkpointError = new LiveEffectRejectedError('effect_conflict');
    clock.now += 500;
    await host.pump();
    expect(host.inspect(id)).toMatchObject({ state: { counter: 0, ticksLeft: 1 } });
    expect(conn.messages.filter((message) => message.type === 'live.event' && message.source === 'game' && JSON.stringify(message.event).includes('tick'))).toHaveLength(0);
    await host.pump();
    expect(host.inspect(id)).toMatchObject({ state: { counter: 1, ticksLeft: 0 } });
    expect(store.effects).toEqual([{ instanceId: id, effect: { ticked: 1 } }]);
  });

  it('does not publish participant departure when a release transaction fails', async () => {
    const store = new FailureStore();
    const { host, clock } = setup(store);
    const id = await host.create({ participants: [A, B], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    await host.attach(id, B.actorId, B.accountId, connection('b1'));
    await host.detach(id, A.actorId, 'a1');
    clock.now += 60_001;
    store.releaseError = new Error('release failed');
    await host.pump();
    expect(host.has(id)).toBe(false);
    expect(store.activities.get(A.actorId)).toBe(id);
    expect(conn.messages.some((message) => message.type === 'live.event' && JSON.stringify(message.event).includes('"status":"left"'))).toBe(false);
  });

  it('retries a closing participant removal as the original close transaction', async () => {
    const store = new FailureStore();
    const clock = new TestClock();
    const removingGame: LiveGame<CounterState> = {
      ...counterGame,
      removeParticipant(state, actorId) {
        return { state: { ...state, members: state.members.filter((member) => member !== actorId) },
          events: [{ removed: actorId }], effects: [{ removed: actorId }],
          close: { outcome: 'participant_removed', result: { actorId } } };
      },
    };
    const host = new InstanceHost({ game: removingGame, store, clock, nodeId: 'node-1', contentHash: 'c'.repeat(64),
      leaseMs: 120_000, graceMs: 60_000, seed: () => 7 });
    const id = await host.create({ participants: [A], setup: null });
    const conn = connection('a1');
    await host.attach(id, A.actorId, A.accountId, conn);
    await host.detach(id, A.actorId, 'a1');
    clock.now += 60_001;
    store.closeError = new LiveEffectRejectedError('close_effect_rejected');
    await host.pump();
    expect(host.has(id)).toBe(true);
    expect(store.closes).toHaveLength(0);
    expect(conn.messages.some((message) => message.type === 'live.event' && JSON.stringify(message.event).includes('removed'))).toBe(false);
    await host.pump();
    expect(store.closes).toEqual([{ instanceId: id, outcome: 'participant_removed', result: { actorId: A.actorId } }]);
    expect(store.effects).toEqual([{ instanceId: id, effect: { removed: A.actorId } }]);
    expect(host.has(id)).toBe(false);
  });
});
