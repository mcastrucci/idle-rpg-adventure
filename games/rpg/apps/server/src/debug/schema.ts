import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Environment-wide debug time offset (issue #31). At most one row; every role of one deployment reads it, so API, live
 * and worker processes agree on the travelled time. Forward-only: the offset can grow, never shrink.
 */
export const rpgDebugClock = pgTable('rpg_debug_clock', {
  id: text('id').primaryKey(),
  offsetMs: bigint('offset_ms', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [
  check('rpg_debug_clock_singleton', sql`${table.id} = 'environment'`),
  check('rpg_debug_clock_offset', sql`${table.offsetMs} >= 0`),
]);
