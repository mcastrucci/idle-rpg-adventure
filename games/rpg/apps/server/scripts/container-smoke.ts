import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const baseUrl = process.env['SMOKE_BASE_URL'] ?? 'http://127.0.0.1:3000';
const timeoutMs = 10_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await response.json().catch(() => null);
  return { response, body };
}

class SocketClosed extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`WebSocket closed with code ${code}`);
    this.code = code;
  }
}

class SocketObserver {
  private opened = false;
  private failure: Error | undefined;
  private readonly frames: string[] = [];
  private wake: (() => void) | undefined;

  constructor(socket: WebSocket) {
    // Install observers before the upgrade can deliver the authenticated greeting.
    socket.on('open', () => { this.opened = true; this.wake?.(); });
    socket.on('message', (data: WebSocket.RawData) => {
      if (this.frames.length >= 8) this.failure = new Error('too many queued WebSocket frames');
      else this.frames.push(data.toString());
      this.wake?.();
    });
    socket.on('error', () => { this.failure ??= new Error('WebSocket connection failed'); this.wake?.(); });
    socket.on('close', (code: number) => { this.failure ??= new SocketClosed(code); this.wake?.(); });
  }

  private async waitForChange(timeout: number, message: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        reject(new Error(message));
      }, timeout);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  async waitForOpen(timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!this.opened && !this.failure) {
      await this.waitForChange(Math.max(1, deadline - Date.now()), 'timed out opening authenticated WebSocket');
    }
    if (this.failure) throw this.failure;
  }

  async nextFrame(timeout: number): Promise<string> {
    const deadline = Date.now() + timeout;
    while (this.frames.length === 0 && !this.failure) {
      await this.waitForChange(Math.max(1, deadline - Date.now()), 'timed out waiting for authenticated WebSocket frame');
    }
    const frame = this.frames.shift();
    if (frame !== undefined) return frame;
    throw this.failure ?? new Error('WebSocket closed before the expected frame');
  }
}

async function closeSocket(socket: WebSocket, timeout: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          socket.terminate();
          reject(new Error('WebSocket did not close within the cleanup deadline'));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectAndPing(token: string, timeout = timeoutMs): Promise<'ok' | 'lease-active'> {
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  const endpoint = `${baseUrl.replace(/^http/, 'ws')}/auth/live`;
  const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` } });
  const observer = new SocketObserver(socket);
  let opened = false;
  try {
    try {
      await observer.waitForOpen(remaining());
      opened = true;
    } catch (error) {
      if (error instanceof SocketClosed && error.code === 4409) return 'lease-active';
      throw error;
    }

    let greetingText: string;
    try { greetingText = await observer.nextFrame(remaining()); }
    catch (error) {
      if (error instanceof SocketClosed && error.code === 4409) return 'lease-active';
      throw error;
    }
    let greeting: unknown;
    try { greeting = JSON.parse(greetingText) as unknown; }
    catch { throw new Error('authenticated WebSocket greeting was not valid JSON'); }
    assert(isRecord(greeting) && greeting['type'] === 'authenticated', 'unexpected authenticated WebSocket greeting');
    socket.send('ping');
    const pong = await observer.nextFrame(remaining());
    assert(pong === 'pong', 'authenticated WebSocket did not return the expected pong frame');
    return 'ok';
  } finally {
    // A 4409 response is a deliberate lease refusal; close it promptly before retrying.
    await closeSocket(socket, remaining());
    if (!opened && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

async function main(): Promise<void> {
  const readyDeadline = Date.now() + 60_000;
  let ready: Awaited<ReturnType<typeof fetchJson>> | undefined;
  while (Date.now() < readyDeadline) {
    try {
      const result = await fetchJson(`${baseUrl}/health/ready`);
      if (result.response.ok) { ready = result; break; }
    } catch { /* The process may still be starting after the container enters running state. */ }
    await delay(250);
  }
  assert(ready, 'server did not become ready within 60 seconds');
  assert(ready.response.ok, `readiness returned HTTP ${ready.response.status}`);
  assert(isRecord(ready.body), 'readiness response was not an object');
  assert(ready.body['status'] === 'ok', 'readiness body did not report ok');
  assert(Array.isArray(ready.body['roles']), 'readiness response omitted server roles');
  const roles = ready.body['roles'];
  for (const role of ['api', 'live', 'worker']) assert(roles.includes(role), `server missing ${role} role`);
  assert(typeof ready.body['contentHash'] === 'string' && ready.body['contentHash'].length > 0, 'server did not load compiled RPG content');
  process.stdout.write(`readiness ok; roles=${roles.join(',')}; compiled content loaded\n`);

  const debug = await fetch(`${baseUrl}/debug/clock`, { signal: AbortSignal.timeout(timeoutMs) });
  assert(debug.status === 404, `debug/admin routes should be disabled (received HTTP ${debug.status})`);
  process.stdout.write('debug/admin routes disabled\n');

  // The image serves the production web build on the same origin as the API (WEB_DIST_DIR).
  const page = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  const html = await page.text();
  assert(page.status === 200, `GET / returned HTTP ${page.status}`);
  assert((page.headers.get('content-type') ?? '').startsWith('text/html'), 'GET / did not return HTML');
  assert(html.includes('<div id="root">'), 'GET / did not return the web app shell');
  assert(page.headers.get('cache-control') === 'no-cache', 'index.html must be served with no-cache');
  const deepLink = await fetch(`${baseUrl}/character/rules`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  assert(deepLink.status === 200 && (await deepLink.text()).includes('<div id="root">'), 'SPA deep link did not fall back to index.html');
  const assetPath = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert(assetPath !== undefined, 'index.html does not reference a bundled script');
  const asset = await fetch(`${baseUrl}${assetPath}`, { signal: AbortSignal.timeout(timeoutMs) });
  assert(asset.status === 200 && (asset.headers.get('content-type') ?? '').startsWith('text/javascript'), 'web bundle was not served as JavaScript');
  await asset.arrayBuffer();
  assert((asset.headers.get('cache-control') ?? '').includes('immutable'), 'hashed web bundle must be cached immutably');
  const apiMiss = await fetch(`${baseUrl}/characters/unknown/route`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  assert(apiMiss.status === 404 && (apiMiss.headers.get('content-type') ?? '').includes('json'), 'API paths must not fall back to the web app');
  await apiMiss.arrayBuffer();
  process.stdout.write('web app served on the API origin ok\n');

  const guest = await fetchJson(`${baseUrl}/auth/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceToken: randomBytes(32).toString('base64url') }),
  });
  assert(guest.response.ok, `guest authentication returned HTTP ${guest.response.status}`);
  assert(isRecord(guest.body), 'guest response was not an object');
  assert(typeof guest.body['accountId'] === 'string' && typeof guest.body['sessionToken'] === 'string', 'guest response missing account/session');
  process.stdout.write('guest authentication ok\n');

  const sessionToken = guest.body['sessionToken'];
  assert(typeof sessionToken === 'string', 'guest session token was not a string');
  assert(await connectAndPing(sessionToken) === 'ok', 'initial live WebSocket was refused by an existing lease');
  process.stdout.write('authenticated WebSocket handshake and ping/pong ok\n');

  // A clean close releases the single-live-session lease. Only a 4409 lease refusal is retried.
  const deadline = Date.now() + timeoutMs;
  let released = false;
  while (!released && Date.now() < deadline) {
    const result = await connectAndPing(sessionToken, Math.max(1, deadline - Date.now()));
    if (result === 'ok') released = true;
    else await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  assert(released, 'live-session lease was not released after WebSocket close');
  process.stdout.write('WebSocket lease release observed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`container smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
