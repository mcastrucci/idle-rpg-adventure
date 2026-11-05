import { checkOrigin, requireAccount } from '@engine/server-kit';
import type { ServerModule } from '@engine/server-kit';
import { z } from 'zod';

import { parseGameCommand, publicCommandError, executeCharacterCommand } from '../character-commands.ts';
import { parseExpeditionEstimateRequest } from '@rpg/protocol';

import { createExpeditionService } from './service.ts';
import { createEstimateService } from './estimates.ts';
import type { EstimateServiceOptions } from './estimates.ts';
import { supportedSettlementPolicies } from './policy.ts';
import type { SettlementPolicy } from './policy.ts';

const ActorParams = z.strictObject({ actorId: z.uuid().transform(id => id.toLowerCase()) });
const ExpeditionParams = z.strictObject({ expeditionId: z.uuid().transform(id => id.toLowerCase()) });

/** HTTP and WS command operations share the command dispatcher and idempotency ledger. */
export function createExpeditionModule(seedSource?: () => number, settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies,
  estimateOptions: EstimateServiceOptions = {}, exposeTechnicalAreas = false): ServerModule {
return {
  name: 'expeditions', roles: ['api'],
  async register(app, context) {
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      checkOrigin(request, context.allowedOrigins);
    });
    const estimates = createEstimateService(context.content, { ...estimateOptions, exposeTechnicalAreas });
    app.addHook('onClose', async () => { await estimates.close(); });
    // Read-only Monte Carlo estimate of a candidate start (#53). Not a command: it changes nothing, so it needs no
    // command id; the body carries only the request and config (no stats), parsed by the shared protocol.
    app.post('/characters/:actorId/expedition-estimate', { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParams.parse(request.params);
      let body;
      try { body = parseExpeditionEstimateRequest(request.body); }
      catch { return reply.code(400).send({ error: 'invalid_request' }); }
      try {
        return await estimates.estimate(context.database, accountId, actorId, body);
      } catch (error) {
        const known = publicCommandError(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });
    app.get('/expeditions/:expeditionId', async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { expeditionId } = ExpeditionParams.parse(request.params);
      try {
        return await context.database.db.transaction(tx => createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).get(accountId, expeditionId));
      } catch (error) {
        const known = publicCommandError(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });
    app.get('/characters/:actorId/expeditions', async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParams.parse(request.params);
      try {
        return await context.database.db.transaction(tx => createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).list(accountId, actorId));
      } catch (error) {
        const known = publicCommandError(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });
    app.get('/characters/:actorId/expedition-options', async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParams.parse(request.params);
      try {
        return await context.database.db.transaction(tx => createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).options(accountId, actorId));
      } catch (error) {
        const known = publicCommandError(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });
    app.post('/expeditions', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const command = parseGameCommand(request.body);
      if ((command.operation as string) !== 'expedition.start') return reply.code(400).send({ error: 'operation_route_mismatch' });
      const response = await executeCharacterCommand(context, accountId, command, seedSource, settlementPolicies, exposeTechnicalAreas);
      return reply.code(response.status).send(response.body);
    });
    app.post('/expeditions/:expeditionId/cancel', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { expeditionId } = ExpeditionParams.parse(request.params);
      const command = parseGameCommand(request.body);
      if ((command.operation as string) !== 'expedition.cancel') return reply.code(400).send({ error: 'operation_route_mismatch' });
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload['expeditionId'] !== 'string' || payload['expeditionId'].toLowerCase() !== expeditionId) return reply.code(400).send({ error: 'operation_route_mismatch' });
      const response = await executeCharacterCommand(context, accountId, command, seedSource, settlementPolicies, exposeTechnicalAreas);
      return reply.code(response.status).send(response.body);
    });
    app.post('/expeditions/:expeditionId/recover-unavailable', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { expeditionId } = ExpeditionParams.parse(request.params);
      const command = parseGameCommand(request.body);
      if ((command.operation as string) !== 'expedition.recoverUnavailable') return reply.code(400).send({ error: 'operation_route_mismatch' });
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload['expeditionId'] !== 'string' || payload['expeditionId'].toLowerCase() !== expeditionId) return reply.code(400).send({ error: 'operation_route_mismatch' });
      const response = await executeCharacterCommand(context, accountId, command, seedSource, settlementPolicies, exposeTechnicalAreas);
      return reply.code(response.status).send(response.body);
    });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
      const known = publicCommandError(error);
      if (known) return reply.code(known.status).send(known.body);
      if (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415) {
        return reply.code(error.statusCode).send({ error: 'invalid_request' });
      }
      if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404 || error.statusCode === 429) {
        const code = error.statusCode === 401 ? 'unauthorized' : error.statusCode === 403 ? 'forbidden'
          : error.statusCode === 404 ? 'not_found' : 'rate_limited';
        return reply.code(error.statusCode).send({ error: code });
      }
      const errorCode = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
      app.log.error({ code: errorCode }, 'expedition request failed');
      return reply.code(500).send({ error: 'internal_error' });
    });
  },
};
}
