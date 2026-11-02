import { AutomationRuleSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { CommandUnconfirmedError, createCharacterCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { AttributeKey, CharacterDto } from '../api/types.ts';
import { describeError } from '../app/useGameSession.ts';
import { displayId } from '../content/labels.ts';
import { describeRule } from '../rules/describe.ts';

const ATTRIBUTE_ORDER: readonly AttributeKey[] = ['STR', 'AGI', 'INT', 'VIT', 'SPI'];

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
      <h2 className="screen__subtitle">Automation rules ({character.automationRules.length}/{MAX_AUTOMATION_RULES})</h2>
      <RulesSummary rules={character.automationRules} />
      <a className="button button--link" href="#/character/rules">Edit automation rules</a>
      <p className="muted">Derived stats arrive with a later client issue.</p>
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

/** Read-only list of the saved rules, in evaluation order. */
function RulesSummary({ rules }: { rules: readonly unknown[] }) {
  if (rules.length === 0) return <p className="muted">No rules: the character only uses basic attacks.</p>;
  return (
    <ol className="rules-summary">
      {rules.map((raw, index) => {
        const parsed = AutomationRuleSchema.safeParse(raw);
        return <li key={index}>{parsed.success ? describeRule(parsed.data) : 'Unreadable rule'}</li>;
      })}
    </ol>
  );
}
