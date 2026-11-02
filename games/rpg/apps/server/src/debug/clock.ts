import { sql } from 'drizzle-orm';
import type { ActorTransaction, Clock, Database } from '@engine/server-kit';

import { rpgDebugClock } from './schema.ts';

/** One advance may skip at most a day. Note that auth sessions use the same app clock (12 h default TTL). */
export const MAX_DEBUG_ADVANCE_MS = 24 * 60 * 60 * 1000;
/** Upper bound for the accumulated environment offset. */
export const MAX_DEBUG_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;
const ROW_ID = 'environment';

export class DebugClockError extends Error {
  readonly code = 'debug_clock_limit';
  readonly statusCode = 409;
  constructor() { super('debug_clock_limit'); this.name = 'DebugClockError'; }
}

/**
 * App clock = base clock + environment debug offset. `nowMs()` stays synchronous: the offset is a cached value that
 * only moves forward (`observeOffset` keeps the maximum), refreshed from PostgreSQL by the debug module.
 */
export class TimeTravelClock implements Clock {
  readonly #base: Clock;
  #offsetMs = 0;
  constructor(base: Clock) { this.#base = base; }
  nowMs(): number { return this.#base.nowMs() + this.#offsetMs; }
  baseNowMs(): number { return this.#base.nowMs(); }
  get offsetMs(): number { return this.#offsetMs; }
  observeOffset(offsetMs: number): void {
    if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > MAX_DEBUG_OFFSET_MS) throw new RangeError('invalid debug clock offset');
    if (offsetMs > this.#offsetMs) this.#offsetMs = offsetMs;
  }
}

export async function readDebugOffset(database: Database): Promise<number> {
  const [row] = await database.db.select({ offsetMs: rpgDebugClock.offsetMs }).from(rpgDebugClock);
  return row?.offsetMs ?? 0;
}

/** Atomically adds `durationMs` to the persisted offset inside the caller's command transaction. */
export async function advanceDebugOffset(tx: ActorTransaction, clock: TimeTravelClock, durationMs: number): Promise<number> {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DEBUG_ADVANCE_MS) throw new RangeError('invalid debug clock advance');
  const updatedAt = new Date(clock.baseNowMs());
  const result = await tx.execute<{ offset_ms: string }>(sql`INSERT INTO rpg_debug_clock (id, offset_ms, updated_at)
      VALUES (${ROW_ID}, ${durationMs}, ${updatedAt}) ON CONFLICT (id) DO UPDATE
      SET offset_ms = rpg_debug_clock.offset_ms + EXCLUDED.offset_ms, updated_at = EXCLUDED.updated_at
      WHERE rpg_debug_clock.offset_ms + EXCLUDED.offset_ms <= ${MAX_DEBUG_OFFSET_MS}
      RETURNING offset_ms`);
  const row = result.rows[0];
  if (!row) throw new DebugClockError();
  const offsetMs = Number(row.offset_ms);
  if (offsetMs > MAX_DEBUG_OFFSET_MS) throw new DebugClockError();
  return offsetMs;
}
