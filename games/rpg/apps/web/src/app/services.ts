import { useCallback, useSyncExternalStore } from 'react';

import type { ApiClient } from '../api/http.ts';
import type { LiveClient } from '../live/client.ts';
import type { LiveState } from '../live/state.ts';

export type LiveConnection = Pick<LiveClient, 'state' | 'subscribe' | 'start' | 'stop' | 'online' | 'offline' | 'waitUntilOpen'>;

/** Everything the UI talks to, injected so tests can supply fakes. */
export interface AppServices {
  readonly api: ApiClient;
  readonly live: LiveConnection;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
}

export function useLiveState(live: LiveConnection): LiveState {
  const subscribe = useCallback((listener: () => void) => live.subscribe(listener), [live]);
  return useSyncExternalStore(subscribe, () => live.state);
}
