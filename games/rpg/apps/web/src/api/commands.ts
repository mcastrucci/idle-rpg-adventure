import { parseCommandEnvelope } from '@rpg/protocol';
import type { CommandEnvelopeWire, CommandJson, CommandOperation } from '@rpg/protocol';

import { exponentialBackoff, sleep as defaultSleep } from './backoff.ts';
import type { ApiClient, HttpMethod } from './http.ts';
import { errorCode, NetworkError } from './http.ts';
import type { CharacterDto } from './types.ts';
import type { ExpeditionDto, ExpeditionStartPayload } from '@rpg/protocol';

export type CommandPayload = { readonly [key: string]: CommandJson };

/** A fully built command: the envelope (with its fixed `command_id`) plus the HTTP route that carries it. */
export interface CommandRequest<TResult> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly envelope: CommandEnvelopeWire;
  /** Phantom marker for the 2xx body type; never set at runtime. */
  readonly result?: TResult;
}

export const newCommandId = (): string => globalThis.crypto.randomUUID();

/**
 * Builds the shared wire envelope with a client-generated UUID. The id is generated exactly once per user intent:
 * every retry of this request re-sends the same object, which is what makes retries safe server-side (#29).
 * The shared protocol parser rejects malformed/oversized payloads before anything is sent.
 */
export function buildEnvelope(operation: CommandOperation, payload: CommandPayload, newId: () => string = newCommandId): CommandEnvelopeWire {
  const envelope: CommandEnvelopeWire = { command_id: newId(), operation, payload };
  parseCommandEnvelope(envelope);
  return envelope;
}

export function createCharacterCommand(name: string, newId?: () => string): CommandRequest<CharacterDto> {
  return { method: 'POST', path: '/characters', envelope: buildEnvelope('character.create', { name }, newId) };
}

/** HTTP carries the configuration as the payload and the target in the route; the server normalizes both. */
export function configureCharacterCommand(actorId: string, configuration: CommandPayload, newId?: () => string): CommandRequest<CharacterDto> {
  return {
    method: 'PATCH',
    path: `/characters/${encodeURIComponent(actorId)}/configuration`,
    envelope: buildEnvelope('character.configure', configuration, newId),
  };
}

export function startExpeditionCommand(payload: ExpeditionStartPayload, newId?: () => string): CommandRequest<ExpeditionDto> {
  return { method: 'POST', path: '/expeditions', envelope: buildEnvelope('expedition.start', payload as unknown as CommandPayload, newId) };
}

export function cancelExpeditionCommand(expeditionId: string, newId?: () => string): CommandRequest<ExpeditionDto> {
  return { method: 'POST', path: `/expeditions/${encodeURIComponent(expeditionId)}/cancel`, envelope: buildEnvelope('expedition.cancel', { expeditionId }, newId) };
}

export function recoverUnavailableExpeditionCommand(expeditionId: string, newId?: () => string): CommandRequest<ExpeditionDto> {
  return { method: 'POST', path: `/expeditions/${encodeURIComponent(expeditionId)}/recover-unavailable`,
    envelope: buildEnvelope('expedition.recoverUnavailable', { expeditionId }, newId) };
}

/** Terminal outcome: the server decided (domain error, 409 `command_id_conflict`, 410 `command_expired`…). */
export class CommandRejectedError extends Error {
  readonly commandId: string;
  readonly status: number;
  readonly code: string;
  constructor(commandId: string, status: number, code: string) {
    super(`command ${commandId} rejected: ${status} ${code}`);
    this.name = 'CommandRejectedError';
    this.commandId = commandId;
    this.status = status;
    this.code = code;
  }
}

/**
 * Outcome unknown after the retry budget: the command may or may not have been applied. Re-sending the same
 * `request` later is still safe (same `command_id`); building a new command is not.
 */
export class CommandUnconfirmedError<TResult = unknown> extends Error {
  readonly request: CommandRequest<TResult>;
  constructor(request: CommandRequest<TResult>, cause: unknown) {
    super(`command ${request.envelope.command_id} unconfirmed`, { cause });
    this.name = 'CommandUnconfirmedError';
    this.request = request;
  }
}

/** Statuses for which the server did not commit a result: rate limited, overloaded, or rolled back on an exception. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface SendCommandOptions {
  readonly maxAttempts?: number;
  readonly backoff?: (attempt: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Resolves when commands may be sent. Commands are held (not lost) while the client is disconnected. */
  readonly waitUntilConnected?: () => Promise<void>;
}

/**
 * Sends a command and retries only transport-level failures, always with the identical envelope. The server's
 * command log returns the stored response for a replayed `command_id` without mutating again, so a lost response
 * followed by a retry cannot duplicate the effect. Retrying is skipped for any status the server committed.
 */
export async function sendCommand<TResult>(api: ApiClient, request: CommandRequest<TResult>, options: SendCommandOptions = {}): Promise<TResult> {
  const { maxAttempts = 6, backoff = exponentialBackoff(), sleep = defaultSleep, waitUntilConnected } = options;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoff(attempt - 1));
    if (waitUntilConnected) await waitUntilConnected();
    try {
      const response = await api.send(request.method, request.path, request.envelope);
      if (response.status >= 200 && response.status <= 299) return response.body as TResult;
      const code = errorCode(response.body);
      if (!RETRYABLE_STATUSES.has(response.status)) throw new CommandRejectedError(request.envelope.command_id, response.status, code);
      lastFailure = new CommandRejectedError(request.envelope.command_id, response.status, code);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      lastFailure = error;
    }
  }
  throw new CommandUnconfirmedError(request, lastFailure);
}
