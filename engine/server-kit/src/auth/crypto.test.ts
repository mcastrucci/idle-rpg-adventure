import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashPassword, newSessionToken, normalizeEmail, tokenHash, validatePassword, validateToken, verifyPassword } from './crypto.ts';
import { sessionToken, SESSION_COOKIE } from './http.ts';
import { AuthRateLimiter } from './rate-limit.ts';
import { ManualClock } from '../clock.ts';

it('accepts canonical 256-bit random tokens and separates device/session hashes', () => {
  const token = newSessionToken();
  expect(validateToken(token)).toBe(token);
  expect(tokenHash(token, 'device')).not.toBe(tokenHash(token, 'session'));
  expect(tokenHash(token, 'session')).toMatch(/^[a-f0-9]{64}$/);
  for (const invalid of ['device:phone123', 'abc', 'A'.repeat(43), token + '=', randomBytes(16).toString('base64url')]) {
    expect(() => validateToken(invalid)).toThrow();
  }
});
it('normalizes email identities consistently and bounds password input', () => {
  expect(normalizeEmail(' Guest+Test@Example.COM ')).toBe('guest+test@example.com');
  for (const invalid of ['not-an-email', 'a..b@example.com', 'a@', 'a@例.com']) expect(() => normalizeEmail(invalid)).toThrow();
  expect(validatePassword('twelve-char password')).toBe('twelve-char password');
  expect(() => validatePassword('short')).toThrow();
  expect(() => validatePassword('a'.repeat(257))).toThrow();
});
it('uses async salted scrypt and rejects wrong passwords, unknown accounts and corrupt hashes', async () => {
  const password = 'my deliberately long password';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  expect(first).not.toBe(second);
  expect(first).not.toContain(password);
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword('a different long password', first)).toBe(false);
  expect(await verifyPassword(password, undefined)).toBe(false);
  expect(await verifyPassword(password, 'scrypt$corrupt')).toBe(false);
}, 15000);
it('bounds password hashing concurrency without queueing attacker-controlled work', async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => hashPassword('another valid long password')));
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
  expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
}, 10000);
describe('HTTP bearer/cookie credentials', () => {
  it('accepts a bearer token or host-only cookie and rejects ambiguous/invalid credentials', () => {
    const token = newSessionToken();
    expect(sessionToken({ headers: { authorization: `Bearer ${token}` } })).toBe(token);
    expect(sessionToken({ headers: { cookie: `other=value; ${SESSION_COOKIE}=${token}` } })).toBe(token);
    expect(() => sessionToken({ headers: {} })).toThrow();
    expect(() => sessionToken({ headers: { cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}` } })).toThrow();
    expect(() => sessionToken({ headers: { authorization: 'Bearer invalid', cookie: `${SESSION_COOKIE}=${token}` } })).toThrow();
  });
});
it('enforces bounded rate buckets and expiry against the injected clock', () => {
  const clock = new ManualClock();
  const limiter = new AuthRateLimiter(clock, 2, 1000, 2);
  limiter.consume('a'); limiter.consume('a');
  expect(() => limiter.consume('a')).toThrow();
  limiter.consume('b');
  expect(() => limiter.consume('c')).toThrow();
  clock.advance(1000);
  expect(() => limiter.consume('c')).not.toThrow();
});
