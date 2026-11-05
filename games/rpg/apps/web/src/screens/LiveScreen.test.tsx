import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCurrentResponseDto, LiveOptionsDto, LiveViewDto } from '@rpg/protocol';
import { ApiClient } from '../api/http.ts';
import type { LiveConnection } from '../app/services.ts';
import { LiveClient } from '../live/client.ts';
import type { WebSocketLike } from '../live/client.ts';
import { LiveScreen } from './LiveScreen.tsx';

// The canvas is not under test here: capture what LiveScreen hands the viewport and drive its region taps directly.
type ViewportProps = { scene?: unknown; regionEnabled?: (kind: 'exit' | 'hotspot', id: string) => boolean | undefined; onRegionTap?: (kind: 'exit' | 'hotspot', id: string) => void };
const viewport: { props: ViewportProps | null } = { props: null };
vi.mock('../scene/SceneViewport.tsx', () => ({ SceneViewport: (props: ViewportProps) => { viewport.props = props; return null; } }));

const actorId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const options: LiveOptionsDto = { actorId, areas: [{ id: 'area:region_1', label: 'Region One', startLocationId: 'location:glade' }],
  supplies: [{ item: 'item:potion', label: 'Healing potion', availableQty: 3 }] };

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  authenticate(): void { this.readyState = 1; this.receive({ type: 'authenticated', accountId: actorId }); }
  receive(frame: unknown): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

function view(location = 'location:glade') {
  return { phase: 'exploring', area: 'area:region_1', location,
    heroes: [{ actorId, hp: 40, maxHp: 50, present: true, consumables: [{ item: 'item:potion', qty: 3 }] }],
    exits: [{ id: 'exit:boss', to: 'location:boss', open: true, reasons: [], bossRoom: true, visited: false }],
    hotspots: [{ id: 'corpse:33333333-3333-4333-8333-333333333333', type: 'corpse', textKey: 'live.corpse.recover', done: false }],
    resources: [], groups: [], canReturn: false, runBag: [{ actorId, items: [{ item: 'item:herb', qty: 2 }], gold: 4, uniques: [] }] } as const;
}

function currentResponse(value: LiveCurrentResponseDto['current']): LiveCurrentResponseDto { return { current: value }; }

function setup(initial: LiveCurrentResponseDto['current']) {
  let current = initial;
  const startBodies: unknown[] = [];
  let firstStartFails = false;
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === `/live/options/${actorId}`) return Response.json(options);
    if (input === `/live/current/${actorId}`) return Response.json(currentResponse(current));
    if (input === '/live/start') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      startBodies.push(body);
      if (firstStartFails) { firstStartFails = false; return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
      current = { instanceId, actorId, view: view(), participants: [{ actorId, status: 'connected' }] };
      return Response.json({ instanceId });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const api = new ApiClient(fetch);
  const sockets: Socket[] = [];
  const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    backoff: () => 100, pingIntervalMs: 60_000 });
  const live = client as LiveConnection;
  client.start();
  return { api, live, client, sockets, startBodies, setStartFailure: () => { firstStartFails = true; }, get current() { return current; } };
}

async function connect(screenLive: ReturnType<typeof setup>) {
  await waitFor(() => expect(screenLive.sockets[0]).toBeDefined());
  const socket = screenLive.sockets[0];
  if (!socket) throw new Error('missing live socket');
  act(() => socket.authenticate());
  return socket;
}

async function attach(socket: Socket, current: NonNullable<ReturnType<typeof setup>['current']>) {
  await waitFor(() => expect(JSON.parse(socket.sent.at(-1) ?? '{}').command?.op).toBe('live.attach'));
  act(() => {
    socket.receive({ type: 'live.snapshot', instanceId: current.instanceId, epoch: 1, seq: 0, view: current.view, participants: current.participants });
    socket.receive({ type: 'live.attached', instanceId: current.instanceId, mode: 'snapshot' });
  });
}

afterEach(() => { cleanup(); });

