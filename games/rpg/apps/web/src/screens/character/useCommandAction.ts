import { useState } from 'react';

import { CommandUnconfirmedError } from '../../api/commands.ts';
import type { CommandRequest } from '../../api/commands.ts';
import type { CharacterDto } from '../../api/types.ts';
import { describeError } from '../../app/useGameSession.ts';

export type RunCharacterCommand = (request: CommandRequest<CharacterDto>) => Promise<void>;

/** Plain-language text for the configuration command's stable error codes. */
export function configurationError(code: string, what: string): string {
  switch (code) {
    case 'invalid_configuration': return `The server rejected this ${what} (invalid_configuration): a skill, rule or point value is not allowed.`;
    case 'invalid_command': return `The server could not read this ${what} (invalid_command).`;
    case 'busy': return 'Changes are only possible while the character is in the Sanctuary (busy).';
    case 'not_found': return 'This character no longer exists (not_found).';
    default: return `Could not save the ${what} (${code}).`;
  }
}

/**
 * One configuration action (save loadout, spend points): pending state, the server's error, and an unconfirmed
 * request kept so "Retry" re-sends the same `command_id` (never a new command for the same intent).
 */
export function useCommandAction(run: RunCharacterCommand, what: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<CommandRequest<CharacterDto> | null>(null);

  async function submit(build: () => CommandRequest<CharacterDto>): Promise<boolean> {
    const request = unconfirmed ?? build();
    setPending(true);
    setError(null);
    try {
      await run(request);
      setUnconfirmed(null);
      return true;
    } catch (failure) {
      if (failure instanceof CommandUnconfirmedError) {
        setUnconfirmed(request);
        setError('The save could not be confirmed. Retry sends the same command, so it is never applied twice.');
      } else {
        setUnconfirmed(null);
        setError(configurationError(describeError(failure), what));
      }
      return false;
    } finally {
      setPending(false);
    }
  }

  return { pending, error, unconfirmed: unconfirmed !== null, locked: pending || unconfirmed !== null, submit, clearError: () => setError(null) };
}
