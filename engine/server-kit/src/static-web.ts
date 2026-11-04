import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface StaticWebOptions {
  /** Directory holding a built single-page app; must contain `index.html`. */
  readonly dir: string;
  /** Path prefixes that belong to the API. Unknown paths under them stay JSON 404s instead of falling back to `index.html`. */
  readonly reservedPrefixes?: readonly string[];
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};
/** Bundler output such as `assets/index-Bx3k9aQz.js`: content-hashed, so it can be cached forever. */
const HASHED_ASSET = /^\/assets\/(?:.+\/)?[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+(?:\.map)?$/;

/**
 * Serves a built SPA on the same origin as the API. It runs only as the not-found handler, so it can never shadow a
 * registered API, health or WebSocket route. Only GET/HEAD are served, nothing outside `dir` is reachable (dot-segments,
 * encoded separators, NUL, backslashes and symlinks escaping the directory are refused), and dotfiles are never served.
 * Unknown extension-less paths requested with `Accept: text/html` fall back to `index.html` (client-side routing).
 */
export async function registerStaticWeb(app: FastifyInstance, options: StaticWebOptions): Promise<void> {
  const root = await realpath(options.dir).catch(() => { throw new Error('static web directory does not exist'); });
  // index.html gets the same realpath containment as every other file: a symlink pointing outside `dir` is refused, and
  // the validated real path is what `/` and the SPA fallback serve.
  const resolvedIndex = await regularFileInside(join(root, 'index.html'));
  if (resolvedIndex === undefined) throw new Error('static web directory must contain a regular index.html inside it');
  const index: string = resolvedIndex;
  const reserved = (options.reservedPrefixes ?? []).map((prefix) => prefix.replace(/\/+$/, ''));

  app.setNotFoundHandler(async (request, reply) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && await serve(request, reply)) return reply;
    return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
  });

  async function serve(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const rawUrl = request.raw.url ?? '/';
    const query = rawUrl.indexOf('?');
    const rawPath = query < 0 ? rawUrl : rawUrl.slice(0, query);
    let pathname: string;
    try { pathname = decodeURIComponent(rawPath); } catch { return false; }
    if (pathname.includes('\0') || pathname.includes('\\') || !pathname.startsWith('/')) return false;
    if (reserved.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false;
    const segments = pathname.split('/').filter((segment) => segment !== '');
    if (segments.some((segment) => segment.startsWith('.'))) return false; // '.', '..' and dotfiles

    const file = segments.length === 0 ? index : await regularFileInside(join(root, ...segments));
    if (file !== undefined) return send(request, reply, file, segments.length === 0 ? '/index.html' : pathname);
    const lastSegment = segments.at(-1) ?? '';
    if (lastSegment.includes('.') || !(request.headers.accept ?? '').toLowerCase().includes('text/html')) return false;
    return send(request, reply, index, '/index.html');
  }

  async function regularFileInside(candidate: string): Promise<string | undefined> {
    let real: string;
    try { real = await realpath(candidate); } catch { return undefined; }
    if (real !== root && !real.startsWith(root + sep)) return undefined; // symlink escape
    return await stat(real).then((entry) => entry.isFile() ? real : undefined, () => undefined);
  }

  async function send(request: FastifyRequest, reply: FastifyReply, file: string, publicPath: string): Promise<boolean> {
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) return false;
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const immutable = HASHED_ASSET.test(publicPath);
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('x-content-type-options', 'nosniff').header('etag', etag);
    if (request.headers['if-none-match'] === etag) { await reply.code(304).send(); return true; }
    reply.header('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('content-length', info.size);
    if (request.method === 'HEAD') await reply.send(); else await reply.send(createReadStream(file));
    return true;
  }
}
