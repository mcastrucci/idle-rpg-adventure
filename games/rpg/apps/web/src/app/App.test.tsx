import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { LiveState } from '../live/state.ts';
import { INITIAL_LIVE_STATE } from '../live/state.ts';
import { App } from './App.tsx';
import type { LiveConnection } from './services.ts';

const CHARACTER: CharacterDto = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 120,
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

function services(characters: CharacterDto[], recordPath: (path: string) => void = () => {}) {
  const world = {
    hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
    areas: [{ id: 'area:region_1', label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
      completion: { discovered: 3, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false, bosses: [{ label: 'Mandatory boss', defeated: false }] } },
      danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: ['idle:region_1.hunt'] }, actions: { enterLive: true, startIdle: true } }],
    routes: [{ id: 'route:sanctuary-region1', from: 'area:sanctuary', to: 'area:region_1' }],
  };
  const fetch: FetchLike = async (input) => {
    recordPath(input);
    if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
    if (input === '/characters') return Response.json(characters);
    if (input.endsWith('/world')) return Response.json(world);
    if (input.startsWith('/live/current/')) return Response.json({ current: null });
    if (input.startsWith('/live/options/')) return Response.json({ actorId: input.split('/').at(-1),
      areas: [{ id: 'area:region_1', label: 'The Verdant Hollow', startLocationId: 'loc:region_1.portal_clearing' }], supplies: [] });
    if (input.startsWith('/characters/') && input.endsWith('/expedition-options')) return Response.json({
      actorId: input.split('/')[2], areas: [{ areaId: 'area:region_1', kind: 'explorable',
        activities: [{ activityId: 'idle:region_1.hunt', simulatorId: 'rpg.hunt', available: true }] }],
      durationsMin: [30], paceBp: { min: 10_000, max: 10_000, default: 10_000 }, consumables: [],
    });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return { api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } };
}

describe('App shell', () => {
  beforeEach(() => { window.location.hash = ''; });
  afterEach(() => { cleanup(); });

  it('renders the header and navigates between the Sanctuary tabs', async () => {
    const deps = services([CHARACTER]);
    const { container } = render(<App services={deps} />);
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
      if (label === 'Inventory') {
        const worldTab = container.querySelector('.world-tab');
        expect(worldTab).not.toBeNull();
        expect(worldTab?.hasAttribute('hidden')).toBe(true);
        expect(worldTab?.hasAttribute('inert')).toBe(true);
      }
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

  it('selecting a map area has no side effect; explicit live and idle actions route with that area', async () => {
    const paths: string[] = [];
    render(<App services={services([CHARACTER], (path) => paths.push(path))} />);
    fireEvent.click(await screen.findByRole('link', { name: 'World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    const portal = await screen.findByRole('button', { name: /Verdant Hollow.*Required locations 3 \/ 6/ });
    fireEvent.click(portal);
    expect(window.location.hash).toBe('#/world');
    expect(paths).not.toContain('/live/start');
    expect(await screen.findByText('Required locations: 3 / 6')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Live adventure' })).toBeDefined();
    expect(window.location.hash).toBe('#/world/live/area%3Aregion_1');
    expect((await screen.findByLabelText('Area') as HTMLSelectElement).value).toBe('area:region_1');
    fireEvent.click(screen.getByRole('link', { name: '← World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('button', { name: /Verdant Hollow.*Required locations 3 \/ 6/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start expedition' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(window.location.hash).toBe('#/expeditions/area%3Aregion_1');
    expect(await screen.findByRole('heading', { name: 'Expeditions' })).toBeDefined();
    expect((await screen.findByLabelText('Conquered area') as HTMLSelectElement).value).toBe('area:region_1');
  });

  it('loads the durable death summary with the character after opening the app', async () => {
    const actorId = '22222222-2222-4222-8222-222222222222';
    const paths: string[] = [];
    const death = {
      deathId: '33333333-3333-4333-8333-333333333333', occurredAt: 1_800_000_000_000, areaId: 'area:ruins', locationId: 'location:crypt',
      xpBefore: { level: 3, xpIntoLevel: 90, totalXp: 290 }, xpLost: 10,
      xpAfter: { level: 3, xpIntoLevel: 80, totalXp: 280 }, causes: [{ sourceId: 'enemy:wraith', label: 'Wraith', damage: 24 }],
      corpse: { id: '33333333-3333-4333-8333-333333333333', status: 'active', expiresAt: 1_800_086_400_000, contents: { stacks: [], gold: 0, uniques: [] } },
    };
    const fetch: FetchLike = async (input) => {
      paths.push(input);
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([{ ...CHARACTER, actorId }]);
      if (input === `/characters/${actorId}/live-death`) return Response.json({ death });
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    const { container } = render(<App services={{ api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } }} />);
    await waitFor(() => expect(container.querySelector('.death-panel__causes li')?.textContent).toContain('24 damage'));
    expect(paths).toContain(`/characters/${actorId}/live-death`);
    expect(screen.getAllByText('The corpse held no loot.').length).toBeGreaterThan(0);
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

  it('settles and announces completion while another tab is open', async () => {
    const actorId = '22222222-2222-4222-8222-222222222222';
    const active = { ...CHARACTER, actorId, activityState: 'expedition' as const, activityId: '11111111-1111-4111-8111-111111111111' };
    const completed = { ...active, activityState: 'none' as const, activityId: null };
    const paths: string[] = [];
    const fetch: FetchLike = async (input) => {
      paths.push(input);
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([active]);
      if (input === `/expeditions/${active.activityId}`) return Response.json({
        id: active.activityId, actorId, state: 'completed', areaId: 'area:ruins', activityId: 'activity:ruins',
        startsAtMs: 1, plannedEndsAtMs: 2, endsAtMs: 2, outcome: 'victory', progress: { revealed: 1 }, segments: [], revealedDeltas: [], summary: { segments: 1, encounters: 1, victories: 1, outcome: 'victory' },
      });
      if (input === `/characters/${actorId}`) return Response.json(completed);
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    render(<App services={{ api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } }} />);
    await waitFor(() => expect(paths).toContain(`/expeditions/${active.activityId}`));
    await waitFor(() => expect(paths).toContain(`/characters/${actorId}`));
    expect(await screen.findByRole('button', { name: 'Dismiss expedition update' })).toBeDefined();
    expect(screen.getByText('Expedition completed')).toBeDefined();
    expect(screen.getByText('No expedition')).toBeDefined();
  });
});