describe('LiveScreen navigation controller', () => {
  it('humanizes production location/group/resource labels and reflects explicit initial full HP and an empty bag', async () => {
    const snapshot = { ...view('loc:region_2.glass_echo_chamber'), area: 'area:region_1',
      heroes: [{ actorId, hp: null, maxHp: 50, present: true, consumables: [] }],
      groups: [{ id: 'loc:region_2.glass_echo_chamber/0', enemies: ['enemy:thornback_boar'], boss: false, defeated: false }],
      resources: [{ nodeId: 'res:region_2.prism_vein', resource: 'res.region_2.prism_vein.name', gathered: false }],
      hotspots: [{ id: 'hotspot:region_2.signal_bloom', type: 'lore', textKey: 'hotspot.region_2.signal_bloom.name', done: false }], runBag: [] };
    const deps = setup({ instanceId, actorId, view: snapshot as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    expect(await screen.findByRole('heading', { name: 'Glass Echo Chamber' })).toBeDefined();
    expect(screen.getByText(/Area:/).textContent).toContain('The Verdant Hollow');
    expect(screen.getByText('You')).toBeDefined();
    expect(screen.getByText('50 / 50 HP')).toBeDefined();
    expect(screen.getByRole('button', { name: /Interact: Signal Bloom/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Prism Vein/ })).toBeDefined();
    expect(screen.getByText(/Glass Echo Chamber group: Thornback Boar/)).toBeDefined();
    expect(screen.getByText('0 items · 0 gold · 0 unique items')).toBeDefined();
    deps.client.stop();
  });

  it('resolves area label keys in the live scene and never prints the raw key', async () => {
    const snapshot = { ...view(), area: 'area.region_1.name' };
    const deps = setup({ instanceId, actorId, view: snapshot as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    await waitFor(() => expect(screen.getByText(/Area:/).textContent).toContain('The Verdant Hollow'));
    expect(document.body.textContent).not.toContain('area.region_1.name');
    deps.client.stop();
  });

  it('falls back to a humanized label for unknown area keys', async () => {
    const snapshot = { ...view(), area: 'area.region_9.mossy_deep.name' };
    const deps = setup({ instanceId, actorId, view: snapshot as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    await waitFor(() => expect(screen.getByText(/Area:/).textContent).toContain('Mossy Deep'));
    expect(document.body.textContent).not.toContain('area.region_9');
    deps.client.stop();
  });

  it('resolves label keys in the entry form area and supply options', async () => {
    const keyed = { ...options, areas: [{ id: 'area:region_1', label: 'area.region_1.name', startLocationId: 'location:glade' }],
      supplies: [{ item: 'item:potion', label: 'item.healing_potion.name', availableQty: 3 }] };
    const deps = setup(null);
    const fetch = vi.fn(async (input: string) => input === `/live/options/${actorId}` ? Response.json(keyed)
      : input === `/live/current/${actorId}` ? Response.json(currentResponse(null)) : Response.json({ error: 'not_found' }, { status: 404 }));
    render(<LiveScreen actorId={actorId} api={new ApiClient(fetch)} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    expect(await screen.findByRole('option', { name: 'The Verdant Hollow' })).toBeDefined();
    expect(screen.getByLabelText('Healing Potion quantity')).toBeDefined();
    expect(document.body.textContent).not.toContain('area.region_1.name');
    deps.client.stop();
  });

  it('starts from server options and retries the exact same start command after an ambiguous failure', async () => {
    const deps = setup(null);
    deps.setStartFailure();
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    fireEvent.change(await screen.findByLabelText('Area'), { target: { value: 'area:region_1' } });
    fireEvent.change(screen.getByLabelText('Healing potion quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start live adventure' }));
    const retry = await screen.findByRole('button', { name: 'Retry same start' });
    fireEvent.click(retry);
    await waitFor(() => expect(deps.startBodies).toHaveLength(2));
    expect(deps.startBodies[1]).toEqual(deps.startBodies[0]);
    expect(deps.startBodies[0]).toMatchObject({ actorId, areaId: 'area:region_1', supplies: [{ item: 'item:potion', qty: 2 }] });
    expect(typeof (deps.startBodies[0] as { commandId?: unknown }).commandId).toBe('string');
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    expect(await screen.findByRole('heading', { name: 'Glade' })).toBeDefined();
    expect(screen.getByText('Herb ×2')).toBeDefined();
    deps.client.stop();
  });

  it('uses server owner hotspots and requires a server risk warning plus explicit confirmation before boss entry', async () => {
    const deps = setup({ instanceId, actorId, view: view(), participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    expect(await screen.findByRole('button', { name: /Recover your corpse/ })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Review boss room risk/ }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1) ?? '{}').command?.command).toMatchObject({ type: 'enterBossRoom', exitId: 'exit:boss', confirm: false }));
    const warningRequest = JSON.parse(socket.sent.at(-1) ?? '{}').command as { commandId: string };
    act(() => {
      socket.receive({ type: 'live.ack', instanceId, commandId: warningRequest.commandId, status: 'applied', duplicate: false });
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 1, source: 'game', event: { type: 'bossRoomWarning', exitId: 'exit:boss', risk: {
        locationId: 'location:boss', enemies: [{ enemy: 'enemy:guardian', rank: 'boss', level: 8 }],
        heroes: [{ actorId, hp: 40, maxHp: 50, healingConsumables: 2 }], retreatAllowed: false, onDeath: ['live.death.run_bag_to_corpse'],
        deathConsequences: [{ actorId, xpLost: 10, xpBeforeTotal: 100, runBag: { items: [{ item: 'item:herb', qty: 2 }], gold: 4, uniques: [] } }],
      } } });
      socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: deps.current?.view ?? view(), participants: [{ actorId, status: 'connected' }] });
    });
    expect(await screen.findByRole('alertdialog', { name: 'Boss room risk' })).toBeDefined();
    expect(screen.getByText('The server received the command.')).toBeDefined();
    expect(screen.getByText(/Guardian · boss rank · level 8/)).toBeDefined();
    expect(screen.getByText(/Server-listed consequences: Run bag moves to a corpse/)).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm entry' }));
    await waitFor(() => expect(JSON.parse(socket.sent.at(-1) ?? '{}').command?.command).toMatchObject({ type: 'enterBossRoom', exitId: 'exit:boss', confirm: true }));
    deps.client.stop();
  });
  it('sends the same commands from scene region taps as from the DOM buttons, and ignores disabled regions', async () => {
    const scene = { width: 100, height: 100, regions: [{ id: 'exit:go', kind: 'exit', x: 10, y: 10, r: 8 }, { id: 'exit:shut', kind: 'exit', x: 20, y: 10, r: 8 },
      { id: 'exit:boss', kind: 'exit', x: 30, y: 10, r: 8 }, { id: 'rune', kind: 'hotspot', x: 40, y: 10, r: 8 }, { id: 'spent', kind: 'hotspot', x: 50, y: 10, r: 8 },
      { id: 'exit:ghost', kind: 'exit', x: 60, y: 10, r: 8 }] };
    const snapshot = { ...view(), scene, exits: [
      { id: 'exit:go', to: 'location:next', open: true, reasons: [], bossRoom: false, visited: false },
      { id: 'exit:shut', to: 'location:locked', open: false, reasons: ['live.locked'], bossRoom: false, visited: false },
      { id: 'exit:boss', to: 'location:boss', open: true, reasons: [], bossRoom: true, visited: false }],
    hotspots: [{ id: 'rune', type: 'lore', textKey: 'hotspot.rune', done: false }, { id: 'spent', type: 'lore', textKey: 'hotspot.spent', done: true }] };
    const deps = setup({ instanceId, actorId, view: snapshot as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    await screen.findByRole('button', { name: /Travel to/ });
    const props = (): ViewportProps => { if (!viewport.props) throw new Error('viewport not rendered'); return viewport.props; };
    expect(props().scene).toEqual(scene);
    const lastCommand = () => JSON.parse(socket.sent.at(-1) ?? '{}').command?.command;
    // Enabled state mirrors the DOM controls; geometry without a control is not interactive.
    expect(['exit:go', 'exit:shut', 'exit:boss'].map((id) => props().regionEnabled?.('exit', id))).toEqual([true, false, true]);
    expect(['rune', 'spent'].map((id) => props().regionEnabled?.('hotspot', id))).toEqual([true, false]);
    expect(props().regionEnabled?.('exit', 'exit:ghost')).toBeUndefined();

    const before = socket.sent.length;
    act(() => { props().onRegionTap?.('exit', 'exit:shut'); props().onRegionTap?.('hotspot', 'spent'); props().onRegionTap?.('exit', 'exit:ghost'); });
    expect(socket.sent.length).toBe(before);

    act(() => props().onRegionTap?.('exit', 'exit:go'));
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'travel', exitId: 'exit:go' }));
    const travelId = JSON.parse(socket.sent.at(-1) ?? '{}').command.commandId as string;
    act(() => socket.receive({ type: 'live.ack', instanceId, commandId: travelId, status: 'applied', duplicate: false }));
    await waitFor(() => expect(props().regionEnabled?.('hotspot', 'rune')).toBe(true));
    act(() => props().onRegionTap?.('hotspot', 'rune'));
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'interact', hotspotId: 'rune' }));
    const interactId = JSON.parse(socket.sent.at(-1) ?? '{}').command.commandId as string;
    act(() => socket.receive({ type: 'live.ack', instanceId, commandId: interactId, status: 'applied', duplicate: false }));
    await waitFor(() => expect(props().regionEnabled?.('exit', 'exit:boss')).toBe(true));
    // A boss-room region asks for the server's risk summary first; it never skips the confirmation.
    act(() => props().onRegionTap?.('exit', 'exit:boss'));
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'enterBossRoom', exitId: 'exit:boss', confirm: false }));
    deps.client.stop();
  });

  it('shows the server-provided XP bar of a hero past the old level cap (open-ended curve, #129)', async () => {
    const seventh = { actorId, level: 7, xp: 4_531, xpIntoLevel: 781, xpToNext: 1562, hp: null, maxHp: 80, present: true, consumables: [] };
    const deps = setup({ instanceId, actorId, view: { ...view(), heroes: [seventh] } as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={vi.fn(async () => {})} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    expect(await screen.findByText('Level 7')).toBeDefined();
    expect(screen.getByText('781 / 1562 XP')).toBeDefined();
    expect(screen.queryByText('Max level')).toBeNull();
    deps.client.stop();
  });
  it('shows server-granted XP and a level-up immediately at the victory and refreshes the character once', async () => {
    const hero = (level: number, xpIntoLevel: number) => ({ actorId, level, xp: level === 1 ? xpIntoLevel : 100 + xpIntoLevel, xpIntoLevel,
      xpToNext: level === 1 ? 100 : 250, hp: null, maxHp: level === 1 ? 50 : 56, present: true, consumables: [] });
    const first = { ...view(), heroes: [hero(1, 95)] };
    const deps = setup({ instanceId, actorId, view: first as unknown as LiveViewDto, participants: [{ actorId, status: 'connected' }] });
    const socket = await connect(deps);
    const refresh = vi.fn(async () => {});
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={refresh} />);
    await attach(socket, deps.current as NonNullable<typeof deps.current>);
    expect(await screen.findByText('Level 1')).toBeDefined();
    expect(screen.getByText('95 / 100 XP')).toBeDefined();
    expect(screen.queryByText(/Level up!/)).toBeNull();
    const refreshesBefore = refresh.mock.calls.length;

    const rewards = { type: 'combatRewards', groupId: 'group:slime', rewards: [
      { actorId, xp: 10, drops: [], gold: 0, levelBefore: 1, levelAfter: 2, xpIntoLevel: 5, xpToNext: 250 },
      { actorId: '33333333-3333-4333-8333-333333333333', xp: 10, drops: [], gold: 0, levelBefore: 4, levelAfter: 5, xpIntoLevel: 1, xpToNext: 450 }] };
    act(() => {
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 1, source: 'game', event: rewards });
      socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: { ...view(), heroes: [hero(2, 5)] }, participants: [{ actorId, status: 'connected' }] });
    });
    expect((await screen.findByText(/\+10 XP/)).textContent).toBe('+10 XP · Level up! You reached level 2.');
    expect(screen.getByText('Level 2')).toBeDefined();
    expect(screen.getByText('5 / 250 XP')).toBeDefined();
    await waitFor(() => expect(refresh.mock.calls.length).toBe(refreshesBefore + 1));
    // A later unrelated frame re-delivers the same event log; the character is not refreshed again.
    act(() => {
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 2, source: 'game', event: { type: 'traveled', exitId: 'x', from: 'a', to: 'b' } });
    });
    expect(refresh.mock.calls.length).toBe(refreshesBefore + 1);
    // A reward without a level change is a plain gain; events from older servers (no level fields) still render.
    act(() => {
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 3, source: 'game', event: { type: 'combatRewards', groupId: 'g2',
        rewards: [{ actorId, xp: 6, drops: [], gold: 0 }] } });
    });
    expect((await screen.findByText('+6 XP')).className).not.toContain('level-up');
    await waitFor(() => expect(refresh.mock.calls.length).toBe(refreshesBefore + 2));
    deps.client.stop();
  });
});
