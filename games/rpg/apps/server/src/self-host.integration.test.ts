import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { createDatabase, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRpgDatabase, createRpgServer } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI needs PostgreSQL for self-hosting proxy integration');

const PUBLIC = 'https://example.test';
const token = () => randomBytes(32).toString('base64url');
/** What a TLS-terminating proxy (cloudflared, Caddy, nginx) forwards for a browser at https://example.test. */
const proxied = (origin = PUBLIC) => ({ host: 'example.test', origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' });

describe.skipIf(!adminUrl)('self-hosting behind a TLS proxy', () => {
  let admin: Database;
  let database: Database;
  let base: ServerConfig;
  let directory: string;
  let dist: string;
  const databaseName = `selfhost_test_${randomUUID().replaceAll('-', '')}`;
  const sockets = new Set<WebSocket>();
  const apps: Awaited<ReturnType<typeof createRpgServer>>[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'selfhost-integration-'));
    dist = join(directory, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Idle RPG web</title><div id="root"></div>');
    await writeFile(join(dist, 'assets', 'index-AbC123xy.js'), 'export {};');
    await writeFile(join(directory, 'secret.txt'), 'outside the dist directory');
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(compiled.bundle));
    const parsed = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'silent' });
    admin = createDatabase(parsed);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(parsed.databaseUrl); url.pathname = `/${databaseName}`;
    base = { ...parsed, databaseUrl: url.toString() };
    database = createRpgDatabase(base);
    await database.migrate();
  }, 30_000);
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    for (const app of apps) await app.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** Boots a server from environment variables exactly as `main.ts` does (parseServerConfig), then listens on loopback. */
  async function boot(env: Record<string, string>) {
    const config = { ...parseServerConfig({ DATABASE_URL: base.databaseUrl, CONTENT_BUNDLE_PATH: base.contentBundlePath, LOG_LEVEL: 'silent', ...env }) };
    const app = await createRpgServer(config);
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, address };
  }
  async function session(app: Awaited<ReturnType<typeof createRpgServer>>) {
    const response = await app.inject({ method: 'POST', url: '/auth/guest', payload: { deviceToken: token() } });
    expect(response.statusCode).toBe(200);
    return response.json<{ sessionToken: string; accountId: string }>();
  }
  const cookie = (sessionToken: string) => `__Host-idle_session=${sessionToken}`;
  async function postCharacter(app: Awaited<ReturnType<typeof createRpgServer>>, sessionToken: string, headers: Record<string, string>, remoteAddress?: string) {
    return await app.inject({ method: 'POST', url: '/characters', headers: { cookie: cookie(sessionToken), ...headers },
      ...(remoteAddress ? { remoteAddress } : {}),
      payload: { command_id: randomUUID(), operation: 'character.create', payload: { name: 'Tunnel hero' } } });
  }
  /** Resolves with the first message of an accepted upgrade, or the HTTP status of a refused one. */
  async function upgrade(address: string, sessionToken: string, headers: Record<string, string>): Promise<{ status: number; first?: string }> {
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/auth/live', { headers: { cookie: cookie(sessionToken), ...headers } });
    sockets.add(socket);
    return await new Promise((resolve) => {
      socket.on('message', (data) => { resolve({ status: 101, first: data.toString() }); socket.close(); });
      socket.on('unexpected-response', (_request, response) => { resolve({ status: response.statusCode ?? 0 }); socket.terminate(); });
      socket.on('error', () => { /* reported through unexpected-response */ });
    });
  }

  it('rejects proxied browser mutations and WebSocket upgrades by default (strict same-origin)', async () => {
    const { app, address } = await boot({});
    const { sessionToken } = await session(app);
    expect((await postCharacter(app, sessionToken, proxied())).statusCode).toBe(403);
    expect((await upgrade(address, sessionToken, proxied())).status).toBe(403);
    // A real same-origin plain-HTTP browser request is still accepted.
    const direct = { host: 'example.test', origin: 'http://example.test' };
    expect((await postCharacter(app, sessionToken, direct)).statusCode).toBe(201);
    expect((await upgrade(address, sessionToken, direct)).status).toBe(101);
    expect((await postCharacter(app, sessionToken, proxied('https://evil.test'))).statusCode).toBe(403);
  }, 15_000);

  it.each([['true', 'true'], ['loopback', 'loopback'], ['an explicit proxy CIDR list', '127.0.0.0/8,10.0.0.0/8']])(
    'accepts the public https origin when TRUST_PROXY=%s and still rejects foreign origins', async (_label, value) => {
      const { app, address } = await boot({ TRUST_PROXY: value });
      const { sessionToken } = await session(app);
      expect((await postCharacter(app, sessionToken, proxied())).statusCode).toBe(201);
      const accepted = await upgrade(address, sessionToken, proxied());
      expect(accepted.status).toBe(101);
      expect(JSON.parse(accepted.first ?? '{}')).toMatchObject({ type: 'authenticated' });
      expect((await postCharacter(app, sessionToken, proxied('https://evil.test'))).statusCode).toBe(403);
      expect((await upgrade(address, sessionToken, proxied('https://evil.test'))).status).toBe(403);
      // A proxy-forged protocol does not make a plain-http origin match the https expectation.
      expect((await postCharacter(app, sessionToken, { ...proxied('http://example.test') })).statusCode).toBe(403);
    }, 15_000);

  it('ignores X-Forwarded-* from peers that are not listed proxies', async () => {
    const { app } = await boot({ TRUST_PROXY: '10.0.0.0/8' });
    const { sessionToken } = await session(app);
    expect((await postCharacter(app, sessionToken, proxied(), '10.1.2.3')).statusCode).toBe(201);
    expect((await postCharacter(app, sessionToken, proxied(), '203.0.113.9')).statusCode).toBe(403);
    expect((await postCharacter(app, sessionToken, proxied())).statusCode).toBe(403); // default inject peer is 127.0.0.1
  }, 15_000);

  it('accepts an ALLOWED_ORIGINS entry on HTTP and WebSocket without a trusted proxy, and rejects every other origin', async () => {
    const { app, address } = await boot({ ALLOWED_ORIGINS: `${PUBLIC},https://other.test:8443` });
    const { sessionToken } = await session(app);
    expect((await postCharacter(app, sessionToken, proxied())).statusCode).toBe(201);
    expect((await postCharacter(app, (await session(app)).sessionToken, { host: 'whatever.internal', origin: 'https://other.test:8443' })).statusCode).toBe(201);
    expect((await upgrade(address, sessionToken, proxied())).status).toBe(101);
    // Exact match only: no scheme downgrade, port change or subdomain is implied.
    for (const origin of ['http://other.test:8443', 'https://example.test:444', 'https://sub.example.test', 'https://evil.test', 'null']) {
      expect((await postCharacter(app, sessionToken, { ...proxied(), origin })).statusCode, origin).toBe(403);
      expect((await upgrade(address, sessionToken, { ...proxied(), origin })).status, origin).toBe(403);
    }
    // The HTTP auth routes honour the same list.
    expect((await app.inject({ method: 'POST', url: '/auth/guest', headers: proxied(), payload: { deviceToken: token() } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/guest', headers: proxied('https://evil.test'), payload: { deviceToken: token() } })).statusCode).toBe(403);
  }, 15_000);

  it('serves the web build from WEB_DIST_DIR on the same origin without disturbing API, health or WebSocket routes', async () => {
    const { app, address } = await boot({ WEB_DIST_DIR: dist, TRUST_PROXY: 'true', ALLOWED_ORIGINS: PUBLIC });
    const html = { accept: 'text/html' };
    const root = await app.inject({ url: '/', headers: html });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.body).toContain('Idle RPG web');
    expect((await app.inject({ url: '/world/live/area%3Aone', headers: html })).body).toContain('Idle RPG web');
    const asset = await app.inject('/assets/index-AbC123xy.js');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toContain('immutable');
    // API, health and content routes are untouched, even when the browser asks for HTML.
    expect((await app.inject({ url: '/health/ready', headers: html })).json()).toMatchObject({ status: 'ok' });
    expect((await app.inject({ url: '/content', headers: html })).json()).toMatchObject({ game: 'rpg' });
    expect((await app.inject({ url: '/characters', headers: html })).statusCode).toBe(401);
    expect((await app.inject({ url: '/debug/clock', headers: html })).statusCode).toBe(404);
    const unknownApi = await app.inject({ url: '/characters/does/not/exist', headers: html });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers['content-type']).toMatch(/json/);
    const { sessionToken } = await session(app);
    expect((await postCharacter(app, sessionToken, proxied())).statusCode).toBe(201);
    expect((await upgrade(address, sessionToken, proxied())).status).toBe(101);
    // Raw requests keep dot-segments intact, so path traversal is exercised over a real socket.
    for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(address);
        const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
          let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }); });
        });
        req.on('error', reject); req.end();
      });
      expect(response.body, path).not.toContain('outside the dist directory');
      expect([400, 404], path).toContain(response.status);
    }
  }, 20_000);

  it('does not serve any web app unless WEB_DIST_DIR is set', async () => {
    const { app } = await boot({});
    expect((await app.inject({ url: '/', headers: { accept: 'text/html' } })).statusCode).toBe(404);
  });
});
