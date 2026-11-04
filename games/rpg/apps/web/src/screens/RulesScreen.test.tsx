import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { sendCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { PRESETS } from '../rules/presets.ts';
import { RulesScreen } from './RulesScreen.tsx';

const ACTOR = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const SAVED = [
  { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
  { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
];
const CHARACTER: CharacterDto = {
  actorId: ACTOR, accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 1, xp: 0,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0,
  skillLoadout: ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
  automationRules: SAVED, activityState: 'none', activityId: null, version: 3,
};
const noWait = { sleep: () => Promise.resolve(), backoff: () => 0 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Envelope { command_id: string; operation: string; payload: { automationRules: unknown[] } }

/**
 * Fake server for PATCH /characters/:id/configuration. `script` decides each answer: 'ok' applies the rules (stores a
 * new version), a number answers that error status, 'drop' loses the network.
 */
function harness(script: ('ok' | 'drop' | number)[], initial: Partial<CharacterDto> = {}) {
  const requests: { url: string; method: string; body: Envelope }[] = [];
  let current: CharacterDto = { ...CHARACTER, ...initial };
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Envelope;
    requests.push({ url, method: String(init?.method), body });
    const step = script.shift() ?? 'ok';
    if (step === 'drop') throw new TypeError('Failed to fetch');
    if (typeof step === 'number') return json(step, { error: step === 409 ? 'busy' : 'invalid_configuration' });
    current = { ...current, automationRules: body.payload.automationRules, version: current.version + 1 };
    return json(200, current);
  };
  const api = new ApiClient(fetch);
  let setConnected: (value: boolean) => void = () => {};

  function Host() {
    const [character, setCharacter] = useState<CharacterDto>(current);
    const [connected, setConnectedState] = useState(true);
    setConnected = setConnectedState;
    const run = async (request: CommandRequest<CharacterDto>) => {
      setCharacter(await sendCommand(api, request, { ...noWait, maxAttempts: 2 }));
    };
    return <RulesScreen character={character} canCommand={connected} runCharacterCommand={run} />;
  }
  render(<Host />);
  return { requests, connect: (value: boolean) => act(() => setConnected(value)) };
}

const cards = () => within(screen.getByRole('list', { name: /^Rules/ })).getAllByRole('listitem');
const summaries = () => cards().map((card) => card.querySelector('.rule-card__summary')?.textContent);
const save = () => screen.getByRole('button', { name: /^(Save rules|Retry save|Saving…)$/ });
const isDisabled = (element: HTMLElement) => element.hasAttribute('disabled');

describe('RulesScreen', () => {
  afterEach(() => { cleanup(); });

  it('lists the saved rules in order with plain-language summaries', () => {
    harness([]);
    expect(summaries()).toEqual([
      'If my HP is below 55% and Mend is ready, use Mend on myself.',
      'Always use Basic Attack on the enemy with the lowest HP.',
    ]);
    expect(screen.getByRole('status').textContent).toBe('All changes saved.');
    expect(isDisabled(save())).toBe(true);
  });

  it('adds, removes and reorders rules within the slot limit', () => {
    harness([]);
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(cards()).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes.');
    // The new rule opens in edit mode with focus on its first control.
    expect(document.activeElement?.id).toBe('rule-3-kind');

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }));
    expect(summaries()[1]).toBe('If my HP is below 55% and Mend is ready, use Mend on myself.');
    // Focus follows the moved rule.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move rule 2 down');
    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    expect(summaries()[0]).toBe('If my HP is below 55% and Mend is ready, use Mend on myself.');
    expect(isDisabled(screen.getByRole('button', { name: 'Move rule 1 up' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Move rule 3 down' }))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(cards()).toHaveLength(6);
    const limit = screen.getByRole('button', { name: 'Rule limit reached (6)' });
    expect(isDisabled(limit)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 6' }));
    expect(cards()).toHaveLength(5);
    expect(isDisabled(screen.getByRole('button', { name: '+ Add rule' }))).toBe(false);
  });

  it('edits conditions and actions with closed-set pickers limited to the loadout', () => {
    harness([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit rule 2' }));
    const card = cards()[1];
    if (!card) throw new Error('missing card');
    const addCondition = within(card).getByRole('combobox', { name: 'Add condition to rule 2' });
    fireEvent.change(addCondition, { target: { value: 'enemiesAtLeast' } });
    fireEvent.change(within(card).getByLabelText('Enemies at least'), { target: { value: '3' } });

    const skill = within(card).getByLabelText('Skill');
    const offered = [...skill.querySelectorAll('option')].map((option) => option.value);
    expect(offered).toEqual(['skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend']);
    fireEvent.change(skill, { target: { value: 'skill:cleave' } });
    // Cleave hits every enemy: no target picker.
    expect(within(card).queryByLabelText('Target')).toBeNull();
    expect(summaries()[1]).toBe('If there are at least 3 enemies, use Cleave.');

    fireEvent.change(within(card).getByLabelText('Action'), { target: { value: 'consumable' } });
    expect(summaries()[1]).toBe('If there are at least 3 enemies, use Minor Healing Potion.');
    fireEvent.click(within(card).getByRole('button', { name: /Remove condition “Enemies at least”/ }));
    expect(summaries()[1]).toBe('Always use Minor Healing Potion.');
  });

  it('blocks saving invalid rules', () => {
    harness([], { automationRules: [{ when: {}, do: { useSkill: 'skill:rend' } }] });
    expect(screen.getByText(/Rend is not in your loadout/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(screen.getByRole('status').textContent).toBe('1 problem to fix before saving.');
    expect(isDisabled(save())).toBe(true);
  });

  it('saves with one command carrying a stable command_id and the exact rules, then shows the server state', async () => {
    const { requests } = harness([503, 'ok']);
    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    await act(async () => { fireEvent.click(save()); });

    expect(requests).toHaveLength(2);
    const [first, retry] = requests;
    expect(first?.method).toBe('PATCH');
    expect(first?.url).toBe(`/characters/${ACTOR}/configuration`);
    expect(first?.body.operation).toBe('character.configure');
    expect(retry?.body).toEqual(first?.body);
    expect(first?.body.payload).toEqual({ automationRules: [SAVED[1], SAVED[0]] });
    expect(Object.keys(first?.body.payload ?? {})).toEqual(['automationRules']);

    expect(screen.getByRole('status').textContent).toBe('All changes saved.');
    expect(summaries()[0]).toBe('Always use Basic Attack on the enemy with the lowest HP.');
  });

  it('retries an unconfirmed save with the same command_id', async () => {
    const { requests } = harness(['drop', 'drop', 'ok']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    await act(async () => { fireEvent.click(save()); });
    expect(screen.getByRole('alert').textContent).toContain('could not be confirmed');
    expect(save().textContent).toBe('Retry save');
    // Editing is locked so the retried payload always matches what is shown.
    expect(isDisabled(screen.getByRole('button', { name: 'Remove rule 1' }))).toBe(true);
    await act(async () => { fireEvent.click(save()); });
    expect(new Set(requests.map((r) => r.body.command_id)).size).toBe(1);
    expect(requests).toHaveLength(3);
    expect(cards()).toHaveLength(1);
  });

  it('shows server rejections', async () => {
    harness([400]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    await act(async () => { fireEvent.click(save()); });
    expect(screen.getByRole('alert').textContent).toContain('invalid_configuration');
    expect(save().textContent).toBe('Save rules');
    expect(cards()).toHaveLength(1);
  });

  it('fills presets and disables the ones whose skills are not equipped', () => {
    harness([]);
    const thornblade = screen.getByRole('button', { name: 'Use Thornblade' });
    expect(isDisabled(thornblade)).toBe(true);
    expect(screen.getByText('Needs Second Wind, Precise Strike, Rend in your loadout.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Use Bulwark' }));
    expect(cards()).toHaveLength(6);
    expect(summaries()[0]).toBe('If my HP is below 40% and I carry Minor Healing Potion, use Minor Healing Potion.');
    expect(summaries()[5]).toBe('Always use Basic Attack on the enemy with the lowest HP.');
    expect(isDisabled(save())).toBe(false);
    expect(PRESETS[0]?.rules).toHaveLength(6);
  });

  it('fills the Thornblade preset for a Thornblade loadout', () => {
    harness([], { skillLoadout: ['skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:cleave'], automationRules: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Use Thornblade' }));
    expect(summaries()[4]).toBe('If Rend is ready, use Rend on the enemy with the highest HP.');
    expect(isDisabled(screen.getByRole('button', { name: 'Use Bulwark' }))).toBe(true);
  });

  it('disables save while disconnected', () => {
    const { connect } = harness([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 2' }));
    expect(isDisabled(save())).toBe(false);
    connect(false);
    expect(isDisabled(save())).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Waiting for the connection…');
    connect(true);
    expect(isDisabled(save())).toBe(false);
  });
});
