import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { LiveState } from '../live/state.ts';
import { INITIAL_LIVE_STATE } from '../live/state.ts';
import { LiveClient } from '../live/client.ts';
import type { WebSocketLike } from '../live/client.ts';
import { App } from './App.tsx';
import type { LiveConnection } from './services.ts';

const CHARACTER: CharacterDto = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 120,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0,
  skillLoadout: ['skill:shield_bash', 'skill:guard'], automationRules: [], activityState: 'none', activityId: null, version: 1,
};

class AppSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  receive(frame: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  authenticate() { this.readyState = 1; this.receive({ type: 'authenticated', accountId: '44444444-4444-4444-8444-444444444444' }); }
}

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
    expect(await screen.findByText('Always use Basic Attack on the enemy with the lowest HP.')).toBeDefined();
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

  it('discovers and resumes an existing live host when the initial character snapshot says none', async () => {
    const instanceId = '33333333-3333-4333-8333-333333333333';
    const actorId = CHARACTER.actorId;
    const paths: string[] = [];
    const fetch: FetchLike = async (input) => {
      paths.push(input);
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([CHARACTER]);
      if (input === `/live/current/${actorId}`) return Response.json({ current: { instanceId, actorId,
        view: { phase: 'exploring', heroes: [], groups: [] }, participants: [{ actorId, status: 'connected' }] } });
      if (input.endsWith('/world')) return Response.json({
        hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } }, areas: [], routes: [],
      });
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    render(<App services={{ api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } }} />);
    fireEvent.click(await screen.findByRole('link', { name: 'World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    const resume = await screen.findByRole('link', { name: 'Resume live adventure' });
    expect(screen.getByText('Live adventure', { selector: '.chip' })).toBeDefined();
    expect(paths).toContain(`/live/current/${actorId}`);
    fireEvent.click(resume);
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Live adventure' })).toBeDefined();
    await waitFor(() => expect(paths.filter((path) => path === `/live/current/${actorId}`).length).toBeGreaterThanOrEqual(2));
    expect(paths).not.toContain('/live/start');
  });

  it('hands the whole viewport to a live adventure and gives the header and tab bar back on the map (#176)', async () => {
    const instanceId = '33333333-3333-4333-8333-333333333333';
    const actorId = CHARACTER.actorId;
    const fetch: FetchLike = async (input) => {
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([CHARACTER]);
      if (input === `/live/current/${actorId}`) return Response.json({ current: { instanceId, actorId,
        view: { phase: 'exploring', area: 'area.region_1.name', location: 'loc:region_1.portal_clearing', heroes: [], groups: [] }, participants: [{ actorId, status: 'connected' }] } });
      if (input.endsWith('/world')) return Response.json({ hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } }, areas: [], routes: [] });
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    const hidden = readFileSync('games/rpg/apps/web/src/live/frame/live-frame.css', 'utf8');
    for (const chrome of ['.header', '.tabbar', '.banner', '.debug-bar']) expect(hidden).toContain(`html.live-frame-active ${chrome}`);
    expect(hidden).toMatch(/html\.live-frame-active, html\.live-frame-active body \{[^}]*overflow: hidden/);
    render(<App services={{ api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } }} />);
    fireEvent.click(await screen.findByRole('link', { name: 'World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('link', { name: 'Resume live adventure' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(document.querySelector('.live-frame')).not.toBeNull());
    expect(document.documentElement.classList.contains('live-frame-active')).toBe(true);
    // The frame's breadcrumb row is the way back; the adventure keeps running while the map is shown.
    fireEvent.click(screen.getByRole('link', { name: '← World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(document.documentElement.classList.contains('live-frame-active')).toBe(false));
    expect(await screen.findByRole('link', { name: 'Resume live adventure' })).toBeDefined();
  });

  it('refreshes activity after starting and resumes the same instance from the map', async () => {
    const actorId = CHARACTER.actorId;
    const instanceId = '44444444-4444-4444-8444-444444444444';
    const paths: string[] = [];
    let started = false;
    const current = () => started ? { current: { instanceId, actorId,
      view: { phase: 'exploring', heroes: [], groups: [] }, participants: [{ actorId, status: 'connected' }] } } : { current: null };
    const world = {
      hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
      areas: [{ id: 'area:region_1', label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
        completion: { discovered: 3, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false, bosses: [] } },
        danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: [] }, actions: { enterLive: true, startIdle: true } }],
      routes: [{ id: 'route:sanctuary-region1', from: 'area:sanctuary', to: 'area:region_1' }],
    };
    const fetch: FetchLike = async (input, init) => {
      paths.push(input);
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([CHARACTER]);
      if (input === `/characters/${actorId}`) return Response.json(started ? { ...CHARACTER, activityState: 'live', activityId: instanceId } : CHARACTER);
      if (input === `/live/current/${actorId}`) return Response.json(current());
      if (input === `/live/options/${actorId}`) return Response.json({ actorId, areas: [{ id: 'area:region_1', label: 'The Verdant Hollow', startLocationId: 'loc:portal' }], supplies: [] });
      if (input === '/live/start' && init?.method === 'POST') { started = true; return Response.json({ instanceId }); }
      if (input.endsWith('/world')) return Response.json(world);
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    const live = fakeLive();
    render(<App services={{ api: new ApiClient(fetch), live, storage: { getItem: () => null, setItem: () => {} } }} />);
    fireEvent.click(await screen.findByRole('link', { name: 'World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('button', { name: /Verdant Hollow.*Required locations 3 \/ 6/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Live adventure' })).toBeDefined();
    act(() => live.set({ status: 'open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(started).toBe(true));
    fireEvent.click(screen.getByRole('link', { name: '← World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    const resume = await screen.findByRole('link', { name: /live adventure/ });
    expect(paths.filter((path) => path === '/live/start')).toHaveLength(1);
    fireEvent.click(resume);
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Live adventure' })).toBeDefined();
    expect(paths.filter((path) => path === '/live/start')).toHaveLength(1);
  });

  it('clears live activity after the server confirms return to Sanctuary', async () => {
    const actorId = CHARACTER.actorId;
    const instanceId = '55555555-5555-4555-8555-555555555555';
    const paths: string[] = [];
    const sockets: AppSocket[] = [];
    let started = false;
    let returned = false;
    const view = { phase: 'exploring', area: 'area:region_1', location: 'loc:region_1.portal_clearing', heroes: [], groups: [],
      exits: [], hotspots: [], resources: [], canReturn: true, runBag: [] };
    const current = () => started && !returned ? { current: { instanceId, actorId, view,
      participants: [{ actorId, status: 'connected' }] } } : { current: null };
    const world = { hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
      areas: [{ id: 'area:region_1', label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
        completion: { discovered: 3, required: 6, completed: false, mandatoryBosses: { required: 0, defeated: 0, complete: true, bosses: [] } },
        danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: [] }, actions: { enterLive: true, startIdle: true } }],
      routes: [{ id: 'route:sanctuary-region1', from: 'area:sanctuary', to: 'area:region_1' }] };
    const fetch: FetchLike = async (input, init) => {
      paths.push(input);
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([CHARACTER]);
      if (input === `/characters/${actorId}`) return Response.json(returned ? CHARACTER : { ...CHARACTER, activityState: started ? 'live' : 'none', activityId: started ? instanceId : null });
      if (input === `/live/current/${actorId}`) return Response.json(current());
      if (input === `/live/options/${actorId}`) return Response.json({ actorId, areas: [{ id: 'area:region_1', label: 'The Verdant Hollow', startLocationId: 'loc:region_1.portal_clearing' }], supplies: [] });
      if (input === '/live/start' && init?.method === 'POST') { started = true; return Response.json({ instanceId }); }
      if (input.endsWith('/world')) return Response.json(world);
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    const live = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new AppSocket(); sockets.push(socket); return socket; },
      backoff: () => 1000, pingIntervalMs: 60_000 });
    render(<App services={{ api: new ApiClient(fetch), live, storage: { getItem: () => null, setItem: () => {} } }} />);
    fireEvent.click(await screen.findByRole('link', { name: 'World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('button', { name: /Verdant Hollow.*Required locations 3 \/ 6/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await screen.findByRole('heading', { name: 'Live adventure' });
    await waitFor(() => expect(sockets[0]).toBeDefined());
    const socket = sockets[0];
    if (!socket) throw new Error('live socket was not created');
    act(() => { socket.open(); socket.authenticate(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(started).toBe(true));
    await waitFor(() => expect(socket.sent.some((sent) => sent.includes('live.attach'))).toBe(true));
    act(() => {
      socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 0, view, participants: [{ actorId, status: 'connected' }] });
      socket.receive({ type: 'live.attached', instanceId, mode: 'snapshot' });
    });
    fireEvent.click(screen.getByRole('link', { name: '← World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('link', { name: 'Resume live adventure' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('button', { name: 'Return to Sanctuary' })).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'Return to Sanctuary' }));
    await waitFor(() => expect(socket.sent.some((sent) => sent.includes('returnToSanctuary'))).toBe(true));
    const commandFrame = socket.sent.map((sent) => { try { return JSON.parse(sent) as { command?: { commandId?: string; command?: { type?: string } } }; } catch { return {}; } })
      .find((frame) => frame.command?.command?.type === 'returnToSanctuary')?.command;
    if (!commandFrame?.commandId) throw new Error('return command ID missing');
    returned = true;
    act(() => {
      socket.receive({ type: 'live.ack', instanceId, commandId: commandFrame.commandId, status: 'applied', duplicate: false });
      socket.receive({ type: 'live.closed', instanceId, outcome: 'returned', result: { area: 'area:sanctuary' } });
    });
    expect(await screen.findByRole('heading', { name: 'Adventure ended: returned.' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('No expedition')).toBeDefined());
    fireEvent.click(screen.getByRole('link', { name: '← World map' }));
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('link', { name: 'Open live adventure' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Resume live adventure' })).toBeNull();
    expect(paths.filter((path) => path === '/live/start')).toHaveLength(1);
    live.stop();
  });

  it('enters Region 2 live from the map after returning from Region 1 without the stale "adventure ended" screen (#157)', async () => {
    const actorId = CHARACTER.actorId;
    const firstInstance = '66666666-6666-4666-8666-666666666666';
    const secondInstance = '77777777-7777-4777-8777-777777777777';
    const sockets: AppSocket[] = [];
    const starts: Array<{ areaId: string }> = [];
    let activeId: string | null = null;
    let activeArea = 'area:region_1';
    const viewOf = (area: string, location: string) => ({ phase: 'exploring', area, location, heroes: [], groups: [], exits: [], hotspots: [],
      resources: [], canReturn: true, runBag: [] });
    const current = () => activeId ? { current: { instanceId: activeId, actorId,
      view: viewOf(activeArea, activeArea === 'area:region_2' ? 'loc:region_2.fracture_landing' : 'loc:region_1.portal_clearing'),
      participants: [{ actorId, status: 'connected' }] } } : { current: null };
    const mapArea = (id: string, label: string, y: number) => ({ id, label, visibility: 'known', position: { x: 0, y }, lockedReasons: [],
      completion: { discovered: 3, required: 6, completed: id === 'area:region_1', mandatoryBosses: { required: 0, defeated: 0, complete: true, bosses: [] } },
      danger: { status: 'known', minLevel: 1, maxLevel: 8 }, idle: { unlocked: true, activities: [] }, actions: { enterLive: true, startIdle: true } });
    const world = { hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
      areas: [mapArea('area:region_1', 'The Verdant Hollow', 100), mapArea('area:region_2', 'The Resonant Fracture', 200)],
      routes: [{ id: 'route:sanctuary-region1', from: 'area:sanctuary', to: 'area:region_1' }, { id: 'route:sanctuary_to_region_2', from: 'area:sanctuary', to: 'area:region_2' }] };
    const fetch: FetchLike = async (input, init) => {
      if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
      if (input === '/characters') return Response.json([CHARACTER]);
      if (input === `/characters/${actorId}`) return Response.json({ ...CHARACTER, activityState: activeId ? 'live' : 'none', activityId: activeId });
      if (input === `/live/current/${actorId}`) return Response.json(current());
      if (input === `/live/options/${actorId}`) return Response.json({ actorId, supplies: [], areas: [
        { id: 'area:region_1', label: 'The Verdant Hollow', startLocationId: 'loc:region_1.portal_clearing' },
        { id: 'area:region_2', label: 'The Resonant Fracture', startLocationId: 'loc:region_2.fracture_landing' }] });
      if (input === '/live/start' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { areaId: string };
        starts.push(body);
        activeArea = body.areaId; activeId = starts.length === 1 ? firstInstance : secondInstance;
        return Response.json({ instanceId: activeId });
      }
      if (input.endsWith('/world')) return Response.json(world);
      return Response.json({ error: 'not_found' }, { status: 404 });
    };
    const live = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new AppSocket(); sockets.push(socket); return socket; },
      backoff: () => 1000, pingIntervalMs: 60_000 });
    render(<App services={{ api: new ApiClient(fetch), live, storage: { getItem: () => null, setItem: () => {} } }} />);
    const hashChanged = () => act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    fireEvent.click(await screen.findByRole('link', { name: 'World map' })); hashChanged();
    fireEvent.click(await screen.findByRole('button', { name: /Verdant Hollow/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' })); hashChanged();
    await screen.findByRole('heading', { name: 'Live adventure' });
    await waitFor(() => expect(sockets[0]).toBeDefined());
    const socket = sockets[0] as AppSocket;
    act(() => { socket.open(); socket.authenticate(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(starts).toHaveLength(1));
    await waitFor(() => expect(socket.sent.some((sent) => sent.includes('live.attach'))).toBe(true));
    act(() => {
      socket.receive({ type: 'live.snapshot', instanceId: firstInstance, epoch: 1, seq: 0, view: viewOf('area:region_1', 'loc:region_1.portal_clearing'),
        participants: [{ actorId, status: 'connected' }] });
      socket.receive({ type: 'live.attached', instanceId: firstInstance, mode: 'snapshot' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Return to Sanctuary' }));
    await waitFor(() => expect(socket.sent.some((sent) => sent.includes('returnToSanctuary'))).toBe(true));
    const commandFrame = socket.sent.map((sent) => { try { return JSON.parse(sent) as { command?: { commandId?: string; command?: { type?: string } } }; } catch { return {}; } })
      .find((frame) => frame.command?.command?.type === 'returnToSanctuary')?.command;
    activeId = null;
    act(() => {
      socket.receive({ type: 'live.ack', instanceId: firstInstance, commandId: commandFrame?.commandId, status: 'applied', duplicate: false });
      socket.receive({ type: 'live.closed', instanceId: firstInstance, outcome: 'returned', result: { area: 'area:sanctuary' } });
    });
    expect(await screen.findByRole('heading', { name: 'Adventure ended: returned.' })).toBeDefined();

    // The player leaves through the back link (not "New adventure") and enters Region 2 from the map.
    fireEvent.click(screen.getByRole('link', { name: '← World map' })); hashChanged();
    fireEvent.click(await screen.findByRole('button', { name: /Resonant Fracture/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' })); hashChanged();
    expect(window.location.hash).toBe('#/world/live/area%3Aregion_2');
    expect(screen.queryByRole('heading', { name: 'Adventure ended: returned.' })).toBeNull();
    expect((await screen.findByLabelText('Area') as HTMLSelectElement).value).toBe('area:region_2');
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(starts.map((entry) => entry.areaId)).toEqual(['area:region_1', 'area:region_2']));
    await waitFor(() => expect(socket.sent.some((sent) => sent.includes(secondInstance))).toBe(true));
    act(() => {
      socket.receive({ type: 'live.snapshot', instanceId: secondInstance, epoch: 1, seq: 0, view: viewOf('area:region_2', 'loc:region_2.fracture_landing'),
        participants: [{ actorId, status: 'connected' }] });
      socket.receive({ type: 'live.attached', instanceId: secondInstance, mode: 'snapshot' });
    });
    expect(await screen.findByRole('button', { name: 'Return to Sanctuary' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Adventure ended/ })).toBeNull();
    live.stop();
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
