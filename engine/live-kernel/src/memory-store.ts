import { ActivityConflictError } from './types.ts';
import type { CloseInstanceInput, CreateInstanceInput, InstanceLease, InstanceRecord, InstanceStore, JsonValue, StoredParticipant } from './types.ts';

interface Row {
  record: InstanceRecord;
  status: 'active' | 'closed';
  nodeId: string;
  generation: number;
  checkpointSeq: number;
  leaseExpiresAt: number;
  outcome: { outcome: string; result: JsonValue } | null;
}

/**
 * Reference in-memory {@link InstanceStore} with the same fencing semantics as the PostgreSQL store. For unit tests of
 * hosts and game plugins; shared between several hosts it simulates several nodes. Not durable.
 */
export class MemoryInstanceStore implements InstanceStore {
  /** actorId → activity (instance) ID; absent = `none`. */
  readonly activities = new Map<string, string>();
  readonly rows = new Map<string, Row>();
  readonly closes: { instanceId: string; outcome: string; result: JsonValue }[] = [];
  /** Durable game effects committed with checkpoints, participant releases and closes, in commit order. */
  readonly effects: { instanceId: string; effect: JsonValue }[] = [];

  async create(input: CreateInstanceInput): Promise<InstanceLease> {
    const ids = [...new Set(input.participants.map((p) => p.actorId))].sort();
    if (ids.some((id) => this.activities.has(id))) throw new ActivityConflictError();
    for (const id of ids) this.activities.set(id, input.instanceId);
    const { nodeId, nowMs, leaseMs, ...record } = input;
    this.rows.set(input.instanceId, { record: structuredClone(record), status: 'active', nodeId, generation: 1, checkpointSeq: 0,
      leaseExpiresAt: nowMs + leaseMs, outcome: null });
    return { instanceId: input.instanceId, nodeId, generation: 1, checkpointSeq: 0 };
  }

  #fenced(lease: InstanceLease, nowMs: number): Row | null {
    const row = this.rows.get(lease.instanceId);
    if (!row || row.status !== 'active' || row.nodeId !== lease.nodeId || row.generation !== lease.generation ||
      row.checkpointSeq !== lease.checkpointSeq || row.leaseExpiresAt <= nowMs) return null;
    return row;
  }

  async renew(lease: InstanceLease, nowMs: number, leaseMs: number): Promise<boolean> {
    const row = this.#fenced(lease, nowMs);
    if (!row) return false;
    row.leaseExpiresAt = nowMs + leaseMs;
    return true;
  }

  async checkpoint(lease: InstanceLease, checkpoint: JsonValue, nowMs: number, effects: readonly JsonValue[] = []): Promise<InstanceLease | null> {
    const row = this.#fenced(lease, nowMs);
    if (!row) return null;
    this.#commitEffects(lease.instanceId, effects);
    row.checkpointSeq += 1;
    row.record = { ...row.record, checkpoint: structuredClone(checkpoint) };
    return { ...lease, checkpointSeq: row.checkpointSeq };
  }

  async releaseParticipant(lease: InstanceLease, actorId: string, checkpoint: JsonValue, nowMs: number,
    effects: readonly JsonValue[] = []): Promise<InstanceLease | null> {
    const row = this.#fenced(lease, nowMs);
    if (!row) return null;
    if (this.activities.get(actorId) !== lease.instanceId) throw new Error('activity lock invariant violated');
    this.activities.delete(actorId);
    row.record = { ...row.record, participants: row.record.participants.map((p): StoredParticipant => p.actorId === actorId ? { ...p, left: true } : p) };
    return this.checkpoint(lease, checkpoint, nowMs, effects);
  }

  async close(lease: InstanceLease, input: CloseInstanceInput, nowMs: number): Promise<boolean> {
    const row = this.#fenced(lease, nowMs);
    if (!row) return false;
    for (const participant of row.record.participants) {
      if (participant.left) continue;
      if (this.activities.get(participant.actorId) !== lease.instanceId) throw new Error('activity lock invariant violated');
      this.activities.delete(participant.actorId);
    }
    this.#commitEffects(lease.instanceId, input.effects ?? []);
    row.status = 'closed';
    row.record = { ...row.record, checkpoint: structuredClone(input.checkpoint) };
    row.outcome = { outcome: input.outcome, result: structuredClone(input.result) };
    this.closes.push({ instanceId: lease.instanceId, outcome: input.outcome, result: input.result });
    return true;
  }

  #commitEffects(instanceId: string, effects: readonly JsonValue[]): void {
    for (const effect of effects) this.effects.push({ instanceId, effect: structuredClone(effect) });
  }

  async relinquish(lease: InstanceLease, nowMs: number): Promise<void> {
    const row = this.rows.get(lease.instanceId);
    if (row && row.status === 'active' && row.nodeId === lease.nodeId && row.generation === lease.generation) row.leaseExpiresAt = nowMs;
  }

  async claim(instanceId: string, nodeId: string, nowMs: number, leaseMs: number): Promise<{ lease: InstanceLease; record: InstanceRecord } | null> {
    const row = this.rows.get(instanceId);
    if (!row || row.status !== 'active' || row.leaseExpiresAt > nowMs) return null;
    row.nodeId = nodeId; row.generation += 1; row.leaseExpiresAt = nowMs + leaseMs;
    return { lease: { instanceId, nodeId, generation: row.generation, checkpointSeq: row.checkpointSeq }, record: structuredClone(row.record) };
  }

  async findExpired(nowMs: number, limit: number): Promise<string[]> {
    return [...this.rows].filter(([, row]) => row.status === 'active' && row.leaseExpiresAt <= nowMs).slice(0, limit).map(([id]) => id);
  }
}
