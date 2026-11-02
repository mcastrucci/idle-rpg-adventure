import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { LiveState } from '../live/state.ts';
import { INITIAL_LIVE_STATE } from '../live/state.ts';
import { App } from './App.tsx';
import type { LiveConnection } from './services.ts';

const CHARACTER: CharacterDto = {
  actorId: 'a', accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 120,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0,
  skillLoadout: ['skill:shield_bash', 'skill:guard'], automationRules: [], activityState: 'none', activityId: null, version: 1,
};

/** Controllable stand-in for LiveClient: the test decides when the socket is open. */
function fakeLive(): LiveConnection & { set(state: Partial<LiveState>): void; starts: number } {
  const listeners = new Set<(state: LiveState) => void>();
  const live = {
    state: INITIAL_LIVE_STATE,
    starts: 0,
    subscribe(listener: (state: LiveState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { live.starts++; live.set({ status: 'connecting' }); },
    stop() {},
    online() {},
    offline() {},
    waitUntilOpen: () => Promise.resolve(),
    set(next: Partial<LiveState>) { live.state = { ...live.state, ...next }; for (const listener of listeners) listener(live.state); },
  };
  return live;
}

function services(characters: CharacterDto[]) {
  const fetch: FetchLike = async (input) => {
    if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
    if (input === '/characters') return Response.json(characters);
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return { api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } };
}

describe('App shell', () => {
  beforeEach(() => { window.location.hash = ''; });
  afterEach(() => { cleanup(); });

  it('renders the header and navigates between the Sanctuary tabs', async () => {
    const deps = services([CHARACTER]);
    render(<App services={deps} />);
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeDefined();
    expect(screen.getByText('Lv 3')).toBeDefined();
    expect(screen.getByText('No expedition')).toBeDefined();
    expect(deps.live.starts).toBe(1);

    const nav = screen.getByRole('navigation', { name: 'Sanctuary' });
    const links = nav.querySelectorAll('a');
    expect([...links].map((link) => link.textContent)).toEqual(['Character', 'Inventory', 'World map', 'Expeditions']);
    expect(screen.getByRole('link', { name: 'Character' }).getAttribute('aria-current')).toBe('page');

    for (const [label, heading] of [['Inventory', 'Inventory'], ['World map', 'World map'], ['Expeditions', 'Expeditions']] as const) {
      fireEvent.click(screen.getByRole('link', { name: label }));
      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(await screen.findByRole('heading', { name: heading })).toBeDefined();
      expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page');
    }
    fireEvent.click(screen.getByRole('link', { name: 'Character' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeDefined();
  });

  it('reaches the automation rules editor from the Character tab', async () => {
    const rules = [{ when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } }];
    render(<App services={services([{ ...CHARACTER, automationRules: rules }])} />);
    expect(await screen.findByText('Always use Basic attack on the enemy with the lowest HP.')).toBeDefined();
    const edit = screen.getByRole('link', { name: 'Edit automation rules' });
    expect(edit.getAttribute('href')).toBe('#/character/rules');
    act(() => { window.location.hash = '/character/rules'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Automation rules' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Character' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Save rules' }).hasAttribute('disabled')).toBe(true);
  });

  it('opens a deep-linked tab', async () => {
    window.location.hash = '/world';
    render(<App services={services([CHARACTER])} />);
    expect(await screen.findByRole('heading', { name: 'World map' })).toBeDefined();
  });

  it('shows the connection banner and disables commands while disconnected', async () => {
    const deps = services([]);
    render(<App services={deps} />);
    expect(await screen.findByRole('heading', { name: 'Create your character' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    const create = screen.getByRole('button', { name: 'Create' });
    expect(screen.getByRole('status').textContent).toContain('Connecting');
    expect(create.hasAttribute('disabled')).toBe(true);

    act(() => deps.live.set({ status: 'open' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(create.hasAttribute('disabled')).toBe(false);

    act(() => deps.live.set({ status: 'reconnecting', attempt: 1, retryInMs: 2000, lastCloseCode: 1006 }));
    expect(screen.getByRole('status').textContent).toContain('Reconnecting in 2s');
    expect(create.hasAttribute('disabled')).toBe(true);
  });
});
