import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Clock } from '../clock.ts';
import type { Database } from '../database.ts';

import { canonicalCommandJson } from './json.ts';
import type { JsonValue } from './json.ts';
import { commandLog } from './schema.ts';

export type CommandTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
export interface CommandEnvelope { readonly commandId: string; readonly operation: string; readonly payload: JsonValue }
export interface CommandResponse { readonly status: number; readonly body: JsonValue }
export interface CommandOptions { readonly retentionMs?: number }
export const COMMAND_RETENTION_MS = 24 * 60 * 60 * 1000;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Authenticate and authorize first. All durable handler mutations MUST use tx; external effects need an outbox. */
export async function runCommand(database: Database, clock: Clock, accountId: string, envelope: CommandEnvelope,
  handler: (tx: CommandTransaction) => Promise<CommandResponse>, options: CommandOptions = {}): Promise<CommandResponse> {
  const { commandId, operation, payload } = envelope;
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(commandId) || operation.length > 80 || !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){1,3}$/.test(operation)) {
    throw new TypeError('invalid command envelope');
  }
  const retentionMs = options.retentionMs ?? COMMAND_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || retentionMs > 90 * 24 * 60 * 60 * 1000) throw new RangeError('invalid command retention');
  const fingerprint = createHash('sha256').update(canonicalCommandJson(payload)).digest('hex');
  const now = clock.nowMs();
  const expiresAt = now + retentionMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000) throw new RangeError('invalid command clock');
  return database.db.transaction(async (tx) => {
    const key = and(eq(commandLog.accountId, accountId), eq(commandLog.commandId, commandId));
    // ON CONFLICT waits for a racing uncommitted insert. If it rolls back this request becomes the owner.
    const inserted = await tx.insert(commandLog).values({ accountId, commandId, operation,
      fingerprint, createdAt: new Date(now), expiresAt: new Date(expiresAt) }).onConflictDoNothing().returning({ id: commandLog.commandId });
    if (inserted.length === 0) {
      // READ COMMITTED now observes the winning commit. Lock serializes replay with tombstone cleanup.
      const [stored] = await tx.select().from(commandLog).where(key).for('update');
      if (!stored) throw new Error('command disappeared');
      if (stored.operation !== operation || stored.fingerprint !== fingerprint) return { status: 409, body: { error: 'command_id_conflict' } };
      if (stored.tombstonedAt !== null || stored.expiresAt.getTime() <= clock.nowMs()) return { status: 410, body: { error: 'command_expired' } };
      if (stored.responseStatus === null || stored.responseBody === null) throw new Error('incomplete committed command');
      return { status: stored.responseStatus, body: JSON.parse(stored.responseBody) as JsonValue };
    }
    const result = await handler(tx);
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new TypeError('invalid command response status');
    const responseBody = canonicalCommandJson(result.body);
    await tx.update(commandLog).set({ responseStatus: result.status, responseBody }).where(key);
    return { status: result.status, body: JSON.parse(responseBody) as JsonValue };
  });
}
