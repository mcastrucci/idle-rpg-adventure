import { and, asc, eq, lte, gt, sql } from 'drizzle-orm';
import { ActivityConflictError } from '@engine/live-kernel';
import type {
  CloseInstanceInput, CreateInstanceInput, InstanceLease, InstanceRecord, InstanceStore, JsonValue, StoredParticipant,
} from '@engine/live-kernel';

import { lockActors, transitionActivity } from '../actors/service.ts';
import type { ActorTransaction } from '../actors/service.ts';
import type { Database } from '../database.ts';
import { liveInstances } from './schema.ts';
import type { LiveInstanceRow } from './schema.ts';

export interface PostgresInstanceStoreHooks {
  /** Validates game-specific start snapshots inside the actor-locked creation transaction, before activity CAS. */
  readonly validateCreate?: (tx: ActorTransaction, input: CreateInstanceInput) => Promise<void>;
  /**
   * Runs inside the fenced close transaction, after the activity locks are released. Game settlement (run bag commit
   * through the ledger, corpse creation…) belongs here so it commits exactly once with the close, or not at all.
   */
  readonly onClose?: (tx: ActorTransaction, instance: InstanceRecord, input: CloseInstanceInput) => Promise<void>;
  /** Same contract for a single participant leaving (grace expired) while the instance continues. */
  readonly onParticipantReleased?: (tx: ActorTransaction, instance: InstanceRecord, actorId: string) => Promise<void>;
  /**
   * Applies a step's durable game effects (`LiveStep.effects`) inside the fenced transaction of the checkpoint,
   * participant release or close they belong to (before `onClose`/`onParticipantReleased`). Must be idempotent. Without
   * this hook, effects are dropped (the checkpoint is still written).
   */
  readonly onEffects?: (tx: ActorTransaction, instance: InstanceRecord, effects: readonly JsonValue[], nowMs: number,
    context: LiveEffectsContext) => Promise<void>;
}

export type LiveEffectsContext = { readonly type: 'checkpoint' } | { readonly type: 'release'; readonly actorId: string } | { readonly type: 'close' };

/** Thrown inside a transaction to roll it back when a fenced write lost ownership. */
class Fenced extends Error {}

/**
 * PostgreSQL {@link InstanceStore}. Creation CASes every participant's `actors.activity_state` `none → live` with the
 * instance ID as activity ID (ascending actor UUID order, ADR-0007); close and participant release CAS them back.
 * Every later write is conditional on `(node_id, lease_generation, checkpoint_seq)` and an unexpired lease, so a node
 * that lost its lease (paused, partitioned, crashed and restarted) can never overwrite its successor.
 */
