import { randomUUID } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Clock } from '../clock.ts';
import type { Database } from '../database.ts';
import { hashPassword, newSessionToken, normalizeEmail, tokenHash, validatePassword, verifyPassword } from './crypto.ts';
import { AuthError } from './errors.ts';
import { accounts, authSessions, emailCredentials, guestCredentials, liveSessions } from './schema.ts';

export interface AuthIdentity { readonly accountId: string; readonly sessionHash: string; readonly expiresAtMs: number }
export interface IssuedSession { readonly accountId: string; readonly sessionToken: string; readonly expiresAtMs: number }
export interface LiveLease { readonly accountId: string; readonly sessionHash: string; readonly leaseId: string }
export interface AuthServiceOptions { readonly sessionTtlMs?: number; readonly liveLeaseMs?: number }
type Executor = Pick<Database['db'], 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export class AuthService {
  readonly #database: Database;
  readonly #clock: Clock;
  readonly #sessionTtlMs: number;
  readonly #liveLeaseMs: number;
  constructor(database: Database, clock: Clock, options: AuthServiceOptions = {}) {
    this.#database = database; this.#clock = clock;
    this.#sessionTtlMs = duration(options.sessionTtlMs ?? 12 * 60 * 60 * 1000);
    this.#liveLeaseMs = duration(options.liveLeaseMs ?? 30000);
  }
  async #identity(executor: Executor, hash: string): Promise<AuthIdentity> {
    const row = (await executor.select().from(authSessions).where(and(eq(authSessions.tokenHash, hash),
      isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date(this.#clock.nowMs())))))[0];
    if (!row) throw new AuthError('unauthorized');
    return { accountId: row.accountId, sessionHash: row.tokenHash, expiresAtMs: row.expiresAt.getTime() };
  }
  async authenticate(sessionToken: string): Promise<AuthIdentity> {
    return this.#identity(this.#database.db, tokenHash(sessionToken, 'session'));
  }
  async #issue(executor: Executor, accountId: string): Promise<IssuedSession> {
    const now = this.#clock.nowMs(); const expiresAtMs = now + this.#sessionTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new RangeError('session expiry overflow');
    const sessionToken = newSessionToken();
    await executor.insert(authSessions).values({ accountId, tokenHash: tokenHash(sessionToken, 'session'),
      createdAt: new Date(now), expiresAt: new Date(expiresAtMs) });
    return { accountId, sessionToken, expiresAtMs };
  }
  async guest(deviceToken: string): Promise<IssuedSession> {
    const hash = tokenHash(deviceToken, 'device');
    return this.#database.db.transaction(async (tx) => {
      // Serialize first-launch retries before creating identity, avoiding orphan accounts and duplicate devices.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`);
      const existing = (await tx.select().from(guestCredentials).where(eq(guestCredentials.tokenHash, hash)))[0];
      if (existing) {
        await tx.select().from(accounts).where(eq(accounts.id, existing.accountId)).for('update');
        const fresh = (await tx.select().from(guestCredentials).where(eq(guestCredentials.tokenHash, hash)))[0];
        if (!fresh || fresh.disabledAt !== null) throw new AuthError('guest_credential_disabled');
        return this.#issue(tx, existing.accountId);
      }
      const account = (await tx.insert(accounts).values({ createdAt: new Date(this.#clock.nowMs()) }).returning())[0];
      if (!account) throw new Error('account insert failed');
      await tx.insert(guestCredentials).values({ tokenHash: hash, accountId: account.id });
      return this.#issue(tx, account.id);
    });
  }
  async upgrade(sessionToken: string, emailInput: unknown, passwordInput: unknown): Promise<IssuedSession> {
    const initial = await this.authenticate(sessionToken);
    const email = normalizeEmail(emailInput);
    const passwordHash = await hashPassword(passwordInput);
    try {
      return await this.#database.db.transaction(async (tx) => {
        await tx.select().from(accounts).where(eq(accounts.id, initial.accountId)).for('update');
        const identity = await this.#identity(tx, initial.sessionHash);
        const existing = await tx.select().from(emailCredentials).where(eq(emailCredentials.accountId, identity.accountId));
        if (existing.length !== 0) throw new AuthError('already_upgraded', 409);
        await tx.insert(emailCredentials).values({ accountId: identity.accountId, email, passwordHash });
        await tx.update(guestCredentials).set({ disabledAt: new Date(this.#clock.nowMs()) }).where(eq(guestCredentials.accountId, identity.accountId));
        // Rotate every old HTTP/WS credential on upgrade; the account/actor identities remain unchanged.
        await tx.update(authSessions).set({ revokedAt: new Date(this.#clock.nowMs()) }).where(eq(authSessions.accountId, identity.accountId));
        await tx.delete(liveSessions).where(eq(liveSessions.accountId, identity.accountId));
        return this.#issue(tx, identity.accountId);
      });
    } catch (error) {
      if (postgresCode(error) === '23505') throw new AuthError('email_unavailable', 409);
      throw error;
    }
  }
  async signIn(emailInput: unknown, passwordInput: unknown): Promise<IssuedSession> {
    const email = normalizeEmail(emailInput); const password = validatePassword(passwordInput);
    const credentials = (await this.#database.db.select().from(emailCredentials).where(eq(emailCredentials.email, email)))[0];
    if (!await verifyPassword(password, credentials?.passwordHash) || !credentials) throw new AuthError('invalid_credentials');
    return this.#database.db.transaction(async (tx) => {
      await tx.select().from(accounts).where(eq(accounts.id, credentials.accountId)).for('update');
      return this.#issue(tx, credentials.accountId);
    });
  }
  async current(sessionToken: string): Promise<{ accountId: string; guest: boolean; email: string | null; expiresAtMs: number }> {
    const identity = await this.authenticate(sessionToken);
    const email = (await this.#database.db.select().from(emailCredentials).where(eq(emailCredentials.accountId, identity.accountId)))[0]?.email ?? null;
    return { accountId: identity.accountId, guest: email === null, email, expiresAtMs: identity.expiresAtMs };
  }
  async logout(sessionToken: string): Promise<void> {
    const hash = tokenHash(sessionToken, 'session');
    await this.#database.db.transaction(async (tx) => {
      const session = (await tx.select().from(authSessions).where(eq(authSessions.tokenHash, hash)))[0];
      if (!session) return;
      await tx.select().from(accounts).where(eq(accounts.id, session.accountId)).for('update');
      await tx.update(authSessions).set({ revokedAt: new Date(this.#clock.nowMs()) }).where(eq(authSessions.tokenHash, hash));
      await tx.delete(liveSessions).where(eq(liveSessions.sessionHash, hash));
    });
  }
  /** Reject the second active connection, including a second socket using the same HTTP token. */
  async acquireLive(sessionToken: string): Promise<LiveLease> {
    const hash = tokenHash(sessionToken, 'session');
    return this.#database.db.transaction(async (tx) => {
      const first = await this.#identity(tx, hash);
      await tx.select().from(accounts).where(eq(accounts.id, first.accountId)).for('update');
      const identity = await this.#identity(tx, hash);
      const current = (await tx.select().from(liveSessions).where(eq(liveSessions.accountId, identity.accountId)))[0];
      const now = this.#clock.nowMs();
      if (current && current.expiresAt.getTime() > now) throw new AuthError('live_session_active', 409);
      const leaseId = randomUUID(); const expiresAt = new Date(Math.min(now + this.#liveLeaseMs, identity.expiresAtMs));
      await tx.insert(liveSessions).values({ accountId: identity.accountId, sessionHash: hash, leaseId, expiresAt })
        .onConflictDoUpdate({ target: liveSessions.accountId, set: { sessionHash: hash, leaseId, expiresAt } });
      return { accountId: identity.accountId, sessionHash: hash, leaseId };
    });
  }
  /** Rechecks revocation/expiry and fencing before granting another bounded period of live ownership. */
  async renewLive(lease: LiveLease): Promise<AuthIdentity> {
    return this.#database.db.transaction(async (tx) => {
      await tx.select().from(accounts).where(eq(accounts.id, lease.accountId)).for('update');
      const identity = await this.#identity(tx, lease.sessionHash);
      if (identity.accountId !== lease.accountId) throw new AuthError('unauthorized');
      const now = this.#clock.nowMs();
      const updated = await tx.update(liveSessions).set({ expiresAt: new Date(Math.min(now + this.#liveLeaseMs, identity.expiresAtMs)) })
        .where(and(eq(liveSessions.accountId, lease.accountId), eq(liveSessions.sessionHash, lease.sessionHash),
          eq(liveSessions.leaseId, lease.leaseId), gt(liveSessions.expiresAt, new Date(now)))).returning();
      if (updated.length !== 1) throw new AuthError('live_session_expired');
      return identity;
    });
  }
  async releaseLive(lease: LiveLease): Promise<void> {
    await this.#database.db.delete(liveSessions).where(and(eq(liveSessions.accountId, lease.accountId), eq(liveSessions.leaseId, lease.leaseId), eq(liveSessions.sessionHash, lease.sessionHash)));
  }
}
function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30 * 24 * 60 * 60 * 1000) throw new RangeError('invalid auth duration');
  return value;
}
function postgresCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : candidate.cause === error ? undefined : postgresCode(candidate.cause);
}
