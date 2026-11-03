import {
  parseLiveCurrent,
  parseLiveOptions,
  parseLiveStartRequest,
  parseLiveStartResponse,
} from '@rpg/protocol';
import type { LiveCurrentResponseDto, LiveOptionsDto, LiveStartRequestDto, LiveStartResponseDto } from '@rpg/protocol';
import type { ApiClient } from '../api/http.ts';

/** Server authored live entry choices for the authenticated character. */
export function liveOptions(api: ApiClient, actorId: string): Promise<LiveOptionsDto> {
  return api.request<unknown>('GET', `/live/options/${encodeURIComponent(actorId)}`).then(parseLiveOptions);
}

/** Read the host's current owner view. This endpoint must not fall back to a stale durable checkpoint. */
export function currentLive(api: ApiClient, actorId: string): Promise<LiveCurrentResponseDto> {
  return api.request<unknown>('GET', `/live/current/${encodeURIComponent(actorId)}`).then(parseLiveCurrent);
}

/** Start is idempotent by commandId; callers must retain the same request after an ambiguous network failure. */
export function startLive(api: ApiClient, request: LiveStartRequestDto): Promise<LiveStartResponseDto> {
  const parsed = parseLiveStartRequest(request);
  return api.request<unknown>('POST', '/live/start', parsed).then(parseLiveStartResponse);
}
