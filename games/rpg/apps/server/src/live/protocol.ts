import { parseLiveClientRequest } from '@rpg/protocol';
import type { LiveClientRequest } from '@rpg/protocol';
import type { LiveSocketConnection } from '@engine/server-kit';
import type { RpgLiveHost } from './index.ts';

/** RPG adapter that applies the shared wire validator before handing a live operation to the game agnostic host. */
export async function handleRpgLiveSocketCommand(payload: unknown, identity: { readonly accountId: string },
  connection: LiveSocketConnection, live: RpgLiveHost): Promise<unknown | undefined> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const operation = (payload as Record<string, unknown>)['op'];
  if (typeof operation !== 'string' || !operation.startsWith('live.')) return undefined;
  let request: LiveClientRequest;
  try { request = parseLiveClientRequest(payload); }
  catch { return { type: 'live.error', error: 'invalid_live_command' }; }
  return live.handleSocketCommand(request, identity, connection);
}
