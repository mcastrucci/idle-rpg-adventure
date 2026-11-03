import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureSession } from '../api/auth.ts';
import { sendCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto, SessionDto } from '../api/types.ts';
import type { AppServices } from './services.ts';
import { currentLive } from '../live/api.ts';

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
  const refreshSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await ensureSession(api, storage);
        const characters = await api.listCharacters();
        if (cancelled) return;
        let character = characters[0] ?? null;
        // The live host can outlive a browser page. Reconcile once at boot so a durable character snapshot
        // that missed the start transition cannot strand an existing host instance behind the map.
        if (character?.activityState === 'none') {
          try {
            const hosted = await currentLive(api, character.actorId);
            if (cancelled) return;
            if (hosted.current?.actorId === character.actorId) {
              character = { ...character, activityState: 'live', activityId: hosted.current.instanceId };
            }
          } catch { /* Character loading remains usable if live-host discovery is temporarily unavailable. */ }
        }
        if (cancelled) return;
        setState({ phase: 'ready', session, character });
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
        const recovered = isEscrowReturnedReport(expedition.terminalReport);
        setState((current) => current.phase === 'ready' && current.character?.activityId === monitoredExpeditionId
          ? { ...current, character, expeditionNotice: recovered ? 'Expedition ended; consumables returned, no rewards or XP awarded.'
            : expedition.state === 'completed' ? 'Expedition completed' : 'Expedition cancelled' }
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
      const report = 'terminalReport' in result ? result['terminalReport'] : null;
      const recovered = isEscrowReturnedReport(report);
      setState((current) => current.phase === 'ready' ? { ...current, expeditionNotice: recovered ? 'Expedition ended; consumables returned, no rewards or XP awarded.'
        : status === 'completed' ? 'Expedition completed' : 'Expedition cancelled' } : current);
    }
    return result;
  }, [api, live]);

  const refreshCharacter = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== 'ready' || !current.character) return;
    const actorId = current.character.actorId;
    const sequence = ++refreshSequence.current;
    let character = current.character;
    try {
      character = await api.character(actorId);
    } catch (error) {
      // A character refresh can fail independently of the live host. Still discover the host so a
      // successfully started instance remains reachable from the map.
      const hosted = await currentLive(api, actorId);
      if (hosted.current?.actorId !== actorId) throw error;
      character = { ...current.character, activityState: 'live', activityId: hosted.current.instanceId };
    }
    if (character.activityState === 'none') {
      try {
        const hosted = await currentLive(api, actorId);
        if (hosted.current?.actorId === actorId) {
          character = { ...character, activityState: 'live', activityId: hosted.current.instanceId };
        }
      } catch { /* A valid character response wins; live-host discovery is an optional reconciliation. */ }
    }
    if (sequence !== refreshSequence.current) return;
    setState((latest) => latest.phase === 'ready' && latest.character?.actorId === actorId
      ? { ...latest, character } : latest);
  }, [api]);

  const dismissExpeditionNotice = useCallback(() => {
    setState((current) => current.phase === 'ready' ? { ...current, expeditionNotice: '' } : current);
  }, []);

  return { state, retry, runCharacterCommand, runExpeditionCommand, refreshCharacter, dismissExpeditionNotice };
}

function isEscrowReturnedReport(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['kind'] === 'escrow_returned';
}
