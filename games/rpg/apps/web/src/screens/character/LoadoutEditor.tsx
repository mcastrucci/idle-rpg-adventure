import type { CommandJson } from '@rpg/protocol';
import type { SkillId } from '@rpg/rpg-schema';
import { useMemo, useState } from 'react';

import { configureCharacterCommand } from '../../api/commands.ts';
import type { CharacterDto } from '../../api/types.ts';
import {
  ACTIVE_SLOTS, assignSlot, LOADOUT_PRESETS, presetLockedReason, ruleConflicts, rulesWithout, sameLoadout, skillOptions,
  toLoadout, toSlots,
} from '../../character/loadout.ts';
import type { SlotDraft } from '../../character/loadout.ts';
import { ID_LABELS } from '../../content/labels.ts';
import type { ContentLabels } from '../../content/labels.ts';
import { BASIC_ATTACK } from '../../rules/catalog.ts';
import { describeRule } from '../../rules/describe.ts';
import { useCommandAction } from './useCommandAction.ts';
import type { RunCharacterCommand } from './useCommandAction.ts';

interface Props {
  readonly character: CharacterDto;
  readonly canCommand: boolean;
  readonly runCharacterCommand: RunCharacterCommand;
  readonly labels?: ContentLabels;
  /** Injected in tests for a predictable command_id. */
  readonly newCommandId?: (() => string) | undefined;
}

/**
 * Four provisional active slots (open decision #13) plus the always-equipped basic attack. The draft is local until
 * "Save loadout" sends one `character.configure` command; the screen then shows what the server returned.
 */
