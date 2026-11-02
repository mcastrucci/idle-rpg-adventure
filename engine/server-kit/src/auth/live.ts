import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { AuthContext, HttpAuthOptions } from './http.ts';
import { checkOrigin, sessionToken } from './http.ts';
import { AuthError } from './errors.ts';
import { AuthRateLimiter } from './rate-limit.ts';
import type { AuthIdentity, AuthService, LiveLease } from './service.ts';

export interface LiveSocketGuard { stop(): Promise<void> }
/**
 * Per-socket server push channel handed to command handlers, e.g. so a live instance host can stream sequenced events.
 * `push` is a no-op once the socket is gone; `onClose` listeners run once when the socket stops for any reason.
 */
export interface LiveSocketConnection {
  readonly id: string;
  push(message: unknown): void;
  onClose(listener: () => void): void;
}
export type LiveCommandHandler = (payload: unknown, identity: AuthIdentity, connection: LiveSocketConnection) => Promise<unknown>;
type PendingFrame = { type: 'ping' | 'heartbeat' } | { type: 'command'; payload: unknown };

/** Bounded, serialized frame processing authenticates every command; no game-specific protocol lives here. */
export function guardLiveSocket(socket: WebSocket, service: AuthService, token: string, context: AuthContext,
  heartbeatMs = 10000, onStopped: () => void = () => {}, onCommand?: LiveCommandHandler): LiveSocketGuard {
  let lease: LiveLease | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  let working = Promise.resolve();
  let stopped = false;
  let busy = false;
  const queue: PendingFrame[] = [];
  const messages = new AuthRateLimiter(context.clock, 120);
  const closeListeners: (() => void)[] = [];
  const connection: LiveSocketConnection = {
    id: randomUUID(),
    push(message) { if (!stopped && socket.readyState === 1) socket.send(JSON.stringify(message)); },
    onClose(listener) { if (stopped) listener(); else closeListeners.push(listener); },
  };
  const close = (code: number, reason: string): void => {
    if (socket.readyState === 1) socket.close(code, reason);
    void stop();
  };
  const initialized = service.acquireLive(token).then((acquired) => {
    lease = acquired;
    if (stopped || socket.readyState !== 1) { void stop(); return; }
    socket.send(JSON.stringify({ type: 'authenticated', accountId: acquired.accountId }));
    timer = setInterval(() => {
      // Heartbeats share serialization with application frames and never evict a valid frame in flight.
      if (!busy && queue.length === 0 && !stopped) { queue.push({ type: 'heartbeat' }); schedule(); }
    }, heartbeatMs);
    timer.unref();
  }).catch((error: unknown) => close(error instanceof AuthError && error.code === 'live_session_active' ? 4409 : 4401, 'live authorization rejected'));
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true; queue.length = 0;
    if (timer) clearInterval(timer);
    for (const listener of closeListeners.splice(0)) {
      try { listener(); } catch { /* Listener failures must not prevent lease release. */ }
    }
    if (socket.readyState === 1) socket.terminate();
    stopping = initialized.then(async () => {
      await working; // Drain an accepted command before module shutdown closes the shared database pool.
      if (lease) await service.releaseLive(lease);
    }).finally(onStopped);
    void stopping.catch(() => {});
    return stopping;
  }
  function schedule(): void { if (!busy && !stopped) working = drain(); }
  async function drain(): Promise<void> {
    if (stopped || !lease) return;
    busy = true;
    try {
      let pending: PendingFrame | undefined;
      while (!stopped && (pending = queue.shift()) !== undefined) {
        const identity = await service.renewLive(lease);
        if (stopped) break;
        if (pending.type === 'ping' && socket.readyState === 1) socket.send('pong');
        else if (pending.type === 'command' && onCommand) {
          try {
            const response = await onCommand(pending.payload, identity, connection);
            if (!stopped && socket.readyState === 1) socket.send(JSON.stringify(response));
          } catch {
            if (!stopped && socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', error: 'command_failed' }));
          }
        }
      }
    } catch { close(4401, 'live authorization expired'); }
    finally { busy = false; }
  }
  socket.on('message', (data, binary) => {
    if (binary || !lease || stopped) { close(1008, 'unsupported auth frame'); return; }
    try { messages.consume('socket'); }
    catch { close(1008, 'message rate exceeded'); return; }
    if (queue.length >= 8) { close(1008, 'frame queue exceeded'); return; }
    const text = data.toString();
    if (text === 'ping') { queue.push({ type: 'ping' }); schedule(); return; }
    if (onCommand) {
      try {
        const frame: unknown = JSON.parse(text);
        if (frame !== null && typeof frame === 'object' && !Array.isArray(frame) &&
            Object.keys(frame).length === 2 && (frame as { type?: unknown }).type === 'command' && Object.hasOwn(frame, 'command')) {
          queue.push({ type: 'command', payload: (frame as { command: unknown }).command }); schedule(); return;
        }
      } catch { /* Malformed/unsupported input gets a policy close, never frame content in logs. */ }
    }
    close(1008, 'unsupported auth frame');
  });
  socket.on('close', () => { void stop(); });
  socket.on('error', () => { void stop(); });
  return { stop };
}

export function registerLiveAuth(app: FastifyInstance, context: AuthContext, service: AuthService,
  options: HttpAuthOptions & { heartbeatMs?: number; onCommand?: LiveCommandHandler } = {}): void {
  const guards = new Set<LiveSocketGuard>();
  const limiter = new AuthRateLimiter(context.clock, options.rateLimit ?? 30);
  app.register(websocket, { options: { maxPayload: 70 * 1024, perMessageDeflate: false } });
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'auth_unavailable' });
    });
    scope.get('/auth/live', { websocket: true, preValidation: async (request) => {
      checkOrigin(request, options.allowedOrigins);
      limiter.consume(request.ip);
      // No tokens in URLs, subprotocols or first frames: authenticate the HTTP upgrade itself.
      await service.authenticate(sessionToken(request));
    } }, (socket, request) => {
      const guard = guardLiveSocket(socket, service, sessionToken(request), context, options.heartbeatMs,
        () => { guards.delete(guard); }, options.onCommand);
      guards.add(guard);
    });
  });
  app.addHook('preClose', async () => { await Promise.all([...guards].map((guard) => guard.stop())); });
}
