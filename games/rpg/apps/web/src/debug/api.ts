import type { CommandEnvelopeWire, CommandOperation } from '@rpg/protocol';

import { newCommandId, sendCommand } from '../api/commands.ts';
import type { CommandPayload, CommandRequest } from '../api/commands.ts';
import type { ApiClient } from '../api/http.ts';

/**
 * Staging-only debug tools (#132) over the server's `/debug/*` routes. The routes exist only when the server runs with
 * RPG_DEBUG_TOOLS; the client merely shows or hides the panel. Every result comes from the server.
 */
export interface DebugClockDto {
  readonly nowMs: number;
  readonly offsetMs: number;
  readonly maxAdvanceMs: number;
  readonly maxOffsetMs: number;
}

/** Server zod limits (`debug/service.ts`, `debug/http.ts`); inputs respect them, the server still validates. */
export const DEBUG_LIMITS = {
  gold: { min: 1, max: 1_000_000_000 },
  qty: { min: 1, max: 10_000 },
  level: { min: 1, max: 10_000 },
  xp: { min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

export const ADVANCE_STEPS_MS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;

type DebugOperation = 'debug.clock.advance' | 'debug.grant' | 'debug.setProgression' | 'debug.recordWorldProgress' | 'debug.resetWorldProgress';

function isClock(value: unknown): value is DebugClockDto {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['nowMs', 'offsetMs', 'maxAdvanceMs', 'maxOffsetMs'].every((key) => Number.isSafeInteger(v[key]));
}

/** `GET /debug/clock`. Only a 200 with a valid body means the tools are on; every other outcome yields `null`. */
export async function probeDebugClock(api: ApiClient): Promise<DebugClockDto | null> {
  try {
    const response = await api.send('GET', '/debug/clock');
    return response.status === 200 && isClock(response.body) ? response.body : null;
  } catch {
    return null;
  }
}

/**
 * Debug operations are not part of the shared player protocol (`COMMAND_OPERATIONS`), so the envelope is built here with
 * the same wire shape and a fresh `command_id` per user intent.
 */
function debugCommand<T>(path: string, operation: DebugOperation, payload: CommandPayload, newId: () => string = newCommandId): CommandRequest<T> {
  const envelope: CommandEnvelopeWire = { command_id: newId(), operation: operation as CommandOperation, payload };
  return { method: 'POST', path, envelope };
}

const actorPath = (actorId: string, leaf: string) => `/debug/characters/${encodeURIComponent(actorId)}/${leaf}`;

export interface AdvanceResult { readonly advancedMs: number; readonly offsetMs: number; readonly nowMs: number }

export const advanceClockCommand = (durationMs: number, newId?: () => string) =>
  debugCommand<AdvanceResult>('/debug/clock/advance', 'debug.clock.advance', { durationMs }, newId);
export const grantCommand = (actorId: string, grant: { gold?: number; items?: readonly { item: string; qty: number }[] }, newId?: () => string) =>
  debugCommand<unknown>(actorPath(actorId, 'grants'), 'debug.grant', { actorId, ...grant } as CommandPayload, newId);
export const setProgressionCommand = (actorId: string, level: number, xp: number, newId?: () => string) =>
  debugCommand<unknown>(actorPath(actorId, 'progression'), 'debug.setProgression', { actorId, level, xp }, newId);
export const conquerAreaCommand = (actorId: string, areaId: string, newId?: () => string) =>
  debugCommand<unknown>(actorPath(actorId, 'world-progress'), 'debug.recordWorldProgress', { actorId, completedAreas: [areaId] }, newId);
export const resetWorldCommand = (actorId: string, areaId?: string, newId?: () => string) =>
  debugCommand<unknown>(actorPath(actorId, 'world-progress/reset'), 'debug.resetWorldProgress', areaId === undefined ? { actorId } : { actorId, areaId }, newId);

export const sendDebugCommand = <T,>(api: ApiClient, request: CommandRequest<T>): Promise<T> => sendCommand(api, request);
