import { parseLiveClientRequest } from '@rpg/protocol';
import type { LiveJson, LiveServerFrame, LiveViewDto } from '@rpg/protocol';
import type { LiveClient } from './client.ts';
import type { LiveState } from './state.ts';

export interface LiveSessionState {
  readonly connection: LiveState;
  readonly instanceId: string;
  readonly attached: boolean;
  readonly epoch: number | null;
  readonly seq: number | null;
  /** Cursor for `view`, the last authoritative baseline snapshot. `events` are contiguous deltas after this cursor. */
  readonly baselineEpoch: number | null;
  readonly baselineSeq: number | null;
  readonly view: LiveViewDto | null;
  readonly events: readonly { readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson }[];
  /** Bounded history of accepted, deduplicated event frames; unlike `events`, snapshots do not clear this log. */
  readonly recentEvents: readonly { readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson }[];
  readonly pendingCommandIds: readonly string[];
  readonly pendingCount: number;
  readonly lastAck: Extract<LiveServerFrame, { readonly type: 'live.ack' }> | null;
  readonly closed: { readonly outcome: string; readonly result: LiveJson } | null;
  readonly error: string | null;
}

interface PendingCommand { readonly commandId: string; readonly command: LiveJson; sent: boolean }
export interface LiveSessionOptions {
  readonly client: LiveSessionClient;
  readonly instanceId: string;
  readonly actorId: string;
  readonly newId?: () => string;
}

/** Minimal surface of the app-wide authenticated socket needed by a game session. */
export type LiveSessionClient = Pick<LiveClient, 'state' | 'subscribe' | 'subscribeFrames' | 'sendFrame' | 'start' | 'stop'>;

/**
 * Game-session state layered on the app's single authenticated LiveClient socket. Commands remain pending with the
 * same ID until a live.ack arrives, so reconnect can safely replay an ambiguous send through the server dedupe log.
 */
export class LiveSession {
  readonly #client: LiveSessionClient;
  readonly #instanceId: string;
  readonly #actorId: string;
  readonly #newId: () => string;
  readonly #listeners = new Set<(state: LiveSessionState) => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #unsubscribers: (() => void)[];
  #connection: LiveState;
  #attached = false;
  #attachInFlight = false;
  #attachResync = false;
  #epoch: number | null = null;
  #seq: number | null = null;
  #baselineEpoch: number | null = null;
  #baselineSeq: number | null = null;
  #view: LiveViewDto | null = null;
  #events: LiveSessionState['events'] = [];
  #recentEvents: LiveSessionState['recentEvents'] = [];
  #closed: LiveSessionState['closed'] = null;
  #error: string | null = null;
  #terminal = false;
  #disposed = false;
  #lastAck: LiveSessionState['lastAck'] = null;

