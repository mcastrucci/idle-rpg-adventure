import type { CharacterDto, ContentInfoDto, IssuedSessionDto, SessionDto } from './types.ts';
import type { ExpeditionDto, ExpeditionEstimateDto, ExpeditionEstimateRequest, ExpeditionOptionsDto } from '@rpg/protocol';
import { parseExpeditionDto, parseExpeditionEstimateDto, parseExpeditionOptionsDto, parseLiveDeathResponse } from '@rpg/protocol';
import type { LiveDeathSummaryDto } from '@rpg/protocol';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type HttpMethod = 'GET' | 'POST' | 'PATCH';

/** The server answered with a non-2xx status and (usually) a stable `{ error }` code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The request never produced an HTTP response (offline, DNS, reset, proxy down). Safe to retry idempotent work. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network request failed', { cause });
    this.name = 'NetworkError';
  }
}

export interface RawResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Thin typed client over the real server routes. Authentication rides on the server's `__Host-idle_session` HttpOnly
 * cookie (same origin through the dev proxy); the client never stores or sends the session token itself, so the same
 * credential also authenticates the WebSocket upgrade, which browsers cannot give an Authorization header.
 */
export class ApiClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init), baseUrl = '') {
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl;
  }

  /** One HTTP exchange. Throws NetworkError when no response arrives; never throws for HTTP error statuses. */
  async send(method: HttpMethod, path: string, body?: unknown): Promise<RawResponse> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (error) {
      throw new NetworkError(error);
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (text !== '') {
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    }
    return { status: response.status, body: parsed };
  }

  /** Request expecting a 2xx JSON body; any other status becomes an ApiError. */
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    if (response.status < 200 || response.status > 299) throw new ApiError(response.status, errorCode(response.body));
    return response.body as T;
  }

  session(): Promise<SessionDto> { return this.request('GET', '/auth/session'); }
  /** First launch and every later launch: the device token maps to the same guest account. */
  guest(deviceToken: string): Promise<IssuedSessionDto> { return this.request('POST', '/auth/guest', { deviceToken }); }
  async logout(): Promise<void> { await this.request('POST', '/auth/logout', {}); }
  content(): Promise<ContentInfoDto> { return this.request('GET', '/content'); }
  listCharacters(): Promise<CharacterDto[]> { return this.request('GET', '/characters'); }
  character(actorId: string): Promise<CharacterDto> {
    return this.request('GET', `/characters/${encodeURIComponent(actorId)}`);
  }
  liveDeath(actorId: string): Promise<LiveDeathSummaryDto | null> {
    return this.request<unknown>('GET', `/characters/${encodeURIComponent(actorId)}/live-death`)
      .then((value) => parseLiveDeathResponse(value).death);
  }
  expedition(expeditionId: string): Promise<ExpeditionDto> {
    return this.request<unknown>('GET', `/expeditions/${encodeURIComponent(expeditionId)}`).then(parseExpeditionDto);
  }
  expeditionOptions(actorId: string): Promise<ExpeditionOptionsDto> {
    return this.request<unknown>('GET', `/characters/${encodeURIComponent(actorId)}/expedition-options`).then(parseExpeditionOptionsDto);
  }
  /** Read-only server Monte Carlo estimate of a candidate start (not a command: nothing changes server-side). */
  expeditionEstimate(actorId: string, body: ExpeditionEstimateRequest): Promise<ExpeditionEstimateDto> {
    return this.request<unknown>('POST', `/characters/${encodeURIComponent(actorId)}/expedition-estimate`, body).then(parseExpeditionEstimateDto);
  }
}

export function errorCode(body: unknown): string {
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return 'unknown_error';
}
