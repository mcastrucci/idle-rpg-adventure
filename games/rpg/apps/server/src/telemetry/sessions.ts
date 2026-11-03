import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@engine/server-kit';
import type { LiveConnectionLifecycleEvent } from '@engine/server-kit';

import { rpgConnectionSessions } from './session-schema.ts';

function serverTime(atMs: number): Date {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError('connection telemetry time must be a non-negative integer');
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) throw new RangeError('connection telemetry time is out of range');
  return date;
}

/** Idempotently records server-authenticated connection state; callers isolate failures from auth/gameplay. */
export async function persistRpgConnectionLifecycle(database: Database, event: LiveConnectionLifecycleEvent): Promise<void> {
  const at = serverTime(event.atMs);
  if (event.type === 'authenticated') {
    // Each event owns one connection row. An old or delayed authenticated replay must not alter its siblings.
    await database.db.insert(rpgConnectionSessions).values({ connectionId: event.connectionId, accountId: event.accountId,
      startedAt: at, lastSeenAt: at }).onConflictDoNothing({ target: rpgConnectionSessions.connectionId });
  } else if (event.type === 'heartbeat') {
    await database.db.update(rpgConnectionSessions).set({
      lastSeenAt: sql`GREATEST(${rpgConnectionSessions.lastSeenAt}, ${at})`,
    }).where(and(eq(rpgConnectionSessions.connectionId, event.connectionId),
      eq(rpgConnectionSessions.accountId, event.accountId), isNull(rpgConnectionSessions.endedAt)));
  } else {
    // Crash observations use last_seen_at as the endpoint; explicit stop uses max(last_seen_at, server clock).
    await database.db.update(rpgConnectionSessions).set({
      endedAt: sql`GREATEST(${rpgConnectionSessions.lastSeenAt}, ${at})`,
    }).where(and(eq(rpgConnectionSessions.connectionId, event.connectionId),
      eq(rpgConnectionSessions.accountId, event.accountId), isNull(rpgConnectionSessions.endedAt)));
  }
}