export function LoadoutEditor({ character, canCommand, runCharacterCommand, labels = ID_LABELS, newCommandId }: Props) {
  const [slots, setSlots] = useState<SlotDraft>(() => toSlots(character.skillLoadout));
  const [syncedVersion, setSyncedVersion] = useState(character.version);
  const [announcement, setAnnouncement] = useState('');
  const action = useCommandAction(runCharacterCommand, 'loadout');

  // Reflect server state: any new character version (our save or another change) replaces the draft.
  if (character.version !== syncedVersion) {
    setSyncedVersion(character.version);
    setSlots(toSlots(character.skillLoadout));
  }

  const options = useMemo(() => skillOptions(character.skillLoadout), [character.skillLoadout]);
  const loadout = toLoadout(slots);
  const dirty = !sameLoadout(loadout, character.skillLoadout);
  const conflicts = ruleConflicts(character.automationRules, loadout);
  const lockedInDraft = loadout.filter((id) => !options.some((option) => option.id === id && option.unlocked));
  const inSanctuary = character.activityState === 'none';
  const editable = inSanctuary && !action.locked;
  const valid = conflicts.length === 0 && lockedInDraft.length === 0;
  const canSave = canCommand && inSanctuary && !action.pending && (action.unconfirmed || (dirty && valid));
  const canSaveDropping = canCommand && inSanctuary && !action.locked && dirty && conflicts.length > 0 && lockedInDraft.length === 0;

  function edit(next: SlotDraft, message?: string) {
    setSlots(next);
    action.clearError();
    if (message) setAnnouncement(message);
  }

  async function save(dropConflicts: boolean) {
    const ok = await action.submit(() => {
      const configuration: Record<string, CommandJson> = { skillLoadout: loadout };
      if (dropConflicts) configuration['automationRules'] = rulesWithout(character.automationRules, conflicts) as CommandJson;
      return configureCharacterCommand(character.actorId, configuration, newCommandId);
    });
    if (ok) setAnnouncement(dropConflicts ? `Loadout saved; ${conflicts.length} rules removed.` : 'Loadout saved.');
  }

  let status: string;
  if (!inSanctuary) status = 'Changes are only possible while the character is in the Sanctuary.';
  else if (!canCommand) status = 'Waiting for the connection…';
  else if (action.pending) status = 'Saving…';
  else if (action.unconfirmed) status = 'Save not confirmed.';
  else if (dirty && !valid) status = 'Resolve the problems above before saving.';
  else if (dirty) status = 'Unsaved changes.';
  else status = 'Loadout saved.';

  return (
    <section className="character-section" aria-labelledby="loadout-title">
      <h2 id="loadout-title" className="screen__subtitle">Skill loadout</h2>
      <p className="muted character-note">
        Up to {ACTIVE_SLOTS} active skills. {labels.skill(BASIC_ATTACK)} is always equipped and is not in a slot.
      </p>

      <div className="presets__list" role="group" aria-label="Build presets">
        {LOADOUT_PRESETS.map((preset) => {
          const reason = presetLockedReason(preset, options, labels);
          const noteId = `loadout-preset-${preset.id}-note`;
          return (
            <div key={preset.id} className="preset">
              <button type="button" className="button button--secondary" aria-describedby={noteId}
                disabled={!editable || reason !== null}
                onClick={() => edit(toSlots(preset.loadout), `${preset.name} loadout applied. Review it, then save.`)}>
                Use {preset.name}
              </button>
              <p id={noteId} className="preset__note muted">{reason ?? preset.blurb}</p>
            </div>
          );
        })}
      </div>

      <fieldset className="loadout-slots" disabled={!editable}>
        <legend className="visually-hidden">Active skill slots</legend>
        {slots.map((skill, index) => {
          const id = `loadout-slot-${index + 1}`;
          const info = options.find((option) => option.id === skill);
          return (
            <div key={index} className={`slot${skill === null ? ' slot--empty' : ''}`}>
              <label className="slot__label" htmlFor={id}>Slot {index + 1}</label>
              <select id={id} className="form__input" value={skill ?? ''} aria-describedby={`${id}-info`} disabled={!editable}
                onChange={(event) => {
                  const value = event.target.value === '' ? null : event.target.value as SkillId;
                  edit(assignSlot(slots, index, value));
                }}>
                <option value="">Empty</option>
                {options.map((option) => {
                  const elsewhere = slots.indexOf(option.id);
                  const suffix = !option.unlocked ? ' (locked)' : elsewhere !== -1 && elsewhere !== index ? ` (swap with slot ${elsewhere + 1})` : '';
                  return (
                    <option key={option.id} value={option.id} disabled={!option.unlocked && option.id !== skill}>
                      {labels.skill(option.id)}{suffix}
                    </option>
                  );
                })}
              </select>
              <p id={`${id}-info`} className="slot__info muted">
                {skill === null ? 'No skill.' : info ? `${info.summary} Cooldown ${info.cooldownTicks} ticks.` : 'Skill details unavailable.'}
              </p>
            </div>
          );
        })}
        <div className="slot slot--fixed">
          <span className="slot__label">Always</span>
          <span className="slot__fixed-name">{labels.skill(BASIC_ATTACK)}</span>
          <p className="slot__info muted">A plain hit (100% damage), no cooldown. Used when no rule fires.</p>
        </div>
      </fieldset>

      {lockedInDraft.length > 0 && (
        <p className="form__error">⚠ {lockedInDraft.map((id) => labels.skill(id)).join(', ')} not unlocked yet.</p>
      )}

      {dirty && conflicts.length > 0 && (
        <div className="conflict" role="group" aria-labelledby="loadout-conflict-title">
          <p id="loadout-conflict-title" className="conflict__title">
            ⚠ {conflicts.length === 1 ? '1 automation rule uses' : `${conflicts.length} automation rules use`} a skill this
            loadout removes. Change or remove {conflicts.length === 1 ? 'it' : 'them'} before saving.
          </p>
          <ul className="conflict__list">
            {conflicts.map((conflict) => (
              <li key={conflict.index}>
                Rule {conflict.index + 1}: {describeRule(conflict.rule, labels)}{' '}
                <span className="muted">(needs {conflict.missing.map((id) => labels.skill(id)).join(', ')})</span>
              </li>
            ))}
          </ul>
          <div className="conflict__actions">
            <a className="button button--secondary button--link" href="#/character/rules">Edit automation rules</a>
            <button type="button" className="button button--secondary" disabled={!canSaveDropping} onClick={() => void save(true)}>
              Save and remove {conflicts.length === 1 ? '1 rule' : `${conflicts.length} rules`}
            </button>
          </div>
          <p className="muted character-note">Leaving this screen discards the unsaved loadout.</p>
        </div>
      )}

      <div className="savebar savebar--inline">
        <p className="savebar__status" id="loadout-status">{status}</p>
        {action.error && <p className="form__error" role="alert">{action.error}</p>}
        <div className="savebar__actions">
          <button type="button" className="button button--secondary" disabled={!editable || !dirty}
            onClick={() => edit(toSlots(character.skillLoadout), 'Loadout changes discarded.')}>Discard</button>
          <button type="button" className="button" disabled={!canSave} aria-describedby="loadout-status" onClick={() => void save(false)}>
            {action.pending ? 'Saving…' : action.unconfirmed ? 'Retry save' : 'Save loadout'}
          </button>
        </div>
      </div>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
    </section>
  );
}
