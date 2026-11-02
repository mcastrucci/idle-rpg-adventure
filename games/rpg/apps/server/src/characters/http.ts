import { checkOrigin, requireAccount } from '@engine/server-kit';
import type { ServerModule } from '@engine/server-kit';
import { z } from 'zod';

import { createCharacterService } from './service.ts';
import { inventorySnapshot, merchantCatalog } from '../inventory/service.ts';
import { executeCharacterCommand, parseGameCommand, publicCommandError } from '../character-commands.ts';

const ActorParamsSchema = z.strictObject({ actorId: z.uuid().transform((id) => id.toLowerCase()) });
/** Auth is the engine's real bearer/session boundary; character IDs/account ownership never come from request claims. */
export const characterModule: ServerModule = {
  name: 'character', roles: ['api'],
  async register(app, context) {
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      checkOrigin(request);
    });
    app.get('/characters', async request => {
      const { accountId } = await requireAccount(request, context);
      return context.database.db.transaction(tx => createCharacterService(tx, context.content).list(accountId));
    });
    app.post('/characters', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const command = parseGameCommand(request.body);
      if (command.operation !== 'character.create') return reply.code(400).send({ error: 'operation_route_mismatch' });
      const response = await executeCharacterCommand(context, accountId, command);
      return reply.code(response.status).send(response.body);
    });
    app.get('/characters/:actorId', async request => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParamsSchema.parse(request.params);
      return context.database.db.transaction(tx => createCharacterService(tx, context.content).read(accountId, actorId));
    });
    app.get('/characters/:actorId/inventory', async request => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParamsSchema.parse(request.params);
      // One immutable view across actor, character, holdings and recorded progress, even during concurrent rewards.
      return context.database.db.transaction(tx => inventorySnapshot(tx, accountId, actorId, context.content),
        { isolationLevel: 'repeatable read', accessMode: 'read only' });
    });
    app.get('/merchant', async () => merchantCatalog(context.content));
    app.post('/characters/:actorId/inventory/commands', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParamsSchema.parse(request.params);
      const command = parseGameCommand(request.body);
      if (!['inventory.equip', 'inventory.unequip', 'inventory.move', 'inventory.buy'].includes(command.operation)) {
        return reply.code(400).send({ error: 'operation_route_mismatch' });
      }
      const payloadActor = command.payload.actorId;
      if (typeof payloadActor !== 'string' || payloadActor.toLowerCase() !== actorId) return reply.code(400).send({ error: 'invalid_command' });
      const response = await executeCharacterCommand(context, accountId, command);
      return reply.code(response.status).send(response.body);
    });
    app.patch('/characters/:actorId/configuration', { bodyLimit: 70 * 1024 }, async (request, reply) => {
      const { accountId } = await requireAccount(request, context);
      const { actorId } = ActorParamsSchema.parse(request.params);
      const command = parseGameCommand(request.body);
      if (command.operation !== 'character.configure') return reply.code(400).send({ error: 'operation_route_mismatch' });
      const response = await executeCharacterCommand(context, accountId, {
        ...command, payload: { actorId, configuration: command.payload },
      });
      return reply.code(response.status).send(response.body);
    });
    // Map only the validation/domain errors owned here. Auth and unexpected errors retain the parent's handling.
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      const known = publicCommandError(error);
      if (known) return reply.code(known.status).send(known.body);
      if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 429) return reply.code(error.statusCode).send({ error: error.message });
      return reply.send(error);
    });
  },
};
