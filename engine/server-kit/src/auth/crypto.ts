import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { AuthError } from './errors.ts';

// OWASP's scrypt profile. Node's asynchronous API runs outside the event loop; bound concurrent memory use.
const COST = 131072;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const MAX_MEMORY = 192 * 1024 * 1024;
const KEY_BYTES = 32;
const MAX_PASSWORD_WORK = 2;
let passwordWork = 0;

export function newSessionToken(): string { return randomBytes(32).toString('base64url'); }
/** Device/session tokens are canonical encodings of exactly 256 bits, never IDs or arbitrary user strings. */
export function validateToken(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input)) throw new AuthError('invalid_token');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== input || bytes.every((byte) => byte === bytes[0])) {
    throw new AuthError('invalid_token');
  }
  return input;
}
export function tokenHash(input: string, purpose: 'device' | 'session'): string {
  return createHash('sha256').update(purpose).update(':').update(validateToken(input)).digest('hex');
}
export function normalizeEmail(input: unknown): string {
  if (typeof input !== 'string') throw new AuthError('invalid_email', 400);
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ||
      email.includes('..') || email.startsWith('.') || email.includes('.@')) throw new AuthError('invalid_email', 400);
  return email;
}
export function validatePassword(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') < 12 || Buffer.byteLength(input, 'utf8') > 256) {
    throw new AuthError('invalid_password', 400);
  }
  return input;
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (passwordWork >= MAX_PASSWORD_WORK) throw new AuthError('password_capacity', 429);
  passwordWork++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, KEY_BYTES,
      { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key)));
  } finally { passwordWork--; }
}
export async function hashPassword(input: unknown): Promise<string> {
  const password = validatePassword(input);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('hex')}$${key.toString('hex')}`;
}
/** Unknown email still performs the same asynchronous work, avoiding a cheap account-enumeration timing path. */
export async function verifyPassword(input: unknown, stored: string | undefined): Promise<boolean> {
  const password = validatePassword(input);
  const parts = stored?.split('$');
  const valid = parts?.length === 6 && parts[0] === 'scrypt' && parts[1] === String(COST) &&
    parts[2] === String(BLOCK_SIZE) && parts[3] === String(PARALLELISM) && /^[a-f0-9]{32}$/.test(parts[4] ?? '') && /^[a-f0-9]{64}$/.test(parts[5] ?? '');
  const salt = valid ? Buffer.from(parts[4] as string, 'hex') : Buffer.alloc(16);
  const expected = valid ? Buffer.from(parts[5] as string, 'hex') : Buffer.alloc(KEY_BYTES);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && valid;
}
