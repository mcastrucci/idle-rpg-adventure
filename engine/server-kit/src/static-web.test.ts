import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerStaticWeb } from './static-web.ts';

const HTML = { accept: 'text/html,application/xhtml+xml' };

describe('static web index.html containment', () => {
  it('refuses to start when index.html is a symlink escaping the directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'static-web-index-'));
    try {
      const dist = join(base, 'dist');
      await mkdir(dist, { recursive: true });
      await writeFile(join(base, 'outside.txt'), 'outside the dist directory');
      await symlink(join(base, 'outside.txt'), join(dist, 'index.html'));
      const app = Fastify({ logger: false });
      await expect(registerStaticWeb(app, { dir: dist })).rejects.toThrow('index.html');
      await app.close();
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('serves a symlinked index.html that stays inside the directory at / and through the SPA fallback', async () => {
    const base = await mkdtemp(join(tmpdir(), 'static-web-index-'));
    const app = Fastify({ logger: false });
    try {
      const dist = join(base, 'dist');
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, 'shell.html'), '<!doctype html><title>inside</title>');
      await symlink(join(dist, 'shell.html'), join(dist, 'index.html'));
      await registerStaticWeb(app, { dir: dist });
      await app.ready();
      for (const url of ['/', '/world/live']) {
        const response = await app.inject({ url, headers: HTML });
        expect(response.statusCode, url).toBe(200);
        expect(response.body).toContain('<title>inside</title>');
      }
    } finally { await app.close(); await rm(base, { recursive: true, force: true }); }
  });
});

describe('same-origin static web hosting', () => {
  let base: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'static-web-'));
    const dist = join(base, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>spa</title>');
    await writeFile(join(dist, 'assets', 'index-AbC123xy.js'), 'export {};');
    await writeFile(join(dist, 'assets', 'index-AbC123xy.css'), 'body{}');
    await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(dist, '.env'), 'SECRET=1');
    await writeFile(join(base, 'secret.txt'), 'outside the dist directory');
    await symlink(join(base, 'secret.txt'), join(dist, 'linked.txt'));
    app = Fastify({ logger: false });
    app.get('/api/ping', async () => ({ pong: true }));
    app.post('/api/ping', async () => ({ posted: true }));
    await registerStaticWeb(app, { dir: dist, reservedPrefixes: ['/api'] });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await rm(base, { recursive: true, force: true }); });

  it('serves index.html at / with no-cache and falls back to it for extension-less SPA routes', async () => {
    for (const url of ['/', '/index.html', '/world/live/area%3Aone', '/character/rules?tab=1']) {
      const response = await app.inject({ url, headers: HTML });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.body).toContain('<title>spa</title>');
    }
  });

  it('serves assets with their content type and immutable caching for hashed bundles', async () => {
    const js = await app.inject('/assets/index-AbC123xy.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('export {};');
    const css = await app.inject('/assets/index-AbC123xy.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    const svg = await app.inject('/favicon.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['cache-control']).toBe('no-cache');
  });

  it('supports HEAD and conditional requests', async () => {
    const head = await app.inject({ method: 'HEAD', url: '/assets/index-AbC123xy.js' });
    expect(head.statusCode).toBe(200); expect(head.headers['content-length']).toBe('10'); expect(head.body).toBe('');
    const first = await app.inject('/favicon.svg');
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect((await app.inject({ url: '/favicon.svg', headers: { 'if-none-match': etag } })).statusCode).toBe(304);
  });

  it('never shadows registered routes and keeps JSON 404s for API paths, missing files and non-GET methods', async () => {
    expect((await app.inject({ url: '/api/ping', headers: HTML })).json()).toEqual({ pong: true });
    expect((await app.inject({ method: 'POST', url: '/api/ping' })).json()).toEqual({ posted: true });
    for (const request of [
      { url: '/api/unknown', headers: HTML }, // reserved prefix: no SPA fallback
      { url: '/world/live' }, // not a browser navigation
      { url: '/assets/missing-AbC123xy.js', headers: HTML }, // has an extension
      { method: 'POST' as const, url: '/world' }, { method: 'PUT' as const, url: '/index.html' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode, JSON.stringify(request)).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('never serves anything outside the dist directory or dotfiles', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt',
      '/assets/../../secret.txt', '/%2e%2e%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..\\secret.txt',
      '/%5c..%5csecret.txt', '/%00', '/index.html%00.png', '/%E0%A4%A', '/linked.txt', '/.env', '/assets/.%2fx', '//secret.txt']) {
      for (const headers of [{}, HTML]) {
        const response = await app.inject({ url, headers });
        expect(response.body, `${url} ${JSON.stringify(headers)}`).not.toContain('outside the dist');
        expect(response.body, url).not.toContain('SECRET=1');
        expect([200, 400, 404], url).toContain(response.statusCode);
        // A 200 is only ever the SPA shell, never a file from disk.
        if (response.statusCode === 200) expect(response.body).toContain('<title>spa</title>');
      }
    }
    expect((await app.inject({ url: '/linked.txt' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/.env' })).statusCode).toBe(404);
  });

  it('refuses a directory without index.html', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'static-web-empty-'));
    try {
      await expect(registerStaticWeb(Fastify({ logger: false }), { dir: empty })).rejects.toThrow(/index\.html/);
      await expect(registerStaticWeb(Fastify({ logger: false }), { dir: join(empty, 'missing') })).rejects.toThrow(/does not exist/);
    } finally { await rm(empty, { recursive: true, force: true }); }
  });
});
