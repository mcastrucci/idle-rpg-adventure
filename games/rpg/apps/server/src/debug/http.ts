import { checkOrigin, requireAccount, requireOwnedActor, runCommand } from '@engine/server-kit';
import type { CommandResponse, JsonValue, ModuleContext, ProcessRole, ServerModule } from '@engine/server-kit';
import { z } from 'zod';

import { publicCommandError } from '../character-commands.ts';
import { RPG_GAME_ID } from '../characters/service.ts';
import { advanceDebugOffset, DebugClockError, MAX_DEBUG_ADVANCE_MS, MAX_DEBUG_OFFSET_MS, readDebugOffset } from './clock.ts';
import type { TimeTravelClock } from './clock.ts';
import { assertDebugToolsAllowed } from './config.ts';
import type { RpgDebugToolsConfig } from './config.ts';
import {
  createDebugService, DebugGrantSchema, DebugProgressionSchema, DebugToolError, DebugWorldProgressSchema, DebugWorldResetSchema,
} from './service.ts';

/** How often every process re-reads the persisted environment offset. */
export const DEBUG_CLOCK_REFRESH_MS = 1000;
const Envelope = z.strictObject({ command_id: z.uuid().transform(id => id.toLowerCase()), operation: z.string().max(80),
  payload: z.record(z.string(), z.unknown()) });
const ActorParams = z.strictObject({ actorId: z.uuid().transform(id => id.toLowerCase()) });
const AdvanceSchema = z.strictObject({ durationMs: z.int().min(1).max(MAX_DEBUG_ADVANCE_MS) });

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

/**
 * Debug/admin module (issue #31). Registered only when explicitly enabled outside production; registration re-checks
 * the guard so a mis-composed production server fails to boot instead of exposing these routes. All roles keep the
 * travelled clock in sync; HTTP routes exist only in the `api` role.
 */
export function createDebugModule(config: RpgDebugToolsConfig, clock: TimeTravelClock, roles: readonly ProcessRole[]): ServerModule {
  assertDebugToolsAllowed(config);
  return {
    name: 'debug', roles: ['api', 'live', 'worker'],
    async register(app, context) {
      assertDebugToolsAllowed(config);
      if (context.clock !== clock) throw new Error('debug module must be composed with its time-travel clock');
      const refresh = async () => { clock.observeOffset(await readDebugOffset(context.database)); };
      await refresh();
      const timer = setInterval(() => {
        void refresh().catch((error: unknown) => {
          app.log.warn({ code: (error as { code?: string }).code ?? 'DEBUG_CLOCK_REFRESH_FAILED' }, 'debug clock refresh failed');
        });
      }, DEBUG_CLOCK_REFRESH_MS);
      timer.unref();
      app.addHook('onClose', async () => { clearInterval(timer); });
      app.log.warn({ environment: config.environment }, 'debug tools enabled: never run this configuration in production');
      if (!roles.includes('api')) return;
      registerRoutes(app, context, clock);
    },
  };
}

function registerRoutes(app: Parameters<ServerModule['register']>[0], context: ModuleContext, clock: TimeTravelClock): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    checkOrigin(request, context.allowedOrigins);
  });

  app.get('/debug/clock', async request => {
    await requireAccount(request, context);
    await refreshNow(context, clock);
    return { nowMs: clock.nowMs(), offsetMs: clock.offsetMs, maxAdvanceMs: MAX_DEBUG_ADVANCE_MS, maxOffsetMs: MAX_DEBUG_OFFSET_MS };
  });

  app.post('/debug/clock/advance', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const { accountId } = await requireAccount(request, context);
    const command = envelope(request.body, 'debug.clock.advance');
    if (!command) return reply.code(400).send({ error: 'operation_route_mismatch' });
    const payload = AdvanceSchema.parse(command.payload);
    const response = await runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async tx => {
      const offsetMs = await advanceDebugOffset(tx, clock, payload.durationMs);
      return { status: 200, body: { advancedMs: payload.durationMs, offsetMs } };
    });
    // Apply the committed offset to this process immediately; other processes pick it up on their next refresh.
    await refreshNow(context, clock);
    return send(reply, response.status === 200 ? { status: 200, body: json({ ...(response.body as object), nowMs: clock.nowMs() }) } : response);
  });

  const actorRoute = <S extends z.ZodType>(path: string, operation: string, schema: S,
    run: (service: ReturnType<typeof createDebugService>, accountId: string, commandId: string, payload: z.output<S>) => Promise<unknown>) => {
    app.post(path, { bodyLimit: 32 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParams.parse(request.params);
      const command = envelope(request.body, operation);
      if (!command) return reply.code(400).send({ error: 'operation_route_mismatch' });
      const raw = command.payload['actorId'];
      if (typeof raw !== 'string' || raw.toLowerCase() !== actorId) return reply.code(400).send({ error: 'operation_route_mismatch' });
      const payload = schema.parse(command.payload);
      // Ownership is checked on every attempt, including replays of a stored response.
      await context.database.db.transaction(tx => requireOwnedActor(tx, actorId, accountId, RPG_GAME_ID));
      const response = await runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async tx => ({
        status: 200, body: json(await run(createDebugService(tx, context.clock, context.content), accountId, command.commandId, payload)),
      }));
      return send(reply, response);
    });
  };
  actorRoute('/debug/characters/:actorId/grants', 'debug.grant', DebugGrantSchema,
    (service, accountId, commandId, payload) => service.grant(accountId, commandId, payload));
  actorRoute('/debug/characters/:actorId/progression', 'debug.setProgression', DebugProgressionSchema,
    (service, accountId, _commandId, payload) => service.setProgression(accountId, payload));
  actorRoute('/debug/characters/:actorId/world-progress', 'debug.recordWorldProgress', DebugWorldProgressSchema,
    (service, accountId, _commandId, payload) => service.recordWorldProgress(accountId, payload));
  actorRoute('/debug/characters/:actorId/world-progress/reset', 'debug.resetWorldProgress', DebugWorldResetSchema,
    (service, accountId, _commandId, payload) => service.resetWorldProgress(accountId, payload));

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    if (error instanceof DebugToolError || error instanceof DebugClockError) return reply.code(error.statusCode).send({ error: error.code });
    const known = publicCommandError(error);
    if (known) return reply.code(known.status).send(known.body);
    if (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415) return reply.code(error.statusCode).send({ error: 'invalid_request' });
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 429) {
      return reply.code(error.statusCode).send({ error: error.statusCode === 401 ? 'unauthorized' : error.statusCode === 403 ? 'forbidden' : 'rate_limited' });
    }
    if (error instanceof TypeError && error.message === 'invalid command envelope') return reply.code(400).send({ error: 'invalid_command' });
    app.log.error({ code: typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : 'INTERNAL_ERROR' }, 'debug request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
}

function envelope(body: unknown, operation: string): { commandId: string; operation: string; payload: Record<string, unknown> } | null {
  const parsed = Envelope.parse(body);
  if (parsed.operation !== operation) return null;
  return { commandId: parsed.command_id, operation: parsed.operation, payload: parsed.payload };
}
async function refreshNow(context: ModuleContext, clock: TimeTravelClock): Promise<void> {
  clock.observeOffset(await readDebugOffset(context.database));
}
function send(reply: { code(status: number): { send(body: unknown): unknown } }, response: CommandResponse) { return reply.code(response.status).send(response.body); }