export class PostgresInstanceStore implements InstanceStore {
  readonly #database: Database;
  readonly #hooks: PostgresInstanceStoreHooks;
  constructor(database: Database, hooks: PostgresInstanceStoreHooks = {}) { this.#database = database; this.#hooks = hooks; }

  async create(input: CreateInstanceInput): Promise<InstanceLease> {
    const now = new Date(input.nowMs);
    return this.#database.db.transaction(async (tx) => {
      const locked = await lockActors(tx, input.participants.map((p) => p.actorId));
      for (const actor of locked) {
        const participant = input.participants.find((p) => p.actorId.toLowerCase() === actor.actorId);
        if (!participant || participant.accountId !== actor.accountId) throw new ActivityConflictError('participant is not owned by the given account');
        if (actor.activityState !== 'none' || actor.activityId !== null) throw new ActivityConflictError();
      }
      await this.#hooks.validateCreate?.(tx, input);
      for (const actor of locked) {
        const moved = await transitionActivity(tx, actor.actorId, { state: 'none', activityId: null }, { state: 'live', activityId: input.instanceId });
        if (!moved) throw new ActivityConflictError();
      }
      await tx.insert(liveInstances).values({ instanceId: input.instanceId, gameId: input.gameId, gameVersion: input.gameVersion,
        contentHash: input.contentHash, participants: [...input.participants], status: 'active', nodeId: input.nodeId,
        leaseGeneration: 1, leaseExpiresAt: new Date(input.nowMs + input.leaseMs), checkpoint: input.checkpoint, checkpointSeq: 0,
        createdAt: now, updatedAt: now });
      return { instanceId: input.instanceId, nodeId: input.nodeId, generation: 1, checkpointSeq: 0 };
    });
  }

  #fence(lease: InstanceLease, nowMs: number) {
    return and(eq(liveInstances.instanceId, lease.instanceId), eq(liveInstances.status, 'active'),
      eq(liveInstances.nodeId, lease.nodeId), eq(liveInstances.leaseGeneration, lease.generation),
      eq(liveInstances.checkpointSeq, lease.checkpointSeq), gt(liveInstances.leaseExpiresAt, new Date(nowMs)));
  }

  async renew(lease: InstanceLease, nowMs: number, leaseMs: number): Promise<boolean> {
    const updated = await this.#database.db.update(liveInstances).set({ leaseExpiresAt: new Date(nowMs + leaseMs) })
      .where(this.#fence(lease, nowMs)).returning({ id: liveInstances.instanceId });
    return updated.length === 1;
  }

  async checkpoint(lease: InstanceLease, checkpoint: JsonValue, nowMs: number, effects: readonly JsonValue[] = []): Promise<InstanceLease | null> {
    const onEffects = this.#hooks.onEffects;
    if (effects.length === 0 || !onEffects) {
      const updated = await this.#database.db.update(liveInstances).set({ checkpoint, checkpointSeq: sql`${liveInstances.checkpointSeq} + 1`,
        updatedAt: new Date(nowMs) }).where(this.#fence(lease, nowMs)).returning({ seq: liveInstances.checkpointSeq });
      const row = updated[0];
      return row ? { ...lease, checkpointSeq: row.seq } : null;
    }
    // Effects commit with the checkpoint or not at all: the fenced update and the game's writes share one transaction.
    return this.#database.db.transaction(async (tx) => {
      const [updated] = await tx.update(liveInstances).set({ checkpoint, checkpointSeq: sql`${liveInstances.checkpointSeq} + 1`,
        updatedAt: new Date(nowMs) }).where(this.#fence(lease, nowMs)).returning();
      if (!updated) return null;
      await onEffects(tx, record(updated), effects, nowMs, { type: 'checkpoint' });
      return { ...lease, checkpointSeq: updated.checkpointSeq };
    });
  }

  async releaseParticipant(lease: InstanceLease, actorId: string, checkpoint: JsonValue, nowMs: number,
    effects: readonly JsonValue[] = []): Promise<InstanceLease | null> {
    try {
      return await this.#database.db.transaction(async (tx) => {
        const [row] = await tx.select().from(liveInstances).where(this.#fence(lease, nowMs)).for('update');
        if (!row) throw new Fenced();
        const participants = row.participants.map((p): StoredParticipant => p.actorId === actorId ? { ...p, left: true } : p);
        await lockActors(tx, [actorId]);
        await release(tx, actorId, lease.instanceId);
        const [updated] = await tx.update(liveInstances).set({ participants, checkpoint, checkpointSeq: row.checkpointSeq + 1,
          updatedAt: new Date(nowMs) }).where(eq(liveInstances.instanceId, lease.instanceId)).returning();
        if (!updated) throw new Fenced();
        if (effects.length > 0) await this.#hooks.onEffects?.(tx, record(updated), effects, nowMs, { type: 'release', actorId });
        await this.#hooks.onParticipantReleased?.(tx, record(updated), actorId);
        return { ...lease, checkpointSeq: updated.checkpointSeq };
      });
    } catch (error) {
      if (error instanceof Fenced) return null;
      throw error;
    }
  }

  async close(lease: InstanceLease, input: CloseInstanceInput, nowMs: number): Promise<boolean> {
    try {
      return await this.#database.db.transaction(async (tx) => {
        // Instance row first (fencing), then actors in ascending order; creation never holds an instance row lock.
        const [row] = await tx.select().from(liveInstances).where(this.#fence(lease, nowMs)).for('update');
        if (!row) throw new Fenced();
        const remaining = row.participants.filter((p) => !p.left).map((p) => p.actorId);
        await lockActors(tx, remaining);
        for (const actorId of [...remaining].sort()) await release(tx, actorId, lease.instanceId);
        const [closed] = await tx.update(liveInstances).set({ status: 'closed', checkpoint: input.checkpoint,
          checkpointSeq: row.checkpointSeq + 1, outcome: input.outcome, result: input.result, updatedAt: new Date(nowMs),
          closedAt: new Date(nowMs) }).where(eq(liveInstances.instanceId, lease.instanceId)).returning();
        if (!closed) throw new Fenced();
        if (input.effects && input.effects.length > 0) await this.#hooks.onEffects?.(tx, record(closed), input.effects, nowMs, { type: 'close' });
        await this.#hooks.onClose?.(tx, record(closed), input);
        return true;
      });
    } catch (error) {
      if (error instanceof Fenced) return false;
      throw error;
    }
  }

  async relinquish(lease: InstanceLease, nowMs: number): Promise<void> {
    await this.#database.db.update(liveInstances).set({ leaseExpiresAt: new Date(nowMs), updatedAt: new Date(nowMs) })
      .where(and(eq(liveInstances.instanceId, lease.instanceId), eq(liveInstances.status, 'active'),
        eq(liveInstances.nodeId, lease.nodeId), eq(liveInstances.leaseGeneration, lease.generation)));
  }

  async claim(instanceId: string, nodeId: string, nowMs: number, leaseMs: number): Promise<{ lease: InstanceLease; record: InstanceRecord } | null> {
    const [row] = await this.#database.db.update(liveInstances).set({ nodeId, leaseGeneration: sql`${liveInstances.leaseGeneration} + 1`,
      leaseExpiresAt: new Date(nowMs + leaseMs), updatedAt: new Date(nowMs) })
      .where(and(eq(liveInstances.instanceId, instanceId), eq(liveInstances.status, 'active'), lte(liveInstances.leaseExpiresAt, new Date(nowMs))))
      .returning();
    if (!row) return null;
    return { lease: { instanceId, nodeId, generation: row.leaseGeneration, checkpointSeq: row.checkpointSeq }, record: record(row) };
  }

  async findExpired(nowMs: number, limit: number): Promise<string[]> {
    const rows = await this.#database.db.select({ id: liveInstances.instanceId }).from(liveInstances)
      .where(and(eq(liveInstances.status, 'active'), lte(liveInstances.leaseExpiresAt, new Date(nowMs))))
      .orderBy(asc(liveInstances.leaseExpiresAt)).limit(limit);
    return rows.map((row) => row.id);
  }
}

async function release(tx: ActorTransaction, actorId: string, instanceId: string): Promise<void> {
  const released = await transitionActivity(tx, actorId, { state: 'live', activityId: instanceId }, { state: 'none', activityId: null });
  // A live lock can only be released by its own instance; anything else is a broken invariant, so roll back loudly.
  if (!released) throw new Error(`activity lock invariant violated for actor ${actorId}`);
}

function record(row: LiveInstanceRow): InstanceRecord {
  return { instanceId: row.instanceId, gameId: row.gameId, gameVersion: row.gameVersion, contentHash: row.contentHash,
    participants: row.participants, checkpoint: row.checkpoint };
}
