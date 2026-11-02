import { ActorError, requireOwnedActor, runCommand } from '@engine/server-kit';
import type { CommandResponse, JsonValue, ModuleContext } from '@engine/server-kit';
import { parseCommandEnvelope } from '@rpg/protocol';
import type { CommandEnvelope } from '@rpg/protocol';
import { z } from 'zod';

import { createCharacterService } from './characters/service.ts';
import { CharacterError, ConfigureCharacterSchema, CreateCharacterSchema } from './characters/validation.ts';

const TargetConfiguration = z.strictObject({ actorId: z.uuid().transform((id) => id.toLowerCase()), configuration: ConfigureCharacterSchema });
class InvalidCommandError extends Error {}

export function parseGameCommand(input: unknown): CommandEnvelope {
  try { return parseCommandEnvelope(input); }
  catch { throw new InvalidCommandError('invalid_command'); }
}

/** DTOs contain JSON only; normalize before hashing and before retaining a response. */
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

/** Both HTTP and WS dispatch here. Authorization runs even on replays; busy checks only run for new mutations. */
export async function executeCharacterCommand(context: ModuleContext, accountId: string, command: CommandEnvelope): Promise<CommandResponse> {
  if (command.operation === 'character.create') {
    const payload = CreateCharacterSchema.parse(command.payload);
    return runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async (tx) => ({
      status: 201, body: json(await createCharacterService(tx, context.content).create(accountId, payload)),
    }));
  }
  if (command.operation === 'character.configure') {
    const payload = TargetConfiguration.parse(command.payload);
    // Ownership is immutable through this API, but still checked on every transport/replay.
    await context.database.db.transaction((tx) => requireOwnedActor(tx, payload.actorId, accountId, 'rpg'));
    return runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async (tx) => ({
      status: 200, body: json(await createCharacterService(tx, context.content).configure(accountId, payload.actorId, payload.configuration)),
    }));
  }
  return { status: 400, body: { error: 'unsupported_operation' } };
}

export function publicCommandError(error: unknown): CommandResponse | null {
  if (error instanceof z.ZodError || error instanceof InvalidCommandError) return { status: 400, body: { error: 'invalid_command' } };
  if (error instanceof ActorError || error instanceof CharacterError) return { status: error.statusCode, body: { error: error.code } };
  return null;
}

/** Credentials never enter a frame, fingerprint or retained command result. */
export async function executeCharacterSocketCommand(context: ModuleContext, accountId: string, wire: unknown) {
  let command: CommandEnvelope;
  try { command = parseCommandEnvelope(wire); }
  catch { return { type: 'error', error: 'invalid_command' }; }
  let response: CommandResponse;
  try { response = await executeCharacterCommand(context, accountId, command); }
  catch (error) {
    const known = publicCommandError(error);
    if (!known) throw error;
    response = known;
  }
  return { type: 'command.result', command_id: command.commandId, ...response };
}
