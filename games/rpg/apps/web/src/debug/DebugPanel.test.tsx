import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app/App.tsx';
import type { LiveConnection } from '../app/services.ts';
import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { LiveServerFrame } from '@rpg/protocol';
import { INITIAL_LIVE_STATE } from '../live/state.ts';
import type { LiveState } from '../live/state.ts';
import { setLocale } from '../i18n/index.ts';

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHARACTER: CharacterDto = {
  actorId: ACTOR, accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 120,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0,
  skillLoadout: [], automationRules: [], activityState: 'none', activityId: null, version: 1,
};
const CLOCK = { nowMs: 1_700_000_000_000, offsetMs: 3_600_000, maxAdvanceMs: 86_400_000, maxOffsetMs: 2_592_000_000 };
const WORLD = {
  hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } },
  areas: [{ id: 'area:region_1', label: 'area.region_1.name', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
    completion: { discovered: 3, required: 6, completed: false, mandatoryBosses: { required: 1, defeated: 0, complete: false, bosses: [{ label: 'Boss', defeated: false }] } },
    danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: [] }, actions: { enterLive: true, startIdle: true } }],
  routes: [],
};
const ATTRIBUTES = CHARACTER.attributes;
const INVENTORY = {
  actorId: ACTOR, holdings: [], actorVersion: 1, activityState: 'none', level: 3, attributes: ATTRIBUTES, completedAreas: [],
  catalog: { contentHash: 'a'.repeat(64), items: [{ id: 'item:minor_healing_potion', kind: 'consumable', nameKey: 'item.minor_healing_potion.name', stackable: true }] },
};

interface Recorded { readonly method: string; readonly path: string; readonly body: unknown }

function fakeLive(): LiveConnection & { emit(frame: LiveServerFrame): void } {
  const frames = new Set<(frame: LiveServerFrame) => void>();
  const live: LiveConnection & { state: LiveState } = {
    state: INITIAL_LIVE_STATE, subscribe: () => () => {}, subscribeFrames: (listener) => { frames.add(listener); return () => frames.delete(listener); },
    start() {}, stop() {}, online() {}, offline() {}, waitUntilOpen: () => Promise.resolve(),
  };
  return Object.assign(live, { emit: (frame: LiveServerFrame) => { for (const listener of frames) listener(frame); } });
}

/** `debug` is the status of GET /debug/clock; `respond` answers a debug POST (default 200 `{}`). */
function setup(debug: number | 'network', respond: (path: string) => Response = () => Response.json({ ok: true })) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path: input, body });
    if (input === '/debug/clock') {
      if (debug === 'network') throw new TypeError('offline');
      return debug === 200 ? Response.json(CLOCK) : Response.json({ error: 'not_found' }, { status: debug });
    }
    if (input.startsWith('/debug/')) return respond(input);
    if (input === '/auth/session') return Response.json({ accountId: 'acc', guest: true, email: null, expiresAtMs: 1 });
    if (input === '/characters') return Response.json([CHARACTER]);
    if (input === `/characters/${ACTOR}`) return Response.json(CHARACTER);
    if (input.endsWith('/world')) return Response.json(WORLD);
    if (input.endsWith('/inventory')) return Response.json(INVENTORY);
    if (input.startsWith('/live/current/')) return Response.json({ current: null });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const services = { api: new ApiClient(fetch), live: fakeLive(), storage: { getItem: () => null, setItem: () => {} } };
  return { services, calls, emit: (frame: LiveServerFrame) => (services.live as ReturnType<typeof fakeLive>).emit(frame), posts: () => calls.filter((call) => call.method === 'POST' && call.path.startsWith('/debug/')) };
}

