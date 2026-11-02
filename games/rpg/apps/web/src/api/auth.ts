import type { ApiClient } from './http.ts';
import { ApiError } from './http.ts';
import type { SessionDto } from './types.ts';

export const DEVICE_TOKEN_KEY = 'rpg.deviceToken';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 32 CSPRNG bytes as unpadded base64url (43 chars), the credential format the server's guest login requires.
 * Uniform-byte values are rejected by the server, so they are (astronomically rarely) regenerated here.
 */
export function generateDeviceToken(fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => { globalThis.crypto.getRandomValues(bytes); }): string {
  const bytes = new Uint8Array(32);
  do fill(bytes); while (bytes.every((byte) => byte === bytes[0]));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The device token is the guest account's only credential. Browsers offer no secure enclave, so it lives in
 * localStorage (Capacitor builds should move it to secure storage, ADR-0011).
 */
export function loadOrCreateDeviceToken(storage: KeyValueStore, generate: () => string = generateDeviceToken): string {
  const existing = storage.getItem(DEVICE_TOKEN_KEY);
  if (existing !== null && TOKEN_PATTERN.test(existing)) return existing;
  const token = generate();
  storage.setItem(DEVICE_TOKEN_KEY, token);
  return token;
}

/**
 * Reuses the cookie session if it is still valid; otherwise signs in as this device's guest (creating the account
 * on first launch). The server sets the HttpOnly session cookie used by both HTTP and the live socket.
 */
export async function ensureSession(api: ApiClient, storage: KeyValueStore): Promise<SessionDto> {
  try {
    return await api.session();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  await api.guest(loadOrCreateDeviceToken(storage));
  return api.session();
}