  constructor(options: LiveSessionOptions) {
    this.#client = options.client; this.#instanceId = id(options.instanceId); this.#actorId = id(options.actorId);
    this.#newId = options.newId ?? (() => crypto.randomUUID()); this.#connection = options.client.state;
    this.#unsubscribers = [options.client.subscribe((state) => this.#onConnection(state)),
      options.client.subscribeFrames((frame) => this.#onFrame(frame))];
    if (this.#connection.status === 'open') this.#attach(false);
  }

  get state(): LiveSessionState { return this.#snapshot(); }
  subscribe(listener: (state: LiveSessionState) => void): () => void {
    this.#listeners.add(listener); listener(this.#snapshot()); return () => { this.#listeners.delete(listener); };
  }

  start(): void {
    if (this.#disposed) return;
    if (this.#client.state.status === 'open') this.#attach(false);
    else this.#client.start();
  }
  stop(): void { this.#client.stop(); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#attached = false; this.#attachInFlight = false;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#listeners.clear();
  }

  /** Queue and send a new action, returning its stable command ID for UI retry/persistence if needed. */
  submit(command: unknown): string {
    if (this.#disposed) throw new Error('live session is disposed');
    if (this.#terminal) throw new Error('live instance is closed');
    const parsed = parseLiveClientRequest({ op: 'live.command', instanceId: this.#instanceId, actorId: this.#actorId,
      commandId: this.#newId(), command });
    if (parsed.op !== 'live.command') throw new TypeError('invalid live command');
    const pending: PendingCommand = { commandId: parsed.commandId, command: parsed.command, sent: false };
    this.#pending.set(pending.commandId, pending);
    if (this.#attached) this.#send(pending);
    this.#publish();
    return pending.commandId;
  }

  /** Re-send all unresolved actions using their original IDs. Safe after a lost acknowledgement. */
  retryPending(): void { if (this.#attached) for (const command of this.#pending.values()) this.#send(command, true); }

  #onConnection(state: LiveState): void {
    const wasOpen = this.#connection.status === 'open'; this.#connection = state;
    if (state.status !== 'open') {
      this.#attached = false; this.#attachInFlight = false; this.#attachResync = false;
      for (const pending of this.#pending.values()) pending.sent = false;
    } else if (!wasOpen) this.#attach(false);
    this.#publish();
  }

  #onFrame(frame: LiveServerFrame): void {
    if (frame.type === 'live.snapshot' && frame.instanceId === this.#instanceId) {
      this.#epoch = frame.epoch; this.#seq = frame.seq; this.#baselineEpoch = frame.epoch; this.#baselineSeq = frame.seq;
      this.#view = frame.view; this.#events = []; this.#attached = true;
      this.#error = null; this.#publish(); return;
    }
    if (frame.type === 'live.event' && frame.instanceId === this.#instanceId) {
      if (this.#epoch === frame.epoch && this.#seq !== null && frame.seq <= this.#seq) return;
      if (this.#epoch !== frame.epoch || this.#seq === null || frame.seq !== this.#seq + 1) {
        this.#attached = false; this.#attach(true); return;
      }
      if (this.#events.length >= 256) { this.#attached = false; this.#attach(true); return; }
      this.#seq = frame.seq;
      const accepted = { epoch: frame.epoch, seq: frame.seq, source: frame.source, event: frame.event };
      this.#events = [...this.#events, accepted];
      this.#recentEvents = [...this.#recentEvents, accepted].slice(-256);
      this.#publish(); return;
    }
    if (frame.type === 'live.attached' && frame.instanceId === this.#instanceId) {
      this.#attachInFlight = false;
      // The host pushes either replay events or a snapshot before its acknowledgement.
      this.#attached = true;
      this.#error = null;
      if (!this.#attachResync) this.retryPending();
      this.#attachResync = false; this.#publish(); return;
    }
    if (frame.type === 'live.ack' && frame.instanceId === this.#instanceId) {
      this.#pending.delete(frame.commandId); this.#lastAck = frame; this.#publish(); return;
    }
    if (frame.type === 'live.error') {
      this.#attachInFlight = false; this.#attachResync = false; this.#attached = false; this.#error = frame.error; this.#publish(); return;
    }
    if (frame.type === 'live.closed' && frame.instanceId === this.#instanceId) {
      this.#terminal = true; this.#attached = false;
      this.#closed = { outcome: frame.outcome, result: frame.result }; this.#publish(); return;
    }
    if (frame.type === 'live.evicted' && frame.instanceId === this.#instanceId) {
      this.#attachInFlight = false; this.#attachResync = false; this.#attached = false;
      for (const pending of this.#pending.values()) pending.sent = false;
      this.#error = frame.reason; this.#publish();
    }
  }

  #attach(resync: boolean): void {
    if (this.#disposed || this.#terminal || this.#connection.status !== 'open' || this.#attachInFlight) return;
    this.#attachInFlight = true;
    this.#attachResync = resync;
    try {
      const resume = resync || this.#epoch === null || this.#seq === null ? undefined : { epoch: this.#epoch, seq: this.#seq };
      const request = parseLiveClientRequest({ op: 'live.attach', instanceId: this.#instanceId, actorId: this.#actorId, ...(resume ? { resume } : {}) });
      this.#client.sendFrame(request);
    } catch {
      this.#attachInFlight = false;
      this.#attachResync = false;
      this.#attached = false;
      if (!resync) this.#error = 'send_failed';
    }
  }

  #send(pending: PendingCommand, force = false): void {
    if (this.#disposed || !this.#attached || (pending.sent && !force)) return;
    try {
      const request = parseLiveClientRequest({ op: 'live.command', instanceId: this.#instanceId, actorId: this.#actorId,
        commandId: pending.commandId, command: pending.command });
      this.#client.sendFrame(request); pending.sent = true;
    } catch {
      // Keep the entry and its ID. The next authenticated attach retries the same logical action.
      pending.sent = false;
    }
  }

  #snapshot(): LiveSessionState {
    return { connection: this.#connection, instanceId: this.#instanceId, attached: this.#attached, epoch: this.#epoch,
      seq: this.#seq, baselineEpoch: this.#baselineEpoch, baselineSeq: this.#baselineSeq, view: this.#view, events: this.#events,
      recentEvents: this.#recentEvents,
      pendingCommandIds: [...this.#pending.keys()], pendingCount: this.#pending.size,
      lastAck: this.#lastAck, closed: this.#closed, error: this.#error };
  }
  #publish(): void { const state = this.#snapshot(); for (const listener of [...this.#listeners]) listener(state); }
}

function id(value: string): string {
  const request = parseLiveClientRequest({ op: 'live.attach', instanceId: value, actorId: value });
  return request.instanceId;
}
