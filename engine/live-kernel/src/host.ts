import { randomInt, randomUUID } from 'node:crypto';

import { IncompatibleInstanceError, LiveEffectRejectedError } from './types.ts';
import type {
  CommandAck, HostMessage, InstanceLease, InstanceRecord, InstanceStore, JsonValue, LiveClock, LiveConnection, LiveGame,
  LiveParticipant, LiveStep, ParticipantStatus, ParticipantView, SubmitResult,
} from './types.ts';

/** Provisional values (open decision #5, ADR-0012); every one is configurable per host. */
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_GRACE_MS = 60_000;
export const DEFAULT_MAX_CATCH_UP_TICKS = 20;
export const DEFAULT_EVENT_BUFFER = 512;
export const DEFAULT_COMMAND_MEMORY = 256;
const CHECKPOINT_FORMAT = 1;

export type HostErrorCode = 'not_hosted' | 'not_participant' | 'not_attached' | 'participant_left' | 'invalid_command_id';
export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode) { super(code); this.code = code; this.name = 'HostError'; }
}

export interface HostTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
const NODE_TIMERS: HostTimers = {
  set: (callback, delayMs) => { const handle = setTimeout(callback, delayMs); handle.unref(); return handle; },
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export interface InstanceHostOptions<S> {
  readonly game: LiveGame<S>;
  readonly store: InstanceStore;
  /** Injected wall time (server-kit `Clock`); tests use a manual clock and call {@link InstanceHost.pump}. */
  readonly clock: LiveClock;
  /** Unique per process; stored as the lease owner. */
  readonly nodeId: string;
  /** Content version recorded with each instance; restores require the same hash. */
  readonly contentHash: string;
  readonly leaseMs?: number;
  /** Lease renewal period (default a third of the lease). */
  readonly renewEveryMs?: number;
  readonly graceMs?: number;
  /** Ticks run per pump when a host falls behind; beyond this the schedule skips ahead instead of bursting. */
  readonly maxCatchUpTicks?: number;
  readonly eventBuffer?: number;
  readonly commandMemory?: number;
  readonly timers?: HostTimers;
  /** Root seed source (default CSPRNG). */
  readonly seed?: () => number;
  readonly onError?: (error: unknown, instanceId: string) => void;
}

interface ParticipantRuntime {
  readonly accountId: string;
  status: ParticipantStatus;
  /** When the reconnection grace ends (status `disconnected`). */
  deadline: number | null;
  connection: LiveConnection | null;
}

interface Hosted<S> {
  lease: InstanceLease;
  leaseExpiresAt: number;
  renewAt: number;
  state: S;
  /** Event stream epoch = lease generation; a restore starts a new epoch so clients resync with a snapshot. */
  readonly epoch: number;
  seq: number;
  readonly buffer: { seq: number; source: 'game' | 'host'; event: JsonValue }[];
  /** `${actorId}:${commandId}` → ack, insertion-ordered and bounded; persisted with checkpoints. */
  readonly commands: Map<string, CommandAck>;
  readonly participants: Map<string, ParticipantRuntime>;
  nextTickAt: number | null;
  queue: Promise<void>;
  gone: boolean;
}

interface CheckpointPayload {
  readonly format: number;
  readonly seq: number;
  readonly state: JsonValue;
  readonly commands: readonly (readonly [string, CommandAck])[];
}

export interface HostStats { ticks: number; skippedTicks: number; evictions: number }

export interface InstanceInspection<S> {
  readonly state: S;
  readonly lease: InstanceLease;
  readonly epoch: number;
  readonly seq: number;
  readonly ticking: boolean;
  readonly participants: readonly ParticipantView[];
}

/**
 * In-memory owner of live instances on one node. Each instance's commands, ticks, grace handling and persistence run
 * strictly serialized on its own queue. Persistence goes through the fenced {@link InstanceStore}; losing a fenced write
 * evicts the instance from this node immediately (another node owns it now).
 */
export class InstanceHost<S> {
  readonly nodeId: string;
  readonly stats: HostStats = { ticks: 0, skippedTicks: 0, evictions: 0 };
  readonly #game: LiveGame<S>;
  readonly #store: InstanceStore;
  readonly #clock: LiveClock;
  readonly #contentHash: string;
  readonly #leaseMs: number;
  readonly #renewEveryMs: number;
  readonly #graceMs: number;
  readonly #maxCatchUp: number;
  readonly #eventBuffer: number;
  readonly #commandMemory: number;
  readonly #timers: HostTimers;
  readonly #seed: () => number;
  readonly #onError: (error: unknown, instanceId: string) => void;
  readonly #instances = new Map<string, Hosted<S>>();
  #timer: unknown = null;
  #running = false;

  constructor(options: InstanceHostOptions<S>) {
    this.#game = options.game; this.#store = options.store; this.#clock = options.clock; this.nodeId = options.nodeId;
    this.#contentHash = options.contentHash;
    this.#leaseMs = positive(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs');
    this.#renewEveryMs = positive(options.renewEveryMs ?? Math.floor(this.#leaseMs / 3), 'renewEveryMs');
    if (this.#renewEveryMs >= this.#leaseMs) throw new RangeError('lease renewal must be shorter than the lease');
    this.#graceMs = positive(options.graceMs ?? DEFAULT_GRACE_MS, 'graceMs');
    this.#maxCatchUp = positive(options.maxCatchUpTicks ?? DEFAULT_MAX_CATCH_UP_TICKS, 'maxCatchUpTicks');
    this.#eventBuffer = positive(options.eventBuffer ?? DEFAULT_EVENT_BUFFER, 'eventBuffer');
    this.#commandMemory = positive(options.commandMemory ?? DEFAULT_COMMAND_MEMORY, 'commandMemory');
    positive(this.#game.tickIntervalMs, 'tickIntervalMs');
    this.#timers = options.timers ?? NODE_TIMERS;
    this.#seed = options.seed ?? (() => randomInt(0, 0xffffffff));
    this.#onError = options.onError ?? (() => {});
  }

  /** Creates an instance: participants' activity CAS `none → live`, initial checkpoint and lease in one transaction. */
  async create(input: { readonly participants: readonly LiveParticipant[]; readonly setup: JsonValue }): Promise<string> {
    if (input.participants.length === 0) throw new RangeError('an instance needs participants');
    const instanceId = randomUUID();
    const state = this.#game.init({ instanceId, participants: input.participants, seed: this.#seed(), setup: input.setup });
    const now = this.#clock.nowMs();
    const commands = new Map<string, CommandAck>();
    const lease = await this.#store.create({ instanceId, gameId: this.#game.id, gameVersion: this.#game.version,
      contentHash: this.#contentHash, participants: input.participants.map((p) => ({ ...p, left: false })),
      checkpoint: this.#payload(state, 0, commands), nodeId: this.nodeId, nowMs: now, leaseMs: this.#leaseMs });
    const hosted = this.#host(lease, state, 0, commands, input.participants.map((p) => ({ ...p, left: false })), now);
    this.#schedule(hosted);
    return instanceId;
  }

  /** Crash recovery: claims an instance whose lease expired and restores it from its last checkpoint. */
  async recover(instanceId: string): Promise<boolean> {
    if (this.#instances.has(instanceId)) return true;
    const now = this.#clock.nowMs();
    const claimed = await this.#store.claim(instanceId, this.nodeId, now, this.#leaseMs);
    if (!claimed) return false;
    const { lease, record } = claimed;
    if (record.gameId !== this.#game.id || record.gameVersion !== this.#game.version || record.contentHash !== this.#contentHash) {
      await this.#store.relinquish(lease, now);
      throw new IncompatibleInstanceError(`instance ${instanceId} was created by ${record.gameId}@${record.gameVersion}/${record.contentHash}`);
    }
    this.#restore(lease, record, now);
    return true;
  }

  /** Recovery sweep (e.g. a periodic job on every live node): claims expired instances up to `limit`. */
  async recoverExpired(limit = 10): Promise<string[]> {
    const recovered: string[] = [];
    for (const instanceId of await this.#store.findExpired(this.#clock.nowMs(), limit)) {
      try { if (await this.recover(instanceId)) recovered.push(instanceId); }
      catch (error) { this.#onError(error, instanceId); }
    }
    return recovered;
  }

  has(instanceId: string): boolean { return this.#instances.has(instanceId); }
  instanceIds(): string[] { return [...this.#instances.keys()]; }

  /** Account that may control `actorId` in a hosted instance, if any (transport authorization). */
  participantAccount(instanceId: string, actorId: string): string | null {
    return this.#instances.get(instanceId)?.participants.get(actorId)?.accountId ?? null;
  }

  /**
   * Binds a transport connection to a participant. Without `resume` (or when the requested events are no longer
   * buffered / the epoch changed after a restore) the connection receives a snapshot; otherwise exactly the missed
   * events. The previous connection of that participant, if any, is replaced.
   */
  async attach(instanceId: string, actorId: string, accountId: string, connection: LiveConnection,
    resume?: { readonly epoch: number; readonly seq: number }): Promise<{ readonly mode: 'snapshot' | 'resume' }> {
    const hosted = this.#require(instanceId);
    return this.#run(hosted, async () => {
      if (hosted.gone) throw new HostError('not_hosted');
      const participant = this.#participant(hosted, actorId, accountId);
      if (participant.status === 'left' || participant.status === 'leaving') throw new HostError('participant_left');
      participant.connection = connection; participant.deadline = null;
      const changed = participant.status !== 'connected';
      participant.status = 'connected';
      const oldest = hosted.buffer[0]?.seq ?? hosted.seq + 1;
      let mode: 'snapshot' | 'resume' = 'snapshot';
      if (resume && resume.epoch === hosted.epoch && resume.seq <= hosted.seq && resume.seq >= oldest - 1) {
        mode = 'resume';
        for (const entry of hosted.buffer) {
          if (entry.seq > resume.seq) {
            connection.push({ type: 'live.event', instanceId, epoch: hosted.epoch, seq: entry.seq, source: entry.source, event: entry.event });
          }
        }
      } else {
        connection.push({ type: 'live.snapshot', instanceId, epoch: hosted.epoch, seq: hosted.seq,
          view: this.#game.view(hosted.state, actorId), participants: this.#views(hosted) });
      }
      if (changed) this.#emit(hosted, 'host', { type: 'participant', actorId, status: 'connected' });
      return { mode };
    });
  }

  /** Transport lost: the participant enters the reconnection grace. The instance keeps running (no pause). */
  async detach(instanceId: string, actorId: string, connectionId: string): Promise<void> {
    const hosted = this.#instances.get(instanceId);
    if (!hosted) return;
    await this.#run(hosted, async () => {
      const participant = hosted.participants.get(actorId);
      if (hosted.gone || !participant || participant.connection?.id !== connectionId) return;
      participant.connection = null;
      if (participant.status !== 'connected') return;
      participant.status = 'disconnected';
      participant.deadline = this.#clock.nowMs() + this.#graceMs;
      this.#emit(hosted, 'host', { type: 'participant', actorId, status: 'disconnected' });
    });
  }

  /**
   * Applies a participant command at most once per `commandId`: a replay returns the original ack without applying it
   * again (the dedupe memory is persisted with checkpoints, so it survives a restore).
   */
  async submit(instanceId: string, actorId: string, accountId: string, commandId: string, command: JsonValue): Promise<SubmitResult> {
    if (typeof commandId !== 'string' || commandId.length === 0 || commandId.length > 64) throw new HostError('invalid_command_id');
    const hosted = this.#require(instanceId);
    return this.#run(hosted, async () => {
      if (hosted.gone) throw new HostError('not_hosted');
      const participant = this.#participant(hosted, actorId, accountId);
      const key = `${actorId}:${commandId}`;
      const prior = hosted.commands.get(key);
      if (prior) return { ack: prior, duplicate: true };
      if (participant.status === 'left' || participant.status === 'leaving') throw new HostError('participant_left');
      if (participant.status !== 'connected') throw new HostError('not_attached');
      if (!await this.#ensureLease(hosted)) throw new HostError('not_hosted');
      const result = this.#game.applyCommand(hosted.state, actorId, command);
      if ('rejected' in result) {
        const ack: CommandAck = { status: 'rejected', reason: result.rejected };
        this.#remember(hosted.commands, key, ack);
        return { ack, duplicate: false };
      }
      const ack: CommandAck = { status: 'applied' };
      const commands = new Map(hosted.commands);
      this.#remember(commands, key, ack);
      try {
        const committed = await this.#apply(hosted, result, commands);
        if (!committed) throw new HostError('not_hosted');
      } catch (error) {
        if (error instanceof LiveEffectRejectedError && !hosted.gone) {
          const rejected: CommandAck = { status: 'rejected', reason: error.reason };
          this.#remember(hosted.commands, key, rejected);
          return { ack: rejected, duplicate: false };
        }
        throw error;
      }
      return { ack, duplicate: false };
    });
  }

  /**
   * Advances every hosted instance to the clock's current time: due ticks (drift-safe schedule), grace expiry,
   * deferred participant removal and lease renewal. Production calls it from {@link start}'s timer; tests call it.
   */
  async pump(): Promise<void> {
    await Promise.all([...this.#instances.values()].map((hosted) => this.#run(hosted, () => this.#advance(hosted))
      .catch((error: unknown) => { this.#onError(error, hosted.lease.instanceId); })));
  }

  /** Starts the real-time loop: sleeps until the next due tick/deadline/renewal (at most `idleMs`). */
  start(idleMs = 1000): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      if (!this.#running) return;
      this.#timer = this.#timers.set(() => { void this.pump().finally(loop); }, this.#nextDelay(idleMs));
    };
    loop();
  }

  /**
   * Graceful shutdown: stops timers and expires each lease immediately (last checkpoint kept), so another node can
   * restore without waiting for the lease to time out. Connections receive `live.evicted`.
   */
  async stop(): Promise<void> {
    this.#halt();
    await Promise.all([...this.#instances.values()].map((hosted) => this.#run(hosted, async () => {
      if (hosted.gone) return;
      this.#drop(hosted, 'node_shutdown');
      await this.#store.relinquish(hosted.lease, this.#clock.nowMs());
    }).catch((error: unknown) => { this.#onError(error, hosted.lease.instanceId); })));
  }

  /** Simulates a process crash: forgets every instance without any write or notification. Tests only. */
  abandonForTesting(): void {
    this.#halt();
    for (const hosted of this.#instances.values()) hosted.gone = true;
    this.#instances.clear();
  }

  inspect(instanceId: string): InstanceInspection<S> | null {
    const hosted = this.#instances.get(instanceId);
    if (!hosted) return null;
    return { state: hosted.state, lease: hosted.lease, epoch: hosted.epoch, seq: hosted.seq,
      ticking: this.#game.isTicking(hosted.state), participants: this.#views(hosted) };
  }

  // -------------------------------------------------------------------------------------------------------------------

  #halt(): void {
    this.#running = false;
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
  }

  #nextDelay(idleMs: number): number {
    const now = this.#clock.nowMs();
    let next = now + idleMs;
    for (const hosted of this.#instances.values()) {
      next = Math.min(next, hosted.renewAt, hosted.nextTickAt ?? next);
      for (const participant of hosted.participants.values()) {
        if (participant.status === 'leaving') next = Math.min(next, now + 100);
        if (participant.deadline !== null) next = Math.min(next, participant.deadline);
      }
    }
    return Math.max(0, next - now);
  }

  #host(lease: InstanceLease, state: S, seq: number, commands: Map<string, CommandAck>,
    participants: readonly { actorId: string; accountId: string; left: boolean }[], now: number): Hosted<S> {
    const hosted: Hosted<S> = {
      lease, leaseExpiresAt: now + this.#leaseMs, renewAt: now + this.#renewEveryMs, state, epoch: lease.generation, seq,
      buffer: [], commands, nextTickAt: null, queue: Promise.resolve(), gone: false,
      participants: new Map(participants.map((p): [string, ParticipantRuntime] => [p.actorId, { accountId: p.accountId,
        status: p.left ? 'left' : 'disconnected', deadline: p.left ? null : now + this.#graceMs, connection: null }])),
    };
    this.#instances.set(lease.instanceId, hosted);
    return hosted;
  }

  #restore(lease: InstanceLease, record: InstanceRecord, now: number): void {
    const payload = record.checkpoint as unknown as CheckpointPayload;
    if (payload === null || typeof payload !== 'object' || payload.format !== CHECKPOINT_FORMAT) {
      throw new IncompatibleInstanceError(`instance ${record.instanceId} has an unknown checkpoint format`);
    }
    const state = this.#game.restore(payload.state);
    const hosted = this.#host(lease, state, payload.seq, new Map(payload.commands.map(([key, ack]) => [key, ack])),
      record.participants, now);
    this.#schedule(hosted);
  }

  #require(instanceId: string): Hosted<S> {
    const hosted = this.#instances.get(instanceId);
    if (!hosted) throw new HostError('not_hosted');
    return hosted;
  }

  #participant(hosted: Hosted<S>, actorId: string, accountId: string): ParticipantRuntime {
    const participant = hosted.participants.get(actorId);
    if (!participant || participant.accountId !== accountId) throw new HostError('not_participant');
    return participant;
  }

  #run<T>(hosted: Hosted<S>, task: () => Promise<T>): Promise<T> {
    const result = hosted.queue.then(task);
    hosted.queue = result.then(() => {}, () => {});
    return result;
  }

  #views(hosted: Hosted<S>): ParticipantView[] {
    return [...hosted.participants].map(([actorId, participant]) => ({ actorId, status: participant.status }));
  }

  #payload(state: S, seq: number, commands: Map<string, CommandAck>): JsonValue {
    const payload: CheckpointPayload = { format: CHECKPOINT_FORMAT, seq, state: this.#game.serialize(state), commands: [...commands] };
    return payload as unknown as JsonValue;
  }

  #remember(commands: Map<string, CommandAck>, key: string, ack: CommandAck): void {
    commands.set(key, ack);
    while (commands.size > this.#commandMemory) commands.delete(commands.keys().next().value as string);
  }

  #emit(hosted: Hosted<S>, source: 'game' | 'host', event: JsonValue): void {
    hosted.seq += 1;
    hosted.buffer.push({ seq: hosted.seq, source, event });
    if (hosted.buffer.length > this.#eventBuffer) hosted.buffer.shift();
    this.#broadcast(hosted, { type: 'live.event', instanceId: hosted.lease.instanceId, epoch: hosted.epoch, seq: hosted.seq, source, event });
  }

  #broadcast(hosted: Hosted<S>, message: HostMessage): void {
    for (const participant of hosted.participants.values()) {
      if (participant.connection === null) continue;
      try { participant.connection.push(message); }
      catch (error) { this.#onError(error, hosted.lease.instanceId); }
    }
  }

  /** Ticks run only while the game says so; the schedule is anchored to the first tick, so timer jitter never drifts. */
  #schedule(hosted: Hosted<S>): void {
    if (hosted.gone) return;
    if (!this.#game.isTicking(hosted.state)) hosted.nextTickAt = null;
    else if (hosted.nextTickAt === null) hosted.nextTickAt = this.#clock.nowMs() + this.#game.tickIntervalMs;
  }

  async #apply(hosted: Hosted<S>, step: LiveStep<S>, commands = hosted.commands): Promise<boolean> {
    const events = (step.events ?? []).map((event) => ({ source: 'game' as const, event }));
    const seq = hosted.seq + events.length;
    const effects = step.effects ?? [];
    const durable = Boolean(step.close || step.checkpoint || effects.length > 0);
    let nextLease = hosted.lease;
    if (durable) {
      try {
        if (step.close) {
          const closed = await this.#store.close(hosted.lease, { outcome: step.close.outcome, result: step.close.result,
            checkpoint: this.#payload(step.state, seq, commands), ...(effects.length > 0 ? { effects } : {}) }, this.#clock.nowMs());
          if (!closed) { this.#evict(hosted, 'lease_lost'); return false; }
        } else {
          const next = await this.#store.checkpoint(hosted.lease, this.#payload(step.state, seq, commands), this.#clock.nowMs(), effects);
          if (next === null) { this.#evict(hosted, 'lease_lost'); return false; }
          nextLease = next;
        }
      } catch (error) {
        if (!(error instanceof LiveEffectRejectedError)) this.#evict(hosted, 'store_error');
        throw error;
      }
    }
    this.#commitStep(hosted, step.state, seq, events, commands);
    if (step.close) {
      this.#broadcast(hosted, { type: 'live.closed', instanceId: hosted.lease.instanceId, outcome: step.close.outcome, result: step.close.result });
      this.#forget(hosted);
    } else {
      hosted.lease = nextLease;
      this.#schedule(hosted);
    }
    return true;
  }

  #commitStep(hosted: Hosted<S>, state: S, seq: number,
    events: readonly { source: 'game' | 'host'; event: JsonValue }[], commands: Map<string, CommandAck>): void {
    const firstSeq = seq - events.length;
    const committedCommands = [...commands];
    hosted.state = state;
    hosted.seq = seq;
    hosted.commands.clear();
    for (const [key, ack] of committedCommands) hosted.commands.set(key, ack);
    events.forEach((entry, index) => {
      const eventSeq = firstSeq + index + 1;
      hosted.buffer.push({ seq: eventSeq, source: entry.source, event: entry.event });
      if (hosted.buffer.length > this.#eventBuffer) hosted.buffer.shift();
      this.#broadcast(hosted, { type: 'live.event', instanceId: hosted.lease.instanceId, epoch: hosted.epoch,
        seq: eventSeq, source: entry.source, event: entry.event });
    });
  }

  /** Re-validates ownership once the locally known lease has run out (e.g. after a long pause of this process). */
  async #ensureLease(hosted: Hosted<S>): Promise<boolean> {
    const now = this.#clock.nowMs();
    if (now < hosted.renewAt && now < hosted.leaseExpiresAt) return true;
    if (!await this.#store.renew(hosted.lease, now, this.#leaseMs)) { this.#evict(hosted, 'lease_lost'); return false; }
    hosted.leaseExpiresAt = now + this.#leaseMs; hosted.renewAt = now + this.#renewEveryMs;
    return true;
  }

  async #advance(hosted: Hosted<S>): Promise<void> {
    if (hosted.gone || !await this.#ensureLease(hosted)) return;
    const now = this.#clock.nowMs();
    // 1. Due ticks. Each tick's due time is the previous due time + interval (not "now + interval").
    let ran = 0;
    while (!hosted.gone && hosted.nextTickAt !== null && hosted.nextTickAt <= now) {
      if (ran >= this.#maxCatchUp) {
        const behind = Math.floor((now - hosted.nextTickAt) / this.#game.tickIntervalMs) + 1;
        this.stats.skippedTicks += behind;
        hosted.nextTickAt += behind * this.#game.tickIntervalMs;
        break;
      }
      const dueAt = hosted.nextTickAt;
      hosted.nextTickAt += this.#game.tickIntervalMs;
      try {
        if (!await this.#apply(hosted, this.#game.tick(hosted.state))) {
          hosted.nextTickAt = dueAt;
          return;
        }
      } catch (error) {
        if (error instanceof LiveEffectRejectedError) { hosted.nextTickAt = dueAt; return; }
        throw error;
      }
      ran += 1; this.stats.ticks += 1;
    }
    // 2. Reconnection grace: expired participants leave once the game allows it (not mid-encounter).
    for (const [actorId, participant] of hosted.participants) {
      if (hosted.gone) return;
      const expired = participant.status === 'disconnected' && participant.deadline !== null && participant.deadline <= now;
      if (!expired && participant.status !== 'leaving') continue;
      const step = this.#game.removeParticipant(hosted.state, actorId);
      if (step === null) {
        if (expired) {
          participant.status = 'leaving'; participant.deadline = null;
          this.#emit(hosted, 'host', { type: 'participant', actorId, status: 'leaving' });
        }
        continue;
      }
      const events = [
        ...(expired ? [{ source: 'host' as const, event: { type: 'participant', actorId, status: 'leaving' } as JsonValue }] : []),
        ...(step.events ?? []).map((event) => ({ source: 'game' as const, event })),
        { source: 'host' as const, event: { type: 'participant', actorId, status: 'left' } as JsonValue },
      ];
      const seq = hosted.seq + events.length;
      if (step.close) {
        let closed: boolean;
        try {
          closed = await this.#store.close(hosted.lease, { outcome: step.close.outcome, result: step.close.result,
            checkpoint: this.#payload(step.state, seq, hosted.commands), ...(step.effects?.length ? { effects: step.effects } : {}) },
          this.#clock.nowMs());
        } catch (error) {
          if (error instanceof LiveEffectRejectedError) continue;
          this.#evict(hosted, 'store_error');
          throw error;
        }
        if (!closed) { this.#evict(hosted, 'lease_lost'); return; }
        participant.status = 'left'; participant.deadline = null; participant.connection = null;
        this.#commitStep(hosted, step.state, seq, events, hosted.commands);
        this.#broadcast(hosted, { type: 'live.closed', instanceId: hosted.lease.instanceId,
          outcome: step.close.outcome, result: step.close.result });
        this.#forget(hosted);
        return;
      }
      let next: InstanceLease | null;
      try {
        next = await this.#store.releaseParticipant(hosted.lease, actorId,
          this.#payload(step.state, seq, hosted.commands), this.#clock.nowMs(), step.effects ?? []);
      } catch (error) {
        if (error instanceof LiveEffectRejectedError) continue;
        this.#evict(hosted, 'store_error');
        throw error;
      }
      if (next === null) { this.#evict(hosted, 'lease_lost'); return; }
      hosted.lease = next;
      participant.status = 'left'; participant.deadline = null; participant.connection = null;
      this.#commitStep(hosted, step.state, seq, events, hosted.commands);
      this.#schedule(hosted);
    }
    if (!hosted.gone && [...hosted.participants.values()].every((participant) => participant.status === 'left')) {
      await this.#close(hosted, 'abandoned', null);
    }
  }

  async #close(hosted: Hosted<S>, outcome: string, result: JsonValue, effects: readonly JsonValue[] = []): Promise<boolean> {
    try {
      const closed = await this.#store.close(hosted.lease, { outcome, result,
        checkpoint: this.#payload(hosted.state, hosted.seq, hosted.commands), ...(effects.length > 0 ? { effects } : {}) }, this.#clock.nowMs());
      if (!closed) { this.#evict(hosted, 'lease_lost'); return false; }
    } catch (error) {
      if (error instanceof LiveEffectRejectedError) return false;
      this.#evict(hosted, 'store_error');
      throw error;
    }
    this.#broadcast(hosted, { type: 'live.closed', instanceId: hosted.lease.instanceId, outcome, result });
    this.#forget(hosted);
    return true;
  }

  #evict(hosted: Hosted<S>, reason: string): void {
    this.stats.evictions += 1;
    this.#drop(hosted, reason);
  }

  #drop(hosted: Hosted<S>, reason: string): void {
    this.#broadcast(hosted, { type: 'live.evicted', instanceId: hosted.lease.instanceId, reason });
    this.#forget(hosted);
  }

  #forget(hosted: Hosted<S>): void {
    hosted.gone = true; hosted.nextTickAt = null;
    for (const participant of hosted.participants.values()) participant.connection = null;
    if (this.#instances.get(hosted.lease.instanceId) === hosted) this.#instances.delete(hosted.lease.instanceId);
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
