import { AutomationRuleSchema, MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { CommandUnconfirmedError, createCharacterCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto } from '../api/types.ts';
import type { ApiClient } from '../api/http.ts';
import type { LiveConnection } from '../app/services.ts';
import { describeError } from '../app/useGameSession.ts';
import { codeText, t } from '../i18n/index.ts';
import { levelProgress } from '../character/progression.ts';
import { describeRule } from '../rules/describe.ts';
import { AttributesPanel } from './character/AttributesPanel.tsx';
import './character/character.css';
import { StatSummaryPanel } from './character/StatSummaryPanel.tsx';
import { LoadoutEditor } from './character/LoadoutEditor.tsx';
import { DeathPanel } from './character/DeathPanel.tsx';

interface Props {
  readonly character: CharacterDto | null;
  readonly canCommand: boolean;
  readonly runCharacterCommand: (request: CommandRequest<CharacterDto>) => Promise<void>;
  /** Injected in tests for a predictable command_id. */
  readonly newCommandId?: () => string;
  readonly api?: ApiClient;
  readonly live?: LiveConnection;
}

export function CharacterScreen({ character, canCommand, runCharacterCommand, newCommandId, api, live }: Props) {
  if (!character) return <CreateCharacter canCommand={canCommand} run={runCharacterCommand} />;
  const inSanctuary = character.activityState === 'none';
  return (
    <section className="screen character" aria-labelledby="character-title">
      <h1 id="character-title" className="screen__title">{character.name}</h1>
      <LevelSummary character={character} />
      {api && <DeathPanel actorId={character.actorId} api={api} live={live} />}
      <p className={`character-activity${inSanctuary ? '' : ' character-activity--busy'}`}>
        {inSanctuary
          ? t('ui.character.activity_sanctuary')
          : character.activityState === 'live' ? t('ui.character.activity_live') : t('ui.character.activity_expedition')}
      </p>
      <AttributesPanel character={character} canCommand={canCommand} runCharacterCommand={runCharacterCommand} newCommandId={newCommandId} />
      {api && <StatSummaryPanel character={character} api={api} />}
      <LoadoutEditor character={character} canCommand={canCommand} runCharacterCommand={runCharacterCommand} newCommandId={newCommandId} />
      <section className="character-section" aria-labelledby="rules-summary-title">
        <h2 id="rules-summary-title" className="screen__subtitle">{t('ui.character.rules_title', { current: character.automationRules.length, max: MAX_AUTOMATION_RULES })}</h2>
        <RulesSummary rules={character.automationRules} />
        <a className="button button--link" href="#/character/rules">{t('ui.rules.edit_link')}</a>
      </section>
    </section>
  );
}

/** Level and XP inside the level, from the shared rpg-stats XP helpers over the (mirrored) content curve. */
function LevelSummary({ character }: { character: CharacterDto }) {
  const progress = levelProgress(character.level, character.xp);
  if (!progress) {
    return <p className="character-level">{t('ui.character.level_xp', { level: character.level, xp: character.xp })} <span className="muted">{t('ui.character.xp_unknown')}</span></p>;
  }
  const label = progress.xpToNext === null
    ? t('ui.character.xp_max', { xp: progress.xpIntoLevel })
    : t('ui.character.xp_progress', { xp: progress.xpIntoLevel, next: progress.xpToNext });
  return (
    <div className="character-level">
      <p>{t('ui.character.level_line', { level: progress.level, label })}</p>
      <div className="xp-bar" role="progressbar" aria-label={t('ui.character.xp_bar_label')} aria-valuemin={0} aria-valuemax={10_000}
        aria-valuenow={progress.progressBp} aria-valuetext={label}>
        <div className="xp-bar__fill" style={{ width: `${progress.progressBp / 100}%` }} />
      </div>
    </div>
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
      <h1 id="create-title" className="screen__title">{t('ui.character.create_title')}</h1>
      <form className="form" onSubmit={onSubmit}>
        <label className="form__label" htmlFor="character-name">{t('ui.character.name')}</label>
        <input
          id="character-name"
          className="form__input"
          value={name}
          maxLength={32}
          autoComplete="off"
          disabled={pending || unconfirmed !== null}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="form__error" role="alert">{t('ui.character.create_failed', { error: codeText(error) })}</p>}
        <button className="button" type="submit" disabled={!canCommand || pending || trimmed.length === 0}>
          {pending ? t('ui.character.creating') : unconfirmed ? t('ui.common.retry') : t('ui.character.create')}
        </button>
        {!canCommand && <p className="muted">{t('ui.common.waiting_connection')}</p>}
      </form>
    </section>
  );
}

/** Read-only list of the saved rules, in evaluation order. */
function RulesSummary({ rules }: { rules: readonly unknown[] }) {
  if (rules.length === 0) return <p className="muted">{t('ui.rules.none_summary')}</p>;
  return (
    <ol className="rules-summary">
      {rules.map((raw, index) => {
        const parsed = AutomationRuleSchema.safeParse(raw);
        return <li key={index}>{parsed.success ? describeRule(parsed.data) : t('ui.rules.unreadable')}</li>;
      })}
    </ol>
  );
}
