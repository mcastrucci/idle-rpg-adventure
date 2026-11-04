import { statDelta } from '@rpg/rpg-stats';
import { useState } from 'react';

import { configureCharacterCommand } from '../../api/commands.ts';
import type { CharacterDto } from '../../api/types.ts';
import {
  adjustAllocation, allocatePayload, ATTRIBUTE_HINTS, ATTRIBUTE_ORDER, NO_ALLOCATION, pointsSpent, withAllocation,
} from '../../character/attributes.ts';
import type { AttributeValues } from '../../character/attributes.ts';
import { derivedStats, formatDelta, statRows } from '../../character/stats.ts';
import { useCommandAction } from './useCommandAction.ts';
import type { RunCharacterCommand } from './useCommandAction.ts';

interface Props {
  readonly character: CharacterDto;
  readonly canCommand: boolean;
  readonly runCharacterCommand: RunCharacterCommand;
  readonly newCommandId?: (() => string) | undefined;
}

/**
 * Attributes, earned unspent points and derived stats. The server only accepts additive spending of earned points
 * (`allocate`); there is no respec, so attribute presets are not offered. Derived stats use the shared rpg-stats
 * derivation for display; a pending allocation previews its effect before it is sent.
 */
export function AttributesPanel({ character, canCommand, runCharacterCommand, newCommandId }: Props) {
  const [allocation, setAllocation] = useState<AttributeValues>(NO_ALLOCATION);
  const [syncedVersion, setSyncedVersion] = useState(character.version);
  const action = useCommandAction(runCharacterCommand, 'allocation');

  if (character.version !== syncedVersion) {
    setSyncedVersion(character.version);
    setAllocation(NO_ALLOCATION);
  }

  const spent = pointsSpent(allocation);
  const remaining = character.unspentPoints - spent;
  const inSanctuary = character.activityState === 'none';
  const canAllocate = character.unspentPoints > 0 && inSanctuary;
  const current = derivedStats(character.level, character.attributes);
  const preview = spent > 0 ? derivedStats(character.level, withAllocation(character.attributes, allocation)) : current;
  const delta = statDelta(current, preview);
  const rows = statRows(preview);

  function adjust(key: keyof AttributeValues, by: number) {
    setAllocation(adjustAllocation(allocation, key, by, character.unspentPoints));
    action.clearError();
  }

  async function spend() {
    await action.submit(() => configureCharacterCommand(character.actorId, { allocate: allocatePayload(allocation) }, newCommandId));
  }

  return (
    <>
      <section className="character-section" aria-labelledby="attributes-title">
        <h2 id="attributes-title" className="screen__subtitle">
          Attributes{character.unspentPoints > 0 ? ` · ${remaining} of ${character.unspentPoints} points to spend` : ''}
        </h2>
        {character.unspentPoints === 0 && <p className="muted character-note">No unspent points. Points are earned by levelling up.</p>}
        <ul className="attribute-list">
          {ATTRIBUTE_ORDER.map((key) => {
            const added = allocation[key];
            return (
              <li key={key} className="attribute" aria-label={`${key} ${character.attributes[key] + added}`}>
                <span className="attribute__key">{key}</span>
                <span className="attribute__value">
                  {character.attributes[key] + added}
                  {added > 0 && <span className="delta delta--up"> +{added}</span>}
                </span>
                <span className="attribute__hint muted">{ATTRIBUTE_HINTS[key]}</span>
                {canAllocate && (
                  <span className="attribute__steppers">
                    <button type="button" className="icon-button" aria-label={`Remove a point from ${key}`}
                      disabled={action.locked || added === 0} onClick={() => adjust(key, -1)}>−</button>
                    <button type="button" className="icon-button" aria-label={`Add a point to ${key}`}
                      disabled={action.locked || remaining === 0} onClick={() => adjust(key, 1)}>+</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {canAllocate && (
          <div className="savebar savebar--inline">
            {action.error && <p className="form__error" role="alert">{action.error}</p>}
            {!canCommand && <p className="savebar__status">Waiting for the connection…</p>}
            <div className="savebar__actions">
              <button type="button" className="button button--secondary" disabled={action.locked || spent === 0}
                onClick={() => setAllocation(NO_ALLOCATION)}>Reset</button>
              <button type="button" className="button" disabled={!canCommand || action.pending || (!action.unconfirmed && spent === 0)}
                onClick={() => void spend()}>
                {action.pending ? 'Saving…' : action.unconfirmed ? 'Retry' : `Spend ${spent} ${spent === 1 ? 'point' : 'points'}`}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="character-section" aria-labelledby="derived-title">
        <h2 id="derived-title" className="screen__subtitle">Derived stats</h2>
        <p className="muted character-note">
          Level {character.level}, without gear; see the stat summary below for gear and totals. Provisional formulas.
        </p>
        <dl className="derived-stats">
          {rows.map((row) => {
            const change = formatDelta(row.key, delta);
            const better = change !== null && (delta[row.key] > 0) !== row.lowerIsBetter;
            return (
              <div key={row.key} className="derived-stat" data-stat={row.key}>
                <dt>{row.label}</dt>
                <dd>
                  <span className="derived-stat__value">{row.text}</span>
                  {change && <span className={`delta ${better ? 'delta--up' : 'delta--down'}`}> {change}</span>}
                  <span className="derived-stat__why muted">{row.explanation}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
    </>
  );
}
