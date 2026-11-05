import { ActorError, LedgerError, requireOwnedActor, runCommand } from '@engine/server-kit';
import type { CommandResponse, JsonValue, ModuleContext } from '@engine/server-kit';
import { parseCommandEnvelope, parseExpeditionCancelPayload, parseExpeditionStartPayload } from '@rpg/protocol';
import type { CommandEnvelope } from '@rpg/protocol';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { createCharacterService } from './characters/service.ts';
import { CharacterError, ConfigureCharacterSchema, CreateCharacterSchema } from './characters/validation.ts';
import { createExpeditionService, ExpeditionError } from './expeditions/service.ts';
import { createInventoryService, InventoryError, EquipPayloadSchema, UnequipPayloadSchema, MovePayloadSchema, BuyPayloadSchema, SellMaterialPayloadSchema, ClaimStarterKitPayloadSchema } from './inventory/service.ts';
import { expeditions } from './expeditions/schema.ts';
import { supportedSettlementPolicies } from './expeditions/policy.ts';
import type { SettlementPolicy } from './expeditions/policy.ts';

const TargetConfiguration = z.strictObject({ actorId: z.uuid().transform((id) => id.toLowerCase()), configuration: ConfigureCharacterSchema });
const ExpeditionStart = z.strictObject({ actorId: z.uuid().transform((id) => id.toLowerCase()),
  request: z.strictObject({ areaId: z.string().min(1).max(160), activityId: z.string().min(1).max(160),
    durationMin: z.number().int().positive().max(180), paceBp: z.number().int().positive().max(10_000) }), config: z.record(z.string(), z.unknown()) });
const ExpeditionCancel = z.strictObject({ expeditionId: z.uuid().transform(id => id.toLowerCase()) });
class InvalidCommandError extends Error {}

export function parseGameCommand(input: unknown): CommandEnvelope {
  try { return parseCommandEnvelope(input); }
  catch { throw new InvalidCommandError('invalid_command'); }
}

/** DTOs contain JSON only; normalize before hashing and before retaining a response. */
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

