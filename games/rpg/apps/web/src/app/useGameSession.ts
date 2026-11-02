import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureSession } from '../api/auth.ts';
import { sendCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto, SessionDto } from '../api/types.ts';
import type { AppServices } from './services.ts';

export type GameSession =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: string }
  | { readonly phase: 'ready'; readonly session: SessionDto; readonly character: CharacterDto | null; readonly expeditionNotice?: string };

export function describeError(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : 'unknown_error';
}

/**
 * Boots the authenticated session (cookie or device guest login), loads the account's character, and starts the
 * live socket. All state shown comes from server responses; the client computes nothing.
 */
export function useGameSession({ api, live, storage }: AppServices) {
  const [state, setState] = useState<GameSession>({ phase: 'loading' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await ensureSession(api, storage);
        const characters = await api.listCharacters();
        if (cancelled) return;
        setState({ phase: 'ready', session, character: characters[0] ?? null });
        live.start();
      } catch (error) {
        if (!cancelled) setState({ phase: 'error', error: describeError(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [api, live, storage, attempt]);

  useEffect(() => () => live.stop(), [live]);

  const monitoredActorId = state.phase === 'ready' && state.character?.activityState === 'expedition' ? state.character.actorId : null;
  const monitoredExpeditionId = state.phase === 'ready' && state.character?.activityState === 'expedition' ? state.character.activityId : null;
  useEffect(() => {
    if (!monitoredActorId || !monitoredExpeditionId) return;
    let cancelled = false;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const expedition = await api.expedition(monitoredExpeditionId);
        if (cancelled || expedition.state === 'running') return;
        const character = await api.character(monitoredActorId);
        if (cancelled) return;
        setState((current) => current.phase === 'ready' && current.character?.activityId === monitoredExpeditionId
          ? { ...current, character, expeditionNotice: expedition.state === 'completed' ? 'Expedition completed' : 'Expedition cancelled' }
          : current);
      } catch { /* Keep the active chip and retry on the next poll or focus. */ }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(() => { void check(); }, 15_000);
    const onFocus = () => { void check(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void check();
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [api, monitoredActorId, monitoredExpeditionId]);

  const retry = useCallback(() => { setState({ phase: 'loading' }); setAttempt((value) => value + 1); }, []);

  /**
   * Sends a character command (held while disconnected) and shows the server's resulting character. Throws
   * CommandRejectedError / CommandUnconfirmedError; re-running the *same* request after the latter is safe.
   */
  const runCharacterCommand = useCallback(async (request: CommandRequest<CharacterDto>) => {
    const character = await sendCommand(api, request, { waitUntilConnected: () => live.waitUntilOpen() });
    setState((current) => (current.phase === 'ready' ? { ...current, character } : current));
  }, [api, live]);

  const runExpeditionCommand = useCallback(async <T,>(request: CommandRequest<T>): Promise<T> => {
    const result = await sendCommand(api, request, { waitUntilConnected: () => live.waitUntilOpen() });
    if (result !== null && typeof result === 'object' && 'state' in result && ['completed', 'cancelled'].includes(String(result['state']))) {
      const status = String(result['state']);
      setState((current) => current.phase === 'ready' ? { ...current, expeditionNotice: status === 'completed' ? 'Expedition completed' : 'Expedition cancelled' } : current);
    }
    return result;
  }, [api, live]);

  const refreshCharacter = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== 'ready' || !current.character) return;
    const character = await api.character(current.character.actorId);
    setState((latest) => latest.phase === 'ready' ? { ...latest, character } : latest);
  }, [api]);

  const dismissExpeditionNotice = useCallback(() => {
    setState((current) => current.phase === 'ready' ? { ...current, expeditionNotice: '' } : current);
  }, []);

  return { state, retry, runCharacterCommand, runExpeditionCommand, refreshCharacter, dismissExpeditionNotice };
}
