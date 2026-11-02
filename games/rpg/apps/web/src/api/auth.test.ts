import { describe, expect, it } from 'vitest';

import { DEVICE_TOKEN_KEY, ensureSession, generateDeviceToken, loadOrCreateDeviceToken } from './auth.ts';
import { ApiClient } from './http.ts';
import type { FetchLike } from './http.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('device token', () => {
  it('is 32 random bytes as canonical unpadded base64url', () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateDeviceToken()).not.toBe(token);
    const bytes = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) => char.charCodeAt(0));
    expect(bytes).toHaveLength(32);
  });

  it('regenerates uniform-byte values, which the server rejects', () => {
    let calls = 0;
    const token = generateDeviceToken((bytes) => {
      const first = calls++ === 0;
      bytes.fill(first ? 7 : 0);
      if (!first) bytes[0] = 1;
    });
    expect(calls).toBe(2);
    expect(token).toHaveLength(43);
  });

  it('persists one token per device and replaces malformed values', () => {
    const storage = memoryStorage({ [DEVICE_TOKEN_KEY]: 'garbage' });
    const token = loadOrCreateDeviceToken(storage);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadOrCreateDeviceToken(storage)).toBe(token);
  });
});

describe('ensureSession', () => {
  const session = { accountId: 'acc', guest: true, email: null, expiresAtMs: 1 };

  it('reuses a valid cookie session without logging in', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (input, init) => { calls.push(`${init?.method} ${input}`); return Response.json(session); };
    await expect(ensureSession(new ApiClient(fetch), memoryStorage())).resolves.toEqual(session);
    expect(calls).toEqual(['GET /auth/session']);
  });

  it('logs in as the device guest when the session is missing or expired', async () => {
    const calls: string[] = [];
    let authenticated = false;
    const storage = memoryStorage();
    const fetch: FetchLike = async (input, init) => {
      calls.push(`${init?.method} ${input}`);
      if (input === '/auth/guest') {
        expect(JSON.parse(String(init?.body))).toEqual({ deviceToken: storage.getItem(DEVICE_TOKEN_KEY) });
        authenticated = true;
        return Response.json({ accountId: 'acc', sessionToken: 't', expiresAtMs: 1 });
      }
      return authenticated ? Response.json(session) : Response.json({ error: 'unauthorized' }, { status: 401 });
    };
    await expect(ensureSession(new ApiClient(fetch), storage)).resolves.toEqual(session);
    expect(calls).toEqual(['GET /auth/session', 'POST /auth/guest', 'GET /auth/session']);
  });

  it('surfaces other failures', async () => {
    const fetch: FetchLike = async () => Response.json({ error: 'auth_unavailable' }, { status: 500 });
    await expect(ensureSession(new ApiClient(fetch), memoryStorage())).rejects.toMatchObject({ status: 500, code: 'auth_unavailable' });
  });
});