async function openPanel(debug: number | 'network' = 200, respond?: (path: string) => Response) {
  const harness = setup(debug, respond);
  render(<App services={harness.services} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Debug' }));
  await screen.findByRole('dialog');
  // The pickers load from the server before an option exists.
  await waitFor(() => expect(screen.getByRole('option', { name: 'Minor Healing Potion' })).toBeDefined());
  return harness;
}

describe('debug panel', () => {
  beforeEach(() => { setLocale('en'); window.location.hash = ''; });
  afterEach(() => { cleanup(); setLocale('es'); });

  it.each([404, 500, 401, 'network' as const])('stays hidden when GET /debug/clock answers %s', async (status) => {
    const harness = setup(status);
    render(<App services={harness.services} />);
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeDefined();
    await waitFor(() => expect(harness.calls.some((call) => call.path === '/debug/clock')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Debug' })).toBeNull();
    expect(harness.posts()).toHaveLength(0);
  });

  it('shows the entry point only on a 200 and probes with GET', async () => {
    const harness = setup(200);
    render(<App services={harness.services} />);
    expect(await screen.findByRole('button', { name: 'Debug' })).toBeDefined();
    expect(harness.calls.find((call) => call.path === '/debug/clock')?.method).toBe('GET');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('conquers an area and resets one area or everything', async () => {
    const { posts } = await openPanel();
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area:region_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as conquered' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset the chosen area' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all world progress' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    const [conquer, resetOne, resetAll] = posts();
    expect(conquer).toMatchObject({ path: `/debug/characters/${ACTOR}/world-progress`,
      body: { operation: 'debug.recordWorldProgress', payload: { actorId: ACTOR, completedAreas: ['area:region_1'] } } });
    expect(resetOne).toMatchObject({ path: `/debug/characters/${ACTOR}/world-progress/reset`,
      body: { operation: 'debug.resetWorldProgress', payload: { actorId: ACTOR, areaId: 'area:region_1' } } });
    expect(resetAll).toMatchObject({ path: `/debug/characters/${ACTOR}/world-progress/reset`,
      body: { operation: 'debug.resetWorldProgress', payload: { actorId: ACTOR } } });
    expect((resetAll?.body as { payload: Record<string, unknown> }).payload).not.toHaveProperty('areaId');
    const ids = posts().map((call) => (call.body as { command_id: string }).command_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('sets level and XP', async () => {
    const { posts } = await openPanel();
    fireEvent.change(screen.getByLabelText(/^Level \(/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/^XP within/), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set level and XP' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: `/debug/characters/${ACTOR}/progression`,
      body: { operation: 'debug.setProgression', payload: { actorId: ACTOR, level: 12, xp: 40 } } });
  });

  it('grants gold and items, and refuses values outside the server limits', async () => {
    const { posts } = await openPanel();
    const goldButton = screen.getByRole('button', { name: 'Grant gold' });
    fireEvent.change(screen.getByLabelText(/^Gold/), { target: { value: '1000000001' } });
    expect((goldButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Gold/), { target: { value: '250' } });
    fireEvent.click(goldButton);
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'item:minor_healing_potion' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '10001' } });
    expect((screen.getByRole('button', { name: 'Grant item' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant item' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0]).toMatchObject({ path: `/debug/characters/${ACTOR}/grants`,
      body: { operation: 'debug.grant', payload: { actorId: ACTOR, gold: 250 } } });
    expect(posts()[1]).toMatchObject({ path: `/debug/characters/${ACTOR}/grants`,
      body: { operation: 'debug.grant', payload: { actorId: ACTOR, items: [{ item: 'item:minor_healing_potion', qty: 7 }] } } });
  });

  it('advances the clock with a warning, shows the offset and reloads it from the server', async () => {
    const { posts, calls } = await openPanel(200, () => Response.json({ advancedMs: 900_000, offsetMs: 4_500_000, nowMs: 1 }));
    expect(screen.getByRole('note').textContent).toContain('affects the whole environment');
    expect(screen.getByText('Current clock offset: 1 h 0 min')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '+15 min' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: '/debug/clock/advance', body: { operation: 'debug.clock.advance', payload: { durationMs: 900_000 } } });
    await waitFor(() => expect(calls.filter((call) => call.path === '/debug/clock').length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Current clock offset: 1 h 0 min')).toBeDefined();
    await waitFor(() => expect((screen.getByRole('button', { name: '+1 h' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '+1 h' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('button', { name: '+3 h' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '+3 h' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts().map((call) => (call.body as { payload: { durationMs: number } }).payload.durationMs)).toEqual([900_000, 3_600_000, 10_800_000]);
  });

  it('refreshes the character after an action', async () => {
    const { calls } = await openPanel();
    const before = calls.filter((call) => call.path === `/characters/${ACTOR}`).length;
    fireEvent.change(screen.getByLabelText(/^Gold/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant gold' }));
    await waitFor(() => expect(calls.filter((call) => call.path === `/characters/${ACTOR}`).length).toBeGreaterThan(before));
  });

  it('shows the success result', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText(/^Gold/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant gold' }));
    expect(await screen.findByText('Done: the server applied the change.')).toBeDefined();
  });

  it('records only the pinned Matriarch boss encounter and finishes on its result', async () => {
    const { services } = setup(200);
    render(<App services={services} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Debug' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start before boss' }));
    await screen.findByText(/Recording in the background/);
    const live = services.live as ReturnType<typeof fakeLive>;
    live.emit({ type: 'live.attached', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mode: 'snapshot' });
    live.emit({ type: 'live.snapshot', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: 1, seq: 1, participants: [], view: {
      phase: 'combat', area: 'area:region_1', location: 'loc:region_1.seed_vault_heart', combat: { tick: 0, groupId: 'loc:region_1.seed_vault_heart/2', actors: [] },
      heroes: [{ actorId: ACTOR, level: 3, hp: 20, maxHp: 20, present: true, consumables: [], skills: [] }],
      groups: [{ id: 'loc:region_1.seed_vault_heart/2', enemies: ['enemy.hollow_matriarch'], boss: true, defeated: false }],
    } } as unknown as LiveServerFrame);
    const event = (groupId: string, outcome: string): LiveServerFrame => ({ type: 'live.event', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: 1, seq: 1,
      source: 'game', event: { type: 'combatEnded', groupId, outcome } });
    live.emit(event('loc:region_1.seed_vault_heart/0', 'victory'));
    expect(screen.getByText(/Recording in the background/)).toBeDefined();
    live.emit({ type: 'live.event', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: 1, seq: 2, source: 'game',
      event: { type: 'combatStarted', groupId: 'loc:region_1.seed_vault_heart/2', boss: true } });
    live.emit({ type: 'live.event', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: 1, seq: 3, source: 'game',
      event: { type: 'combat', event: { type: 'DamageDealt', sourceId: 'matriarch-instance', targetId: ACTOR, amount: 5, hpAfter: 15 } } });
    live.emit(event('loc:region_1.seed_vault_heart/0', 'defeat'));
    expect(screen.getByText(/Recording in the background/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    live.emit(event('loc:region_1.seed_vault_heart/2', 'victory'));
    fireEvent.click(await screen.findByRole('button', { name: 'Debug' }));
    await screen.findByText(/Capture complete/);
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));
      const blob = createUrl.mock.calls[0]?.[0];
      if (!(blob instanceof Blob)) throw new Error('Expected a capture download');
      const exported = await blob.text();
      expect(JSON.parse(exported)).toMatchObject({ result: { outcome: 'victory' }, events: expect.arrayContaining([
        expect.objectContaining({ event: { type: 'combat', event: expect.objectContaining({ type: 'DamageDealt', amount: 5, hpAfter: 15 }) } }),
      ]) });
      expect(exported).not.toContain(ACTOR);
      expect(exported).not.toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    } finally {
      createUrl.mockRestore();
      click.mockRestore();
    }
  });

  it('shows the translated server error code, and the raw code when unknown', async () => {
    let code = 'unknown_item';
    await openPanel(200, () => Response.json({ error: code }, { status: 400 }));
    fireEvent.change(screen.getByLabelText(/^Gold/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant gold' }));
    expect(await screen.findByText('Error: Unknown item. (unknown_item)')).toBeDefined();
    code = 'brand_new_code';
    await waitFor(() => expect((screen.getByRole('button', { name: 'Grant gold' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Grant gold' }));
    expect(await screen.findByText('Error: brand_new_code (brand_new_code)')).toBeDefined();
  });
});
