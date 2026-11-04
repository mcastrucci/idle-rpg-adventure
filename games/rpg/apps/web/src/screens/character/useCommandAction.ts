import { useState } from 'react';

import { CommandUnconfirmedError } from '../../api/commands.ts';
import type { CommandRequest } from '../../api/commands.ts';
import type { CharacterDto } from '../../api/types.ts';
import { describeError } from '../../app/useGameSession.ts';
import { t } from '../../i18n/index.ts';

export type RunCharacterCommand = (request: CommandRequest<CharacterDto>) => Promise<void>;

/** What a configuration action edits; selects the noun used in its error messages. */
export type ConfigurationSubject = 'allocation' | 'loadout';

const SUBJECT_KEYS = {
  allocation: { this: 'ui.config_error.this_allocation', the: 'ui.config_error.the_allocation' },
  loadout: { this: 'ui.config_error.this_loadout', the: 'ui.config_error.the_loadout' },
} as const;

/** Plain-language text for the configuration command's stable error codes. */
export function configurationError(code: string, what: ConfigurationSubject): string {
  const subject = SUBJECT_KEYS[what];
  switch (code) {
    case 'invalid_configuration': return t('ui.config_error.invalid_configuration', { what: t(subject.this) });
    case 'invalid_command': return t('ui.config_error.invalid_command', { what: t(subject.this) });
    case 'busy': return t('ui.config_error.busy');
    case 'not_found': return t('ui.config_error.not_found');
    default: return t('ui.config_error.default', { what: t(subject.the), code });
  }
}

/**
 * One configuration action (save loadout, spend points): pending state, the server's error, and an unconfirmed
 * request kept so "Retry" re-sends the same `command_id` (never a new command for the same intent).
 */
export function useCommandAction(run: RunCharacterCommand, what: ConfigurationSubject) {
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
        setError(t('ui.common.save_unconfirmed'));
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
