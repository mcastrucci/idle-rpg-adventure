import { describe, expect, it } from 'vitest';

import type { ModuleContext } from '@engine/server-kit';
import type { CommandEnvelope } from '@rpg/protocol';

import { executeCharacterCommand, executeCharacterSocketCommand, publicCommandError } from './character-commands.ts';

const accountId = '9d1c321a-2f34-46bc-8e54-c5618a8368fa';
const commandId = 'a6a9b43d-4edb-4141-9ee4-29c4f77c38d4';
const command: CommandEnvelope = {
  commandId,
  operation: 'expedition.start',
  payload: {
    actorId: accountId,
    request: { areaId: 'area:region_1', activityId: 'idle:region_1.hunt', durationMin: 15, paceBp: 10_000 },
    config: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false }, completedAreas: ['area:region_1'] },
  },
};

describe('expedition command payload errors', () => {
  it('returns a structured 400 for protocol-parser failures before opening the database', async () => {
    let databaseTouched = false;
    const context = { get database() { databaseTouched = true; throw new Error('database must not be touched'); } } as unknown as ModuleContext;
    let dispatcherResponse: ReturnType<typeof publicCommandError> = null;
    try { await executeCharacterCommand(context, accountId, command); }
    catch (error) { dispatcherResponse = publicCommandError(error); }
    expect(dispatcherResponse).toEqual({ status: 400, body: { error: 'invalid_command' } });
    const response = await executeCharacterSocketCommand(context, accountId, {
      command_id: command.commandId, operation: command.operation, payload: command.payload,
    });
    expect(response).toEqual({ type: 'command.result', command_id: commandId, status: 400, body: { error: 'invalid_command' } });
    expect(databaseTouched).toBe(false);
  });

  it('does not classify arbitrary internal TypeErrors as public client errors', () => {
    expect(publicCommandError(new TypeError('private database failure'))).toBeNull();
  });
});
