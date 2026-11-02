import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_STAT_FORMULAS, deriveStats } from '@rpg/rpg-stats';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { sendCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { AttributeKey, CharacterDto } from '../api/types.ts';
import { formatBp } from '../rules/describe.ts';
import { CharacterScreen } from './CharacterScreen.tsx';

const ACTOR = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const BULWARK_ATTRIBUTES = { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 } as const;
const THORNBLADE_ATTRIBUTES = { STR: 11, AGI: 9, INT: 2, VIT: 5, SPI: 3 } as const;
/** The server's provisional starter rules (mend, guard, cleave, bash, basic attack). */
const STARTER_RULES = [
  { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
  { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
  { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
  { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
  { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
];
const CHARACTER: CharacterDto = {
  actorId: ACTOR, accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 1, xp: 40,
  attributes: BULWARK_ATTRIBUTES, unspentPoints: 0,
  skillLoadout: ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
  automationRules: STARTER_RULES, activityState: 'none', activityId: null, version: 3,
};
const noWait = { sleep: () => Promise.resolve(), backoff: () => 0 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Envelope { command_id: string; operation: string; payload: Record<string, unknown> }

/**
 * Fake `PATCH /characters/:id/configuration`: 'ok' applies the configuration like the server (loadout/rules replace,
 * `allocate` adds), a number answers that error status, 'drop' loses the network.
 */
function harness(initial: Partial<CharacterDto> = {}, script: ('ok' | 'drop' | number)[] = []) {
  const requests: { url: string; method: string; body: Envelope }[] = [];
  let current: CharacterDto = { ...CHARACTER, ...initial };
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Envelope;
    requests.push({ url, method: String(init?.method), body });
    const step = script.shift() ?? 'ok';
    if (step === 'drop') throw new TypeError('Failed to fetch');
    if (typeof step === 'number') return json(step, { error: step === 409 ? 'busy' : 'invalid_configuration' });
    const { skillLoadout, automationRules, allocate } = body.payload as Partial<CharacterDto> & { allocate?: Partial<Record<AttributeKey, number>> };
    const attributes = { ...current.attributes };
    let spent = 0;
    for (const [key, points] of Object.entries(allocate ?? {}) as [AttributeKey, number][]) { attributes[key] += points; spent += points; }
    current = {
      ...current, attributes, unspentPoints: current.unspentPoints - spent,
      skillLoadout: skillLoadout ?? current.skillLoadout, automationRules: automationRules ?? current.automationRules, version: current.version + 1,
    };
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
    return <CharacterScreen character={character} canCommand={connected} runCharacterCommand={run} newCommandId={() => COMMAND_ID} />;
  }
  render(<Host />);
  return { requests, connect: (value: boolean) => act(() => setConnected(value)) };
}

const slot = (n: number) => screen.getByLabelText(`Slot ${n}`) as HTMLSelectElement;
const slotValues = () => [1, 2, 3, 4].map((n) => slot(n).value);
const saveButton = () => screen.getByRole('button', { name: /^(Save loadout|Retry save|Saving…)$/ });
const isDisabled = (element: HTMLElement) => element.hasAttribute('disabled');
const choose = (n: number, value: string) => fireEvent.change(slot(n), { target: { value } });
const flush = () => act(async () => { await Promise.resolve(); });

describe('CharacterScreen', () => {
  afterEach(() => { cleanup(); });

  it.each([
    ['Bulwark', BULWARK_ATTRIBUTES],
    ['Thornblade', THORNBLADE_ATTRIBUTES],
  ] as const)('renders the %s reference build stats exactly as rpg-stats derives them', (_name, attributes) => {
    for (const level of [1, 3]) {
      harness({ attributes, level, xp: 0 });
      const expected = deriveStats({ level, attributes, equipment: [] }, DEFAULT_STAT_FORMULAS);
      const shown = (key: string) => document.querySelector(`[data-stat="${key}"] .derived-stat__value`)?.textContent;
      expect(shown('maxHp')).toBe(String(expected.maxHp));
      expect(shown('physicalPower')).toBe(String(expected.powerBySchool.physical));
      expect(shown('magicPower')).toBe(String(expected.powerBySchool.magic));
      expect(shown('armor')).toBe(String(expected.armor));
      expect(shown('resist')).toBe(String(expected.resist));
      expect(shown('critBp')).toBe(formatBp(expected.critBp));
      expect(shown('actionIntervalTicks')).toBe(`${expected.actionIntervalTicks} ticks`);
      expect(shown('healPower')).toBe(String(expected.healPower));
      for (const [key, value] of Object.entries(attributes)) expect(screen.getByRole('listitem', { name: `${key} ${value}` })).toBeDefined();
      cleanup();
    }
  });

  it('shows level and XP progress from the XP curve', () => {
    harness({ level: 2, xp: 125 });
    const bar = screen.getByRole('progressbar', { name: 'XP to next level' });
    expect(bar.getAttribute('aria-valuenow')).toBe('5000');
    expect(screen.getByText('Level 2 · 125 / 250 XP')).toBeDefined();
  });

  it('edits the loadout and saves it with one command carrying the exact payload, then shows the server state', async () => {
    const rules = [{ when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } }];
    const { requests } = harness({ automationRules: rules });
    expect(isDisabled(saveButton())).toBe(true);
    choose(1, 'skill:mend');
    expect(slotValues()).toEqual(['skill:mend', 'skill:guard', 'skill:cleave', 'skill:shield_bash']);
    choose(3, '');
    expect(screen.getByText('Unsaved changes.')).toBeDefined();
    fireEvent.click(saveButton());
    await flush();
    expect(requests).toEqual([{
      url: `/characters/${ACTOR}/configuration`, method: 'PATCH',
      body: { command_id: COMMAND_ID, operation: 'character.configure', payload: { skillLoadout: ['skill:mend', 'skill:guard', 'skill:shield_bash'] } },
    }]);
    expect(await screen.findByText('Loadout saved.', { selector: '.savebar__status' })).toBeDefined();
    expect(slotValues()).toEqual(['skill:mend', 'skill:guard', 'skill:shield_bash', '']);
    expect(isDisabled(saveButton())).toBe(true);
  });

  it('retries an unconfirmed save with the same command_id', async () => {
    const rules = [{ when: {}, do: { useSkill: 'skill:basic_attack' } }];
    const { requests } = harness({ automationRules: rules }, ['drop', 'drop', 'ok']);
    choose(4, '');
    fireEvent.click(saveButton());
    expect(await screen.findByRole('button', { name: 'Retry save' })).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('never applied twice');
    expect(isDisabled(slot(1))).toBe(true);
    fireEvent.click(saveButton());
    await flush();
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.body.command_id))).toEqual(new Set([COMMAND_ID]));
    expect(requests.every((request) => JSON.stringify(request.body) === JSON.stringify(requests[0]?.body))).toBe(true);
    expect(await screen.findByText('Loadout saved.', { selector: '.savebar__status' })).toBeDefined();
  });

  it('warns when saved rules use a removed skill and offers the rules editor or removing those rules', async () => {
    const { requests } = harness();
    choose(4, '');
    const warning = screen.getByRole('group', { name: /1 automation rule uses a skill this loadout removes/ });
    expect(within(warning).getByText(/Rule 2: If my HP is below 55% and Mend is ready, use Mend on myself\./)).toBeDefined();
    expect(within(warning).getByRole('link', { name: 'Edit automation rules' }).getAttribute('href')).toBe('#/character/rules');
    expect(isDisabled(saveButton())).toBe(true);
    expect(requests).toHaveLength(0);

    fireEvent.click(within(warning).getByRole('button', { name: 'Save and remove 1 rule' }));
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.payload).toEqual({
      skillLoadout: ['skill:shield_bash', 'skill:guard', 'skill:cleave'],
      automationRules: [STARTER_RULES[0], STARTER_RULES[2], STARTER_RULES[3], STARTER_RULES[4]],
    });
    expect(screen.queryByRole('group', { name: /automation rule/ })).toBeNull();
  });

  it('applies build presets to the draft and disables presets with locked skills', async () => {
    const { requests } = harness({ skillLoadout: ['skill:guard', 'skill:cleave'], automationRules: [] });
    const thornblade = screen.getByRole('button', { name: 'Use Thornblade' });
    expect(isDisabled(thornblade)).toBe(true);
    expect(screen.getByText('Precise strike, Rend, Second wind are not unlocked yet.')).toBeDefined();
    const lockedOption = within(slot(1)).getByRole('option', { name: 'Rend (locked)' }) as HTMLOptionElement;
    expect(lockedOption.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Use Bulwark' }));
    expect(slotValues()).toEqual(['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend']);
    fireEvent.click(saveButton());
    await flush();
    expect(requests.map((request) => request.body.payload)).toEqual([{ skillLoadout: ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'] }]);
  });

  it('disables saving while disconnected and editing outside the Sanctuary', () => {
    const { connect } = harness({ automationRules: [] });
    choose(1, '');
    expect(isDisabled(saveButton())).toBe(false);
    connect(false);
    expect(isDisabled(saveButton())).toBe(true);
    expect(screen.getByText('Waiting for the connection…')).toBeDefined();
    connect(true);
    expect(isDisabled(saveButton())).toBe(false);
    cleanup();

    harness({ activityState: 'expedition', activityId: '22222222-2222-4222-8222-222222222222' });
    expect(isDisabled(slot(1))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Use Bulwark' }))).toBe(true);
    expect(isDisabled(saveButton())).toBe(true);
    expect(screen.getByText(/changes wait until the character returns to the Sanctuary/)).toBeDefined();
  });

  it('shows the server rejection for a loadout', async () => {
    harness({ automationRules: [] }, [409]);
    choose(2, '');
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('only possible while the character is in the Sanctuary');
    expect(slotValues()).toEqual(['skill:shield_bash', '', 'skill:cleave', 'skill:mend']);
  });

  it('spends earned points with an additive allocation and previews the stat change', async () => {
    const { requests } = harness({ unspentPoints: 2 });
    expect(screen.queryByRole('button', { name: 'Use a respec' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a point to VIT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a point to VIT' }));
    expect(isDisabled(screen.getByRole('button', { name: 'Add a point to STR' }))).toBe(true);
    const maxHp = document.querySelector('[data-stat="maxHp"]');
    expect(maxHp?.querySelector('.derived-stat__value')?.textContent).toBe(String(50 + 8 * 12));
    expect(maxHp?.querySelector('.delta')?.textContent).toBe(' +16');
    fireEvent.click(screen.getByRole('button', { name: 'Spend 2 points' }));
    await flush();
    expect(requests.map((request) => request.body.payload)).toEqual([{ allocate: { VIT: 2 } }]);
    expect(await screen.findByRole('listitem', { name: 'VIT 12' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Add a point/ })).toBeNull();
  });
});