/** Both HTTP and WS dispatch here. Authorization runs even on replays; busy checks only run for new mutations. */
export async function executeCharacterCommand(context: ModuleContext, accountId: string, command: CommandEnvelope,
  seedSource?: () => number, settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies,
  exposeTechnicalAreas = false): Promise<CommandResponse> {
  if ((command.operation as string) === 'expedition.start') {
    let parsedWire: ReturnType<typeof parseExpeditionStartPayload>;
    try { parsedWire = parseExpeditionStartPayload(command.payload); }
    catch { throw new InvalidCommandError('invalid_command'); }
    const payload = ExpeditionStart.parse(parsedWire);
    await context.database.db.transaction(tx => requireOwnedActor(tx, payload.actorId, accountId, 'rpg'));
    return runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async tx => ({
      status: 201, body: json(await createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).start(accountId, payload)),
    }));
  }
  if (command.operation === 'inventory.equip' || command.operation === 'inventory.unequip' || command.operation === 'inventory.move' || command.operation === 'inventory.buy' || command.operation === 'inventory.sellMaterial' || command.operation === 'inventory.claimStarterKit') {
    let payload: ReturnType<typeof EquipPayloadSchema.parse> | ReturnType<typeof UnequipPayloadSchema.parse> |
      ReturnType<typeof MovePayloadSchema.parse> | ReturnType<typeof BuyPayloadSchema.parse> | ReturnType<typeof SellMaterialPayloadSchema.parse> | ReturnType<typeof ClaimStarterKitPayloadSchema.parse>;
    try {
      payload = command.operation === 'inventory.equip' ? EquipPayloadSchema.parse(command.payload)
        : command.operation === 'inventory.unequip' ? UnequipPayloadSchema.parse(command.payload)
          : command.operation === 'inventory.move' ? MovePayloadSchema.parse(command.payload)
            : command.operation === 'inventory.buy' ? BuyPayloadSchema.parse(command.payload)
              : command.operation === 'inventory.sellMaterial' ? SellMaterialPayloadSchema.parse(command.payload) : ClaimStarterKitPayloadSchema.parse(command.payload);
    } catch { throw new InvalidCommandError('invalid_command'); }
    await context.database.db.transaction(tx => requireOwnedActor(tx, payload.actorId, accountId, 'rpg'));
    const canonical = { ...command, payload: json(payload) };
    return runCommand(context.database, context.clock, accountId, canonical, async tx => {
      const service = createInventoryService(tx, context.content);
      const result = command.operation === 'inventory.equip' ? await service.equip(accountId, command.commandId, payload as ReturnType<typeof EquipPayloadSchema.parse>)
        : command.operation === 'inventory.unequip' ? await service.unequip(accountId, command.commandId, payload as ReturnType<typeof UnequipPayloadSchema.parse>)
          : command.operation === 'inventory.move' ? await service.move(accountId, command.commandId, payload as ReturnType<typeof MovePayloadSchema.parse>)
            : command.operation === 'inventory.buy' ? await service.buy(accountId, command.commandId, payload as ReturnType<typeof BuyPayloadSchema.parse>)
              : command.operation === 'inventory.sellMaterial' ? await service.sellMaterial(accountId, command.commandId, payload as ReturnType<typeof SellMaterialPayloadSchema.parse>)
                : await service.claimStarterKit(accountId, (payload as ReturnType<typeof ClaimStarterKitPayloadSchema.parse>).actorId);
      return { status: 200, body: json(result) };
    });
  }
  if ((command.operation as string) === 'expedition.cancel') {
    let parsedWire: ReturnType<typeof parseExpeditionCancelPayload>;
    try { parsedWire = parseExpeditionCancelPayload(command.payload); }
    catch { throw new InvalidCommandError('invalid_command'); }
    const payload = ExpeditionCancel.parse(parsedWire);
    const [expedition] = await context.database.db.select().from(expeditions).where(eq(expeditions.id, payload.expeditionId));
    if (!expedition || expedition.accountId !== accountId) throw new ActorError('not_found', 404);
    await context.database.db.transaction(tx => requireOwnedActor(tx, expedition.actorId, accountId, 'rpg'));
    return runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async tx => ({
      status: 200, body: json(await createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).cancel(accountId, payload.expeditionId)),
    }));
  }
  if ((command.operation as string) === 'expedition.recoverUnavailable') {
    let parsedWire: ReturnType<typeof parseExpeditionCancelPayload>;
    try { parsedWire = parseExpeditionCancelPayload(command.payload); }
    catch { throw new InvalidCommandError('invalid_command'); }
    const payload = ExpeditionCancel.parse(parsedWire);
    const [expedition] = await context.database.db.select().from(expeditions).where(eq(expeditions.id, payload.expeditionId));
    if (!expedition || expedition.accountId !== accountId) throw new ActorError('not_found', 404);
    await context.database.db.transaction(tx => requireOwnedActor(tx, expedition.actorId, accountId, 'rpg'));
    return runCommand(context.database, context.clock, accountId, { ...command, payload: json(payload) }, async tx => ({
      status: 200, body: json(await createExpeditionService(tx, context.clock, context.content, seedSource, settlementPolicies, exposeTechnicalAreas).recoverUnavailable(accountId, payload.expeditionId)),
    }));
  }
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
  if (error instanceof ActorError || error instanceof CharacterError || error instanceof ExpeditionError || error instanceof InventoryError) return { status: error.statusCode, body: { error: error.code } };
  if (error instanceof LedgerError) {
    const status = error.code === 'invalid_source' ? 400 : 409;
    return { status, body: { error: error.code } };
  }
  return null;
}

/** Credentials never enter a frame, fingerprint or retained command result. */
export async function executeCharacterSocketCommand(context: ModuleContext, accountId: string, wire: unknown, seedSource?: () => number,
  settlementPolicies: readonly SettlementPolicy[] = supportedSettlementPolicies, exposeTechnicalAreas = false) {
  let command: CommandEnvelope;
  try { command = parseCommandEnvelope(wire); }
  catch { return { type: 'error', error: 'invalid_command' }; }
  let response: CommandResponse;
  try { response = await executeCharacterCommand(context, accountId, command, seedSource, settlementPolicies, exposeTechnicalAreas); }
  catch (error) {
    const known = publicCommandError(error);
    if (!known) throw error;
    response = known;
  }
  return { type: 'command.result', command_id: command.commandId, ...response };
}
