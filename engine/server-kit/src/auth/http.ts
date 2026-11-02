import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Clock } from '../clock.ts';
import type { Database } from '../database.ts';
import { normalizeEmail, validateToken } from './crypto.ts';
import { AuthError } from './errors.ts';
import { AuthRateLimiter } from './rate-limit.ts';
import { AuthService } from './service.ts';
import type { AuthIdentity, IssuedSession } from './service.ts';

export const SESSION_COOKIE = '__Host-idle_session';
export interface AuthContext { readonly database: Database; readonly clock: Clock }

/** Shared by sibling Fastify modules; authorization never depends on an encapsulated decorator. */
export function requireAccount(request: FastifyRequest, context: AuthContext): Promise<AuthIdentity> {
  return new AuthService(context.database, context.clock).authenticate(sessionToken(request));
}
export function sessionToken(request: Pick<FastifyRequest, 'headers'>): string {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    if (!authorization.startsWith('Bearer ') || authorization.length !== 50) throw new AuthError('unauthorized');
    return validateToken(authorization.slice(7));
  }
  const cookies = (request.headers.cookie ?? '').split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1) throw new AuthError('unauthorized');
  return validateToken((cookies[0] as string).slice(SESSION_COOKIE.length + 1));
}
/** Reject cross-origin browser requests, including WebSocket upgrades. Explicit origins support TLS proxies. */
export function checkOrigin(request: FastifyRequest, allowedOrigins: readonly string[] = []): void {
  const origin = request.headers.origin;
  if (origin === undefined) return; // Native clients use Bearer authentication without a browser Origin.
  if (allowedOrigins.includes(origin)) return;
  const expected = `${request.protocol}://${request.headers.host ?? ''}`;
  if (origin !== expected) throw new AuthError('origin_forbidden', 403);
}
function body(request: FastifyRequest, required: readonly string[]): Record<string, unknown> {
  const input = request.body;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new AuthError('invalid_body', 400);
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== required.length || required.some((key) => !Object.hasOwn(record, key))) throw new AuthError('invalid_body', 400);
  return record;
}
function issue(reply: FastifyReply, session: IssuedSession, clock: Clock): IssuedSession {
  const maxAge = Math.max(0, Math.floor((session.expiresAtMs - clock.nowMs()) / 1000));
  reply.header('set-cookie', `${SESSION_COOKIE}=${session.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  return session;
}
export interface HttpAuthOptions { readonly allowedOrigins?: readonly string[]; readonly rateLimit?: number }

export function registerAuthHttp(app: FastifyInstance, context: AuthContext, service: AuthService, options: HttpAuthOptions = {}): void {
  const ipLimiter = new AuthRateLimiter(context.clock, options.rateLimit ?? 30);
  const emailLimiter = new AuthRateLimiter(context.clock, 10);
  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      checkOrigin(request, options.allowedOrigins);
      ipLimiter.consume(request.ip);
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.code });
      const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ error: 'invalid_body' });
      scope.log.error({ code: 'auth_request_failed' }, 'authentication request failed');
      return reply.code(500).send({ error: 'auth_unavailable' });
    });
    scope.post('/auth/guest', { bodyLimit: 4096 }, async (request, reply) => {
      const input = body(request, ['deviceToken']);
      if (typeof input['deviceToken'] !== 'string') throw new AuthError('invalid_body', 400);
      return issue(reply, await service.guest(input['deviceToken']), context.clock);
    });
    scope.post('/auth/signin', { bodyLimit: 4096 }, async (request, reply) => {
      const input = body(request, ['email', 'password']);
      const email = normalizeEmail(input['email']);
      emailLimiter.consume(createHash('sha256').update(email).digest('hex'));
      return issue(reply, await service.signIn(email, input['password']), context.clock);
    });
    scope.post('/auth/upgrade', { bodyLimit: 4096 }, async (request, reply) => {
      const input = body(request, ['email', 'password']);
      return issue(reply, await service.upgrade(sessionToken(request), input['email'], input['password']), context.clock);
    });
    scope.post('/auth/logout', { bodyLimit: 4096 }, async (request, reply) => {
      await service.logout(sessionToken(request));
      reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return reply.code(204).send();
    });
    scope.get('/auth/session', async (request) => service.current(sessionToken(request)));
  });
}
