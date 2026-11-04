/** Full DOM acceptance through LiveScreen, LiveSession and the authenticated LiveClient frame boundary. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LiveCurrentResponseDto, LiveDeathSummaryDto, LiveOptionsDto, LiveViewDto } from '@rpg/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../api/http.ts';
import type { LiveConnection } from '../app/services.ts';
import { LiveClient } from '../live/client.ts';
import type { WebSocketLike } from '../live/client.ts';
import { LiveScreen } from './LiveScreen.tsx';

const actorId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const secondInstanceId = '55555555-5555-4555-8555-555555555555';
const deathId = '33333333-3333-4333-8333-333333333333';
const areaId = 'area:region_1';
const options: LiveOptionsDto = { actorId, areas: [{ id: areaId, label: 'Region One', startLocationId: 'loc:region_1.portal_clearing' }],
  supplies: [{ item: 'item:minor_healing_potion', label: 'Minor Healing Potion', availableQty: 2 }] };

type JsonRecord = Record<string, unknown>;
type ClientCommand = { op: string; commandId?: string; command?: JsonRecord; actorId?: string; instanceId?: string };

function view(location: string, options: { phase?: 'exploring' | 'combat'; boss?: boolean; corpse?: boolean; canReturn?: boolean } = {}): LiveViewDto {
  const isCombat = options.phase === 'combat';
  return {
    phase: options.phase ?? 'exploring', area: areaId, location,
    heroes: [{ actorId, level: 2, xp: 22, hp: 42, maxHp: 50, present: true,
      consumables: [{ item: 'item:minor_healing_potion', qty: 2 }],
      skills: [{ id: 'skill:basic_attack', labelKey: 'skill.basic_attack.name', slot: 1, cooldownTicks: 0, cooldownRemainingTicks: 0, windupTicks: 0 }], automationEnabled: false }],
    groups: [],
    exits: options.boss ? [{ id: 'exit:region_1.boss_gate', to: 'loc:region_1.seed_vault_heart', open: true,
      reasons: [], bossRoom: true, visited: false }] : location === 'loc:region_1.portal_clearing'
        ? [{ id: 'exit:region_1.portal_clearing.overgrown_causeway', to: 'loc:region_1.overgrown_causeway', open: true,
          reasons: [], bossRoom: false, visited: false }] : [],
    hotspots: options.corpse ? [{ id: `corpse:${deathId}`, type: 'corpse', textKey: 'live.corpse.recover', done: false }] : [],
    resources: [], canReturn: options.canReturn ?? false,
    runBag: [{ actorId, items: [{ item: 'item:test_grove.herb', qty: 2 }], gold: 4, uniques: [] }],
    ...(isCombat ? { combat: { tick: 0, groupId: 'group:acceptance', actors: [
      { id: actorId, side: 'hero', hp: 42, maxHp: 50, alive: true, auto: false, queued: null, windup: null, effects: [] },
      { id: 'enemy:thornback_boar', labelKey: 'enemy.thornback_boar.name', side: 'enemy', hp: 90, maxHp: 90, alive: true, auto: true, queued: null,
        windup: { skill: 'skill:heavy_blow', labelKey: 'skill.heavy_blow.name', targetIds: [actorId], startedTick: 0, resolveAtTick: 1 }, effects: [] },
    ] } } : {}),
  };
}

function current(value: LiveCurrentResponseDto['current']): LiveCurrentResponseDto { return { current: value }; }
function death(): LiveDeathSummaryDto {
  return { deathId, occurredAt: 2_000_000_000_000, areaId, locationId: 'loc:region_1.overgrown_causeway',
    xpBefore: { level: 2, xpIntoLevel: 22, totalXp: 122 }, xpLost: 10,
    xpAfter: { level: 2, xpIntoLevel: 12, totalXp: 112 }, causes: [{ sourceId: 'enemy:acceptance_guard', label: 'Stone Guardian', damage: 50 }],
    corpse: { id: deathId, status: 'active', expiresAt: 2_000_086_400_000,
      contents: { stacks: [{ item: 'item:test_grove.herb', qty: 2 }], gold: 4, uniques: [] } } };
}

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  authenticate(): void { this.readyState = 1; this.receive({ type: 'authenticated', accountId: '44444444-4444-4444-8444-444444444444' }); }
  receive(frame: unknown): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  drop(): void { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code: 1006 })); }
}

function setup(initial: LiveCurrentResponseDto['current']) {
  let currentValue = initial;
  let deathValue: LiveDeathSummaryDto | null = null;
  let starts = 0;
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    requests.push({ path, method, body });
    if (path === `/live/options/${actorId}`) return Response.json(options);
    if (path === `/live/current/${actorId}`) return Response.json(current(currentValue));
    if (path === '/live/start') {
      starts++;
      const startedId = starts === 1 ? instanceId : secondInstanceId;
      currentValue = { instanceId: startedId, actorId, view: view('loc:region_1.portal_clearing', { corpse: true }),
        participants: [{ actorId, status: 'connected' }] };
      return Response.json({ instanceId: startedId });
    }
    if (path === `/characters/${actorId}/live-death`) return Response.json({ death: deathValue });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const api = new ApiClient(fetch);
  const sockets: Socket[] = [];
  const client = new LiveClient({ url: 'ws://test/auth/live', createSocket: () => {
    const socket = new Socket(); sockets.push(socket); return socket;
  }, backoff: () => 1000, pingIntervalMs: 60_000 });
  const live = client as LiveConnection;
  client.start();
  return { api, live, client, sockets, requests, get current() { return currentValue; }, set current(value) { currentValue = value; },
    get starts() { return starts; },
    set death(value: LiveDeathSummaryDto | null) { deathValue = value; } };
}

function sentCommands(socket: Socket): ClientCommand[] {
  return socket.sent.filter(value => value.startsWith('{')).map(value => JSON.parse(value) as { command: ClientCommand })
    .map(value => value.command);
}
async function socketReady(deps: ReturnType<typeof setup>, index = 0): Promise<Socket> {
  await waitFor(() => expect(deps.sockets[index]).toBeDefined());
  const socket = deps.sockets[index];
  if (!socket) throw new Error('missing socket');
  act(() => socket.authenticate());
  return socket;
}
async function attach(socket: Socket, value: NonNullable<ReturnType<typeof setup>['current']>, mode: 'snapshot' | 'resume' = 'snapshot') {
  await waitFor(() => expect(sentCommands(socket).some(command => command.op === 'live.attach')).toBe(true));
  const attachCommand = sentCommands(socket).find(command => command.op === 'live.attach');
  if (!attachCommand?.instanceId) throw new Error('missing live attach command');
  act(() => {
    if (mode === 'snapshot') socket.receive({ type: 'live.snapshot', instanceId: attachCommand.instanceId, epoch: 1, seq: 0,
      view: value.view, participants: value.participants });
    socket.receive({ type: 'live.attached', instanceId: attachCommand.instanceId, mode });
  });
}
function event(socket: Socket, seq: number, value: JsonRecord, source: 'game' | 'host' = 'game') {
  socket.receive({ type: 'live.event', instanceId, epoch: 1, seq, source, event: value });
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('LiveScreen fullflow acceptance', () => {
  it('starts from server options, refreshes travel/hotspot scene, and replays one telegraphed action ID after reconnect', async () => {
    const deps = setup(null);
    const socket0 = await socketReady(deps);
    const refreshCharacter = vi.fn(async () => {});
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={refreshCharacter} />);

    fireEvent.change(await screen.findByLabelText('Area'), { target: { value: areaId } });
    fireEvent.change(screen.getByLabelText('Minor Healing Potion quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(deps.requests.some(request => request.path === '/live/start')).toBe(true));
    const startRequest = deps.requests.find(request => request.path === '/live/start');
    expect(startRequest?.body).toMatchObject({ actorId, areaId, supplies: [{ item: 'item:minor_healing_potion', qty: 1 }] });
    expect(Object.keys(startRequest?.body as object).sort()).toEqual(['actorId', 'areaId', 'commandId', 'supplies']);
    const liveCurrent = deps.current;
    if (!liveCurrent) throw new Error('start did not return the server current instance');
    await attach(socket0, liveCurrent);
    expect(await screen.findByRole('heading', { name: 'Portal Clearing' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Recover your corpse' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Travel to Overgrown Causeway' }));
    const travel = sentCommands(socket0).filter(command => command.op === 'live.command').at(-1);
    expect(travel?.command).toEqual({ type: 'travel', exitId: 'exit:region_1.portal_clearing.overgrown_causeway' });
    deps.current = { ...liveCurrent, view: view('loc:region_1.overgrown_causeway', { corpse: true }) };
    const traveled = deps.current;
    if (!traveled) throw new Error('travel scene missing');
    act(() => {
      event(socket0, 1, { type: 'traveled', locationId: 'loc:region_1.overgrown_causeway' });
      socket0.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: traveled.view, participants: traveled.participants });
      socket0.receive({ type: 'live.ack', instanceId, commandId: travel?.commandId, status: 'applied', duplicate: false });
    });
    expect(await screen.findByRole('heading', { name: 'Overgrown Causeway' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Recover your corpse' }));
    const recover = sentCommands(socket0).filter(command => command.op === 'live.command').at(-1);
    expect(recover?.command).toEqual({ type: 'interact', hotspotId: `corpse:${deathId}` });
    deps.current = { ...liveCurrent, view: view('loc:region_1.overgrown_causeway') };
    const recovered = deps.current;
    if (!recovered) throw new Error('recovered scene missing');
    act(() => {
      event(socket0, 2, { type: 'corpseRecovered', actorId });
      socket0.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 2, view: recovered.view, participants: recovered.participants });
      socket0.receive({ type: 'live.ack', instanceId, commandId: recover?.commandId, status: 'applied', duplicate: false });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Recover your corpse' })).toBeNull());
    const liveStart = deps.requests.filter(request => request.path === '/live/start');
    expect(liveStart).toHaveLength(1);
    deps.client.stop();
  });

  it('shows the one-tick (500 ms) attack telegraph, keeps one command ID across reconnect and reflects the host view/ack', async () => {
    const initial = { instanceId, actorId, view: view('loc:region_1.overgrown_causeway'), participants: [{ actorId, status: 'connected' as const }] };
    const deps = setup(initial);
    const socket0 = await socketReady(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket0, initial);

    // The authoritative view says combat is at the next server tick; controls must expose its countdown and remain useful now.
    deps.current = { ...initial, view: view('loc:region_1.overgrown_causeway', { phase: 'combat' }) };
    const combatStart = deps.current;
    if (!combatStart) throw new Error('combat snapshot missing');
    act(() => {
      event(socket0, 1, { type: 'combatStarted', groupId: 'group:acceptance' });
      socket0.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: combatStart.view, participants: initial.participants });
    });
    expect(await screen.findByText('Thornback Boar is winding up Heavy Blow')).toBeDefined();
    expect(screen.getByText('Resolves in 1 tick')).toBeDefined();
    const skill = screen.getByRole('button', { name: /Slot 1.*Basic Attack/ });
    fireEvent.click(skill);
    const firstSkill = sentCommands(socket0).filter(command => command.op === 'live.command' && command.command?.['type'] === 'useSkill');
    expect(firstSkill).toHaveLength(1);
    const stableId = firstSkill[0]?.commandId;
    expect(stableId).toMatch(/^[0-9a-f-]{36}$/i);

    // Lose the first acknowledgement, reconnect, and let the live session resend the pending intent with the same id.
    act(() => socket0.drop());
    act(() => deps.client.online());
    const socket1 = await socketReady(deps, 1);
    await attach(socket1, initial, 'resume');
    await waitFor(() => expect(sentCommands(socket1).filter(command => command.op === 'live.command').length).toBe(1));
    const replayed = sentCommands(socket1).find(command => command.op === 'live.command');
    expect(replayed).toMatchObject({ commandId: stableId, command: { type: 'useSkill', skill: 'skill:basic_attack' } });

    // The host resolves the intent once; the ACK plus current view show the resulting queued skill and HP update.
    deps.current = { ...initial, view: {
      ...view('loc:region_1.overgrown_causeway', { phase: 'combat' }),
      combat: { tick: 1, groupId: 'group:acceptance', actors: [
        { id: actorId, side: 'hero', hp: 42, maxHp: 50, alive: true, auto: false,
          queued: { kind: 'useSkill', skill: 'skill:basic_attack', target: 'enemy:acceptance_guard' }, windup: null, effects: [] },
        { id: 'enemy:acceptance_guard', labelKey: 'enemy.thornback_boar.name', side: 'enemy', hp: 72, maxHp: 90, alive: true, auto: true,
          queued: null, windup: null, effects: [] },
      ] },
    } };
    const nextCombat = deps.current;
    if (!nextCombat) throw new Error('updated combat snapshot missing');
    act(() => {
      socket1.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: nextCombat.view, participants: nextCombat.participants });
      socket1.receive({ type: 'live.ack', instanceId, commandId: stableId, status: 'applied', duplicate: true });
    });
    await waitFor(() => expect(screen.getByText('The server received the command.')).toBeDefined());
    expect(screen.getByLabelText('Thornback Boar HP 72 of 90')).toBeDefined();
    expect(screen.getByText('The server received the command.')).toBeDefined();
    expect(sentCommands(socket1).filter(command => command.op === 'live.command').map(command => command.commandId)).toEqual([stableId]);
    deps.client.stop();
  });

  it('disables actions offline and requires the server boss warning before confirmation', async () => {
    const initial = { instanceId, actorId, view: view('loc:region_1.overgrown_causeway', { boss: true }),
      participants: [{ actorId, status: 'connected' as const }] };
    const deps = setup(initial);
    const socket = await socketReady(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, initial);
    const warningButton = await screen.findByRole('button', { name: /Review boss room risk/ });
    act(() => deps.client.offline());
    await waitFor(() => expect(warningButton.hasAttribute('disabled')).toBe(true));
    act(() => deps.client.stop());

    // Reopen a new connection and request only the warning. The dialog and risk values must come from the server event.
    deps.client.start();
    const second = await socketReady(deps, 1);
    await attach(second, initial);
    const enabledReview = screen.getByRole('button', { name: /Review boss room risk/ });
    fireEvent.click(enabledReview);
    const warning = sentCommands(second).filter(command => command.op === 'live.command').at(-1);
    expect(warning?.command).toMatchObject({ type: 'enterBossRoom', exitId: 'exit:region_1.boss_gate', confirm: false });
    const warningId = warning?.commandId;
    act(() => {
      second.receive({ type: 'live.ack', instanceId, commandId: warningId, status: 'applied', duplicate: false });
      event(second, 1, { type: 'bossRoomWarning', exitId: 'exit:region_1.boss_gate', risk: {
        locationId: 'loc:region_1.seed_vault_heart', enemies: [{ enemy: 'enemy:seed_guardian', rank: 'boss', level: 8 }],
        heroes: [{ actorId, hp: 42, maxHp: 50, healingConsumables: 2 }], retreatAllowed: false, onDeath: ['live.death.run_bag_to_corpse'],
        deathConsequences: [{ actorId, xpLost: 10, xpBeforeTotal: 122,
          runBag: { items: [{ item: 'item:test_grove.herb', qty: 2 }], gold: 4, uniques: [] } }],
      } });
      second.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: initial.view, participants: initial.participants });
    });
    expect(await screen.findByRole('alertdialog', { name: 'Boss room risk' })).toBeDefined();
    expect(screen.getByText(/Seed Guardian · boss rank · level 8/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sentCommands(second).filter(command => command.op === 'live.command' && command.command?.['confirm'] === true)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Review boss room risk/ }));
    expect(screen.queryByRole('alertdialog', { name: 'Boss room risk' })).toBeNull();
    const secondWarning = sentCommands(second).filter(command => command.op === 'live.command').at(-1);
    act(() => {
      second.receive({ type: 'live.ack', instanceId, commandId: secondWarning?.commandId, status: 'applied', duplicate: false });
      event(second, 2, { type: 'bossRoomWarning', exitId: 'exit:region_1.boss_gate', risk: {
        locationId: 'loc:region_1.seed_vault_heart', enemies: [], heroes: [{ actorId, hp: 42, maxHp: 50, healingConsumables: 2 }],
        retreatAllowed: false, onDeath: [], deathConsequences: [],
      } });
      second.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 2, view: initial.view, participants: initial.participants });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm entry' }));
    expect(sentCommands(second).filter(command => command.op === 'live.command').at(-1)?.command)
      .toMatchObject({ type: 'enterBossRoom', exitId: 'exit:region_1.boss_gate', confirm: true });
    deps.client.stop();
  });

  it('announces durable return and refreshes character state', async () => {
    const initial = { instanceId, actorId, view: view('loc:region_1.portal_clearing', { canReturn: true }),
      participants: [{ actorId, status: 'connected' as const }] };
    const deps = setup(initial);
    const socket = await socketReady(deps);
    const refreshCharacter = vi.fn(async () => {});
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={refreshCharacter} />);
    await attach(socket, initial);
    expect(await screen.findByRole('button', { name: 'Return to Sanctuary' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Return to Sanctuary' }));
    const returned = sentCommands(socket).filter(command => command.op === 'live.command').at(-1);
    expect(returned?.command).toEqual({ type: 'returnToSanctuary' });
    act(() => {
      socket.receive({ type: 'live.ack', instanceId, commandId: returned?.commandId, status: 'applied', duplicate: false });
    });
    deps.current = null;
    act(() => {
      socket.receive({ type: 'live.closed', instanceId, outcome: 'returned', result: { area: areaId } });
    });
    expect(await screen.findByRole('heading', { name: 'Adventure ended: returned.' })).toBeDefined();
    await waitFor(() => expect(refreshCharacter).toHaveBeenCalled());
    deps.client.stop();
  });

  it('starts a new adventure after return and again after a second run ends in death', async () => {
    const deps = setup(null);
    const socket = await socketReady(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(deps.starts).toBe(1));
    const first = deps.current;
    if (!first) throw new Error('first run did not start');
    await attach(socket, first);
    act(() => socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1,
      view: view('loc:region_1.portal_clearing', { canReturn: true }), participants: first.participants }));
    fireEvent.click(await screen.findByRole('button', { name: 'Return to Sanctuary' }));
    const firstReturn = sentCommands(socket).filter(command => command.op === 'live.command').at(-1);
    if (!firstReturn?.commandId) throw new Error('first return command missing');
    deps.current = null;
    act(() => {
      socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: view('loc:region_1.portal_clearing', { canReturn: true }), participants: first.participants });
      socket.receive({ type: 'live.ack', instanceId, commandId: firstReturn.commandId, status: 'applied', duplicate: false });
      socket.receive({ type: 'live.closed', instanceId, outcome: 'returned', result: { area: 'area:region_1' } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New adventure' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start live adventure' }));
    await waitFor(() => expect(deps.starts).toBe(2));
    const second = deps.current as unknown as NonNullable<LiveCurrentResponseDto['current']>;
    if (!second) throw new Error('second run did not start');
    await waitFor(() => expect(sentCommands(socket).some(command => command.op === 'live.attach' && command.instanceId === secondInstanceId)).toBe(true));
    act(() => {
      socket.receive({ type: 'live.snapshot', instanceId: secondInstanceId, epoch: 1, seq: 0, view: second.view, participants: second.participants });
      socket.receive({ type: 'live.attached', instanceId: secondInstanceId, mode: 'snapshot' });
    });
    deps.current = null;
    act(() => socket.receive({ type: 'live.closed', instanceId: secondInstanceId, outcome: 'death', result: { area: areaId } }));
    fireEvent.click(await screen.findByRole('button', { name: 'New adventure' }));
    expect(await screen.findByRole('button', { name: 'Start live adventure' })).toBeDefined();
    expect(deps.starts).toBe(2);
    deps.client.stop();
  });

  it('uses each host snapshot for cooldowns and telegraphs without fetching current on every socket cursor', async () => {
    const initial = { instanceId, actorId, view: view('loc:region_1.overgrown_causeway', { phase: 'combat' }),
      participants: [{ actorId, status: 'connected' as const }] };
    const deps = setup(initial);
    const socket = await socketReady(deps);
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={async () => {}} />);
    await attach(socket, initial);
    const currentReads = deps.requests.filter(request => request.path === `/live/current/${actorId}`).length;
    const combatView = view('loc:region_1.overgrown_causeway', { phase: 'combat' });
    const hero = combatView.heroes?.[0];
    if (!hero) throw new Error('combat hero missing');
    const nextView = {
      ...combatView,
      heroes: [{ ...hero,
        skills: [{ id: 'skill:basic_attack', slot: 1, cooldownTicks: 0, cooldownRemainingTicks: 3, windupTicks: 0 }] }],
      combat: { tick: 8, groupId: 'group:acceptance', actors: [
        { id: actorId, side: 'hero' as const, hp: 42, maxHp: 50, alive: true, auto: false, queued: null, windup: null, effects: [] },
        { id: 'enemy:acceptance_guard', side: 'enemy' as const, hp: 90, maxHp: 90, alive: true, auto: true, queued: null,
          windup: { skill: 'skill:heavy_blow', targetIds: [actorId], startedTick: 7, resolveAtTick: 10 }, effects: [] },
      ] },
    } as unknown as LiveViewDto;
    act(() => socket.receive({ type: 'live.snapshot', instanceId, epoch: 1, seq: 1, view: nextView, participants: initial.participants }));
    expect(await screen.findByText('Resolves in 2 ticks')).toBeDefined();
    expect(screen.getByText(/Cooldown remaining: 3 ticks/)).toBeDefined();
    expect(deps.requests.filter(request => request.path === `/live/current/${actorId}`)).toHaveLength(currentReads);
    // Even a delayed HTTP bootstrap response cannot replace this newer sequenced socket view.
    deps.client.stop();
  });

  it('reloads the owner death summary after a durable death event and renders the persisted corpse panel', async () => {
    const initial = { instanceId, actorId, view: view('loc:region_1.overgrown_causeway'),
      participants: [{ actorId, status: 'connected' as const }] };
    const deps = setup(initial);
    const socket = await socketReady(deps);
    const refreshCharacter = vi.fn(async () => {});
    render(<LiveScreen actorId={actorId} api={deps.api} live={deps.live} canCommand onCharacterRefresh={refreshCharacter} />);
    await attach(socket, initial);
    deps.death = death();
    act(() => {
      socket.receive({ type: 'live.event', instanceId, epoch: 1, seq: 1, source: 'game', event: { type: 'heroDied', actorId, deathId } });
    });
    deps.current = null;
    act(() => {
      socket.receive({ type: 'live.closed', instanceId, outcome: 'defeated', result: { area: areaId } });
    });
    expect(await screen.findByRole('heading', { name: 'Adventure ended: defeated.' })).toBeDefined();
    await waitFor(() => expect(deps.requests.filter(request => request.path === `/characters/${actorId}/live-death`).length).toBeGreaterThan(1));
    expect(await screen.findByText('Stone Guardian · 50 damage')).toBeDefined();
    expect(screen.getByText('Grove Herb')).toBeDefined();
    expect(refreshCharacter).toHaveBeenCalledTimes(1);
    deps.client.stop();
  });
});
