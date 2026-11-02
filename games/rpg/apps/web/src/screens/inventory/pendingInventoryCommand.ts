import type { CommandRequest } from '../../api/commands.ts';

const pendingByActor = new Map<string, CommandRequest<unknown>>();

/** Keep the same idempotent intent available if the Inventory tab unmounts before its outcome is known. */
export function pendingInventoryCommand(actorId: string | null): CommandRequest<unknown> | null {
  return actorId ? pendingByActor.get(actorId) ?? null : null;
}

export function rememberInventoryCommand(actorId: string, request: CommandRequest<unknown>): void {
  pendingByActor.set(actorId, request);
}

export function clearInventoryCommand(actorId: string, request: CommandRequest<unknown>): void {
  if (pendingByActor.get(actorId)?.envelope.command_id === request.envelope.command_id) pendingByActor.delete(actorId);
}
