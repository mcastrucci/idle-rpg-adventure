/**
 * Public contracts of the live instance host (ADR-0012). Game-agnostic: a game plugs its rules in through
 * {@link LiveGame}; persistence (lease, fenced checkpoints, activity locks) plugs in through {@link InstanceStore}.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One actor taking part in an instance and the account allowed to control it. Phase 1 is solo; the list stays generic. */
export interface LiveParticipant {
  readonly actorId: string;
  readonly accountId: string;
}

/** Connection state of a participant (docs/spec/state-machines.md §2, participant connection). */
export type ParticipantStatus = 'connected' | 'disconnected' | 'leaving' | 'left';

/** Result of applying a command or a tick to the game state. */
export interface LiveStep<S> {
  readonly state: S;
  /** Events pushed to every connected participant, in order. Plain JSON. */
  readonly events?: readonly JsonValue[];
  /**
   * Persist a checkpoint right after this step. Games request one only at meaningful boundaries (location change,
   * encounter start/end, loot pickup, discovery, participant change) — never per tick. A checkpoint written when an
   * encounter starts is the "pre-encounter checkpoint": a restore restarts that encounter from its beginning.
   */
  readonly checkpoint?: boolean;
  /** Ends the instance: final checkpoint, activity locks released, `result` stored with the instance. */
  readonly close?: { readonly outcome: string; readonly result: JsonValue };
}

export type LiveCommandResult<S> = LiveStep<S> | { readonly rejected: string };

export interface LiveGameInit {
  readonly instanceId: string;
  readonly participants: readonly LiveParticipant[];
  /** Server-generated uint32 root seed for the instance's RNG streams. */
  readonly seed: number;
  /** Game-specific setup prepared by the composition root (e.g. actor snapshots, starting area). */
  readonly setup: JsonValue;
}

/**
 * Game plugin. Must be deterministic given its inputs (the host supplies the seed; no clocks or I/O), so a checkpoint
 * plus the same commands reproduces the same state. All methods are synchronous and must not mutate their inputs.
 */
export interface LiveGame<S> {
  /** Stable plugin ID stored with each instance. */
  readonly id: string;
  /** Behaviour version stored with each instance; a node refuses to restore a checkpoint from another version. */
  readonly version: string;
  /** Duration of one tick while {@link LiveGame.isTicking} is true (provisional 500 ms for RPG combat). */
  readonly tickIntervalMs: number;
  init(input: LiveGameInit): S;
  /** Untrusted input: validate and return `{ rejected }` instead of throwing. */
  applyCommand(state: S, actorId: string, command: JsonValue): LiveCommandResult<S>;
  /** Advances one tick. Only called while `isTicking(state)`. Automation acts for disconnected participants here. */
  tick(state: S): LiveStep<S>;
  /** True while the instance needs ticks (e.g. RPG combat). Exploration is command/response and does not tick. */
  isTicking(state: S): boolean;
  /**
   * Removes a participant whose reconnection grace expired. Return `null` to defer (e.g. while its encounter is still
   * ticking — the character keeps acting through automation until the encounter ends).
   */
  removeParticipant(state: S, actorId: string): LiveStep<S> | null;
  serialize(state: S): JsonValue;
  restore(checkpoint: JsonValue): S;
  /** Client-facing snapshot sent on attach and on resume when missed events are no longer buffered. */
  view(state: S): JsonValue;
}

/** Fencing token of the node that currently owns an instance. */
export interface InstanceLease {
  readonly instanceId: string;
  readonly nodeId: string;
  /** Incremented on every claim; stale owners cannot write with an older generation. */
  readonly generation: number;
  /** Last durable checkpoint sequence; every write is conditional on it. */
  readonly checkpointSeq: number;
}

export interface StoredParticipant extends LiveParticipant {
  readonly left: boolean;
}

export interface InstanceRecord {
  readonly instanceId: string;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly contentHash: string;
  readonly participants: readonly StoredParticipant[];
  readonly checkpoint: JsonValue;
}

export interface CreateInstanceInput extends InstanceRecord {
  readonly nodeId: string;
  readonly nowMs: number;
  readonly leaseMs: number;
}

export interface CloseInstanceInput {
  readonly outcome: string;
  readonly result: JsonValue;
  readonly checkpoint: JsonValue;
}

/**
 * Persistence port. Every write after creation is fenced on `(nodeId, generation, checkpointSeq)` and on the lease not
 * having expired; a `false`/`null` result means this node lost ownership and must drop the instance.
 */
export interface InstanceStore {
  /**
   * Atomically moves every participant's activity `none → live` (ascending actor ID, compare-and-set) and inserts the
   * instance with a lease. Throws {@link ActivityConflictError} if any participant is busy.
   */
  create(input: CreateInstanceInput): Promise<InstanceLease>;
  renew(lease: InstanceLease, nowMs: number, leaseMs: number): Promise<boolean>;
  /** Writes checkpoint `lease.checkpointSeq + 1`. */
  checkpoint(lease: InstanceLease, checkpoint: JsonValue, nowMs: number): Promise<InstanceLease | null>;
  /** Marks a participant `left`, releases its activity lock and writes a checkpoint, in one fenced transaction. */
  releaseParticipant(lease: InstanceLease, actorId: string, checkpoint: JsonValue, nowMs: number): Promise<InstanceLease | null>;
  /** Final fenced write: instance closed, remaining activity locks released, game close hook run. */
  close(lease: InstanceLease, input: CloseInstanceInput, nowMs: number): Promise<boolean>;
  /** Graceful shutdown: expires the lease now (keeping the last checkpoint) so another node can claim immediately. */
  relinquish(lease: InstanceLease, nowMs: number): Promise<void>;
  /** Claims an active instance whose lease expired (crash recovery). `null` if it is owned, closed or missing. */
  claim(instanceId: string, nodeId: string, nowMs: number, leaseMs: number): Promise<{ lease: InstanceLease; record: InstanceRecord } | null>;
  /** Active instances whose lease expired, for a recovery sweep. */
  findExpired(nowMs: number, limit: number): Promise<string[]>;
}

export class ActivityConflictError extends Error {
  readonly code = 'activity_conflict';
  constructor(message = 'a participant is not available (activity lock held)') { super(message); this.name = 'ActivityConflictError'; }
}

export class IncompatibleInstanceError extends Error {
  readonly code = 'incompatible_instance';
  constructor(message: string) { super(message); this.name = 'IncompatibleInstanceError'; }
}

export interface LiveClock { nowMs(): number }

/** Messages the host pushes to a participant connection. */
export type HostMessage =
  | { readonly type: 'live.snapshot'; readonly instanceId: string; readonly epoch: number; readonly seq: number; readonly view: JsonValue; readonly participants: readonly ParticipantView[] }
  | { readonly type: 'live.event'; readonly instanceId: string; readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: JsonValue }
  | { readonly type: 'live.closed'; readonly instanceId: string; readonly outcome: string; readonly result: JsonValue }
  | { readonly type: 'live.evicted'; readonly instanceId: string; readonly reason: string };

export interface ParticipantView { readonly actorId: string; readonly status: ParticipantStatus }

export interface LiveConnection {
  /** Unique per transport connection, so a stale socket closing does not disconnect its successor. */
  readonly id: string;
  push(message: HostMessage): void;
}

export type CommandAck =
  | { readonly status: 'applied' }
  | { readonly status: 'rejected'; readonly reason: string };

export interface SubmitResult {
  readonly ack: CommandAck;
  /** True when this `commandId` was already processed: the stored ack is returned and nothing is applied again. */
  readonly duplicate: boolean;
}
