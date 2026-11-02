import { useState } from 'react';
import type { FormEvent } from 'react';

import { CommandUnconfirmedError, createCharacterCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { AttributeKey, CharacterDto } from '../api/types.ts';
import { describeError } from '../app/useGameSession.ts';

const ATTRIBUTE_ORDER: readonly AttributeKey[] = ['STR', 'AGI', 'INT', 'VIT', 'SPI'];

/** Display-only formatting of a stable content ID (`skill:shield_bash` → `Shield bash`); names come with content. */
function displayId(id: string): string {
  const raw = id.slice(id.indexOf(':') + 1).replaceAll('_', ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

interface Props {
  readonly character: CharacterDto | null;
  readonly canCommand: boolean;
  readonly runCharacterCommand: (request: CommandRequest<CharacterDto>) => Promise<void>;
}

export function CharacterScreen({ character, canCommand, runCharacterCommand }: Props) {
  if (!character) return <CreateCharacter canCommand={canCommand} run={runCharacterCommand} />;
  return (
    <section className="screen" aria-labelledby="character-title">
      <h1 id="character-title" className="screen__title">{character.name}</h1>
      <dl className="stats">
        <div><dt>Level</dt><dd>{character.level}</dd></div>
        <div><dt>XP</dt><dd>{character.xp}</dd></div>
        <div><dt>Unspent points</dt><dd>{character.unspentPoints}</dd></div>
        <div><dt>Activity</dt><dd>{character.activityState === 'none' ? 'In the Sanctuary' : character.activityState}</dd></div>
      </dl>
      <h2 className="screen__subtitle">Attributes</h2>
      <dl className="attributes">
        {ATTRIBUTE_ORDER.map((key) => (
          <div key={key}><dt>{key}</dt><dd>{character.attributes[key]}</dd></div>
        ))}
      </dl>
      <h2 className="screen__subtitle">Skill loadout</h2>
      <ol className="loadout">
        {character.skillLoadout.map((skill) => <li key={skill}>{displayId(skill)}</li>)}
      </ol>
      <p className="muted">
        {character.automationRules.length} automation rules. Derived stats, the rules editor and build presets arrive
        with later client issues.
      </p>
    </section>
  );
}

function CreateCharacter({ canCommand, run }: { canCommand: boolean; run: Props['runCharacterCommand'] }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Kept after an unconfirmed send so "Retry" re-sends the same command_id instead of creating a new command. */
  const [unconfirmed, setUnconfirmed] = useState<CommandRequest<CharacterDto> | null>(null);

  async function send(request: CommandRequest<CharacterDto>) {
    setPending(true);
    setError(null);
    try {
      await run(request);
      setUnconfirmed(null);
    } catch (failure) {
      if (failure instanceof CommandUnconfirmedError) setUnconfirmed(request);
      else setUnconfirmed(null);
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(unconfirmed ?? createCharacterCommand(name.trim()));
  }

  const trimmed = name.trim();
  return (
    <section className="screen" aria-labelledby="create-title">
      <h1 id="create-title" className="screen__title">Create your character</h1>
      <form className="form" onSubmit={onSubmit}>
        <label className="form__label" htmlFor="character-name">Name</label>
        <input
          id="character-name"
          className="form__input"
          value={name}
          maxLength={32}
          autoComplete="off"
          disabled={pending || unconfirmed !== null}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="form__error" role="alert">Could not create the character ({error}).</p>}
        <button className="button" type="submit" disabled={!canCommand || pending || trimmed.length === 0}>
          {pending ? 'Creating…' : unconfirmed ? 'Retry' : 'Create'}
        </button>
        {!canCommand && <p className="muted">Waiting for the connection…</p>}
      </form>
    </section>
  );
}
