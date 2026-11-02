import { useCallback, useEffect, useState } from 'react';

import { ensureSession } from '../api/auth.ts';
import { sendCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto, SessionDto } from '../api/types.ts';
import type { AppServices } from './services.ts';

export type GameSession =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: string }
  | { readonly phase: 'ready'; readonly session: SessionDto; readonly character: CharacterDto | null };

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

  const retry = useCallback(() => { setState({ phase: 'loading' }); setAttempt((value) => value + 1); }, []);

  /**
   * Sends a character command (held while disconnected) and shows the server's resulting character. Throws
   * CommandRejectedError / CommandUnconfirmedError; re-running the *same* request after the latter is safe.
   */
  const runCharacterCommand = useCallback(async (request: CommandRequest<CharacterDto>) => {
    const character = await sendCommand(api, request, { waitUntilConnected: () => live.waitUntilOpen() });
    setState((current) => (current.phase === 'ready' ? { ...current, character } : current));
  }, [api, live]);

  return { state, retry, runCharacterCommand };
}
