import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpeditionDto, ExpeditionOptionsDto } from '@rpg/protocol';
import { CommandUnconfirmedError } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { ApiClient } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { ExpeditionScreen } from './ExpeditionScreen.tsx';

const id = '11111111-1111-4111-8111-111111111111';
const character: CharacterDto = { actorId: id, accountId: id, gameId: 'rpg', name: 'Ada', level: 1, xp: 0,
  attributes: { STR: 1, AGI: 1, INT: 1, VIT: 1, SPI: 1 }, unspentPoints: 0, skillLoadout: [], automationRules: [], activityState: 'none', activityId: null, version: 1 };
const options: ExpeditionOptionsDto = { actorId: id,
  areas: [{ areaId: 'area:ruins', kind: 'explorable', activities: [{ activityId: 'activity:ruins', simulatorId: 'sim:idle', available: true }] }],
  durationsMin: [15, 30], paceBp: { min: 1, max: 20_000, default: 10_000 }, consumables: [] };
const running: ExpeditionDto = { id, actorId: id, state: 'running', areaId: 'area:ruins', activityId: 'activity:ruins', startsAtMs: Date.now() - 60_000,
  plannedEndsAtMs: Date.now() + 60_000, progress: { revealed: 1 }, segments: [{ index: 0, revealAtMs: Date.now() - 30_000, events: [{ text: 'A goblin was defeated' }] }],
  revealedDeltas: [], cancelPreview: { rewards: [{ asset: { kind: 'currency', currency: 'currency:gold' }, qty: 3 }], consumablesUsed: [], consumablesReturned: [],
    keptProgress: [{ actorId: id, xpEarned: 4, died: false, deathPenaltyApplied: false }], converted: false } };
const failed: ExpeditionDto = { ...running, state: 'completed', endsAtMs: Date.now(), outcome: 'failed', summary: {
  segments: 3, encounters: 2, victories: 1, outcome: 'failed', gold: 11, xp: { [id]: 20 }, loot: { 'item:iron_shard': 2 },
  kills: {}, consumablesUsed: {}, deathLog: { actorId: id, encounter: 2, causes: [] },
} };
const completedReport = { availability: 'available' as const, effectiveDurationMs: 1_800_000, outcome: 'completed' as const, enemiesDefeated: 3,
  xp: { earned: 20, penaltyLost: 0, net: 20, beforeTotal: 100, afterTotal: 120 }, gold: { earned: 11, lost: 0, secured: 11 },
  loot: [{ item: 'item:iron_shard', earned: 2, lost: 0, secured: 2 }], consumables: [{ item: 'item:minor_healing_potion', used: 1, returned: 2 }],
  events: ['A goblin was defeated', 'Found Iron Shard ×2'], finalState: { hp: 6, maxHp: 10, xpTotal: 120 }, death: null };
const complete: ExpeditionDto = { ...running, state: 'completed', endsAtMs: Date.now(), outcome: { text: 'Victory' }, summary: { text: 'Returned safely' }, report: completedReport };
const deathReport = { ...completedReport, outcome: 'failed' as const, enemiesDefeated: 2,
  xp: { earned: 20, penaltyLost: 5, net: 15, beforeTotal: 100, afterTotal: 115 }, gold: { earned: 11, lost: 5, secured: 6 },
  loot: [{ item: 'item:iron_shard', earned: 2, lost: 1, secured: 1 }], events: ['A goblin was defeated', 'Ada fell in battle'],
  finalState: { hp: 0, maxHp: 10, xpTotal: 115 }, death: { causes: [{ key: 'idle.death.big_hit', enemy: 'enemy:goblin', amount: 12, crit: true }], suggestions: ['Consider a safer retreat threshold.'] } };

function props(apiOverrides: Partial<ApiClient> = {}, onCommand: (request: unknown) => Promise<unknown> = async () => running) {
  const api = { expeditionOptions: vi.fn(async () => options), expedition: vi.fn(async () => running),
    expeditionEstimate: vi.fn(() => new Promise(() => {})), ...apiOverrides } as unknown as ApiClient;
  return { api, character, canCommand: true, runCommand: onCommand as <T,>(request: { path: string }) => Promise<T>, refreshCharacter: vi.fn(async () => {}) };
}

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe('ExpeditionScreen', () => {
  it('keeps start locked when the server has no conquered activities', async () => {
    const deps = props({ expeditionOptions: vi.fn(async () => ({ ...options, areas: [{ areaId: 'area:ruins', kind: 'explorable', activities: [{ activityId: 'activity:ruins', simulatorId: 'sim:idle', available: false, reason: 'start.areaNotCompleted' }] }] })) });
    render(<ExpeditionScreen {...deps} />);
    expect(await screen.findByText(/No conquered expedition activities are available yet/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Start expedition' })).toBeNull();
  });

  it('starts from server-approved options, renders returned progress, then accepts the cancellation result', async () => {
    const requests: CommandRequest<ExpeditionDto>[] = [];
    const runCommand = async <T,>(request: CommandRequest<T>): Promise<T> => {
      requests.push(request as CommandRequest<ExpeditionDto>);
      return (request.envelope.operation === 'expedition.cancel' ? complete : running) as T;
    };
    const deps = props({}, runCommand as (request: unknown) => Promise<unknown>);
    render(<ExpeditionScreen {...deps} runCommand={runCommand} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start expedition' }));
    expect(await screen.findByRole('heading', { name: 'Ruins' })).toBeDefined();
    expect(requests[0]?.envelope.operation).toBe('expedition.start');
    expect(requests[0]?.envelope.payload).toMatchObject({ actorId: id, request: { areaId: 'area:ruins', activityId: 'activity:ruins', durationMin: 30, paceBp: 10_000 } });
    expect(screen.getByText('A goblin was defeated')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel expedition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByRole('heading', { name: 'Expedition completed' })).toBeDefined();
    expect(requests[1]?.envelope.operation).toBe('expedition.cancel');
  });

  it('retries an ambiguous start with the exact same command id and does not create a second start', async () => {
    const requests: CommandRequest<ExpeditionDto>[] = [];
    const runCommand = async <T,>(request: CommandRequest<T>): Promise<T> => {
      requests.push(request as CommandRequest<ExpeditionDto>);
      if (requests.length === 1) throw new CommandUnconfirmedError(request, new Error('acknowledgement lost'));
      return running as T;
    };
    const deps = props({}, runCommand as (request: unknown) => Promise<unknown>);
    render(<ExpeditionScreen {...deps} runCommand={runCommand} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start expedition' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry start' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.envelope.operation).toBe('expedition.start');
    expect(requests[1]?.envelope.operation).toBe('expedition.start');
    expect(requests[1]?.envelope.command_id).toBe(requests[0]?.envelope.command_id);
  });

  it('shows only revealed feed and keeps the server completion when cancel races the end', async () => {
    const refreshCharacter = vi.fn(async () => {});
    const deps = props({ expedition: vi.fn(async () => running) }, async () => complete);
    render(<ExpeditionScreen {...deps} character={{ ...character, activityState: 'expedition', activityId: id }} refreshCharacter={refreshCharacter} />);
    expect(await screen.findByText('A goblin was defeated')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel expedition' }));
    expect(screen.getByRole('dialog').textContent).toContain('Rewards kept');
    expect(screen.getByRole('dialog').textContent).toContain('Gold: 3');
    expect(screen.getByRole('dialog').textContent).toContain('XP earned: 4');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByRole('heading', { name: 'Expedition completed' })).toBeDefined();
    expect(screen.getByText('Completed')).toBeDefined();
    await waitFor(() => expect(refreshCharacter).toHaveBeenCalled());
  });

  it('reloads the latest terminal report from server history instead of rebuilding it from the local summary', async () => {
    const request = vi.fn(async () => [complete]);
    const deps = props({ request } as unknown as Partial<ApiClient>);
    render(<ExpeditionScreen {...deps} />);
    const report = await screen.findByRole('region', { name: 'Expedition completed' });
    expect(request).toHaveBeenCalledWith('GET', `/characters/${id}/expeditions`);
    expect(report.textContent).toContain('XP earned20');
    expect(report.textContent).toContain('A goblin was defeated');
    expect(report.textContent).not.toContain('Returned safely');
  });

  it('does not show actor A history or a late actor A response after switching to actor B', async () => {
    let resolveActorA!: (value: unknown) => void;
    let resolveActorB!: (value: unknown) => void;
    const initialRequest = vi.fn(async () => [complete]);
    const deps = props({ request: initialRequest } as unknown as Partial<ApiClient>);
    const view = render(<ExpeditionScreen {...deps} />);
    expect(await screen.findByRole('region', { name: 'Expedition completed' })).toBeDefined();

    const request = vi.fn((_method: string, path: string) => new Promise<unknown>((resolve) => {
      if (path.includes(character.actorId)) resolveActorA = resolve;
      else resolveActorB = resolve;
    }));
    const api = { ...deps.api, request } as unknown as ApiClient;
    view.rerender(<ExpeditionScreen {...deps} api={api} />);
    await waitFor(() => expect(resolveActorA).toBeDefined());

    const actorBId = '22222222-2222-4222-8222-222222222222';
    const actorB = { ...character, actorId: actorBId, accountId: actorBId };
    view.rerender(<ExpeditionScreen {...deps} api={api} character={actorB} />);
    await waitFor(() => expect(resolveActorB).toBeDefined());

    // A's history arrives after the switch and contains a terminal result. It must remain scoped to A.
    resolveActorA([complete]);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Expedition completed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go again' })).toBeNull();
    expect(screen.queryByText('A goblin was defeated')).toBeNull();

    resolveActorB([]);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Expedition completed' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Retry start' })).toBeNull();
  });

  it('shows unknown legacy history explicitly and keeps cancellation marked as partial', async () => {
    const legacy = { ...complete, id: '22222222-2222-4222-8222-222222222222', report: undefined };
    const request = vi.fn(async () => [legacy]);
    const deps = props({ request } as unknown as Partial<ApiClient>);
    render(<ExpeditionScreen {...deps} />);
    expect(await screen.findByText(/no saved result report/i)).toBeDefined();
    cleanup();

    const cancelled: ExpeditionDto = { ...complete, state: 'cancelled', outcome: 'cancelled', report: { ...completedReport, outcome: 'cancelled' } };
    const second = props({ request: vi.fn(async () => [cancelled]) } as unknown as Partial<ApiClient>);
    render(<ExpeditionScreen {...second} />);
    expect(await screen.findByText(/partial result settled through the server's revealed cutoff/i)).toBeDefined();
  });

  it('renders the persisted failed report and its evidence-backed suggestion', async () => {
    const deps = props({ expedition: vi.fn(async () => ({ ...failed, report: deathReport })) });
    render(<ExpeditionScreen {...deps} character={{ ...character, activityState: 'expedition', activityId: id }} />);
    const report = await screen.findByRole('region', { name: 'Expedition completed' });
    expect(report.textContent).toContain('XP earned20');
    expect(report.textContent).toContain('XP penalty lost5');
    expect(report.textContent).toContain('Net XP+15');
    expect(report.textContent).toContain('Gold secured6');
    expect(report.textContent).toContain('Earned 2 · lost 1 · secured 1');
    expect(report.textContent).toContain('Big Hit — Enemy: Goblin · Damage: 12 · Critical hit');
    expect(report.textContent).toContain('Consider a safer retreat threshold.');
  });

  it('offers exact escrow recovery for an unavailable policy and retries the same command id', async () => {
    const unavailable: ExpeditionDto = { ...running, recoveryAvailable: true };
    const recovered: ExpeditionDto = { id, actorId: id, state: 'cancelled', areaId: 'area:ruins', activityId: 'activity:ruins', startsAtMs: 0,
      plannedEndsAtMs: 1, progress: { revealed: 0 }, segments: [], revealedDeltas: [], endsAtMs: Date.now(), outcome: 'version_unavailable',
      terminalReport: { version: 1, kind: 'escrow_returned', summary: null, segments: [], revealedDeltas: {}, settledDeltas: [], xp: [], reason: 'version_unavailable', cutoff: null },
      report: { ...completedReport, availability: 'returned_escrow', outcome: 'version_unavailable', effectiveDurationMs: null, enemiesDefeated: null,
        xp: { earned: null, penaltyLost: null, net: null, beforeTotal: null, afterTotal: null }, gold: { earned: null, lost: null, secured: null },
        loot: null, consumables: null, events: null, finalState: { hp: null, maxHp: null, xpTotal: null }, death: null } };
    const requests: CommandRequest<ExpeditionDto>[] = [];
    const runCommand = async <T,>(request: CommandRequest<T>): Promise<T> => {
      requests.push(request as CommandRequest<ExpeditionDto>);
      if (requests.length === 1) throw new CommandUnconfirmedError(request, new Error('response lost'));
      return recovered as T;
    };
    const deps = props({ expedition: vi.fn(async () => unavailable) }, runCommand as (request: unknown) => Promise<unknown>);
    render(<ExpeditionScreen {...deps} character={{ ...character, activityState: 'expedition', activityId: id }} />);
    expect(await screen.findByText(/saved rules are no longer available/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Return consumables and end expedition' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry return and end expedition' }));
    expect(await screen.findByText(/The saved expedition version was unavailable. The server returned the escrow/)).toBeDefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.envelope.operation).toBe('expedition.recoverUnavailable');
    expect(requests[1]?.envelope.command_id).toBe(requests[0]?.envelope.command_id);
  });

  it('switches an unconfirmed cancel to a new recovery command after status reports unavailable policy', async () => {
    const unavailable: ExpeditionDto = { ...running, recoveryAvailable: true };
    const recovered: ExpeditionDto = { id, actorId: id, state: 'cancelled', areaId: 'area:ruins', activityId: 'activity:ruins', startsAtMs: 0,
      plannedEndsAtMs: 1, progress: { revealed: 0 }, segments: [], revealedDeltas: [], endsAtMs: Date.now(), outcome: 'version_unavailable',
      terminalReport: { version: 1, kind: 'escrow_returned', summary: null, segments: [], revealedDeltas: {}, settledDeltas: [], xp: [], reason: 'version_unavailable', cutoff: null },
      report: { ...completedReport, availability: 'returned_escrow', outcome: 'version_unavailable', effectiveDurationMs: null, enemiesDefeated: null,
        xp: { earned: null, penaltyLost: null, net: null, beforeTotal: null, afterTotal: null }, gold: { earned: null, lost: null, secured: null },
        loot: null, consumables: null, events: null, finalState: { hp: null, maxHp: null, xpTotal: null }, death: null } };
    const requests: CommandRequest<ExpeditionDto>[] = [];
    const runCommand = async <T,>(request: CommandRequest<T>): Promise<T> => {
      requests.push(request as CommandRequest<ExpeditionDto>);
      if (requests.length === 1) throw new CommandUnconfirmedError(request, new Error('response lost'));
      return recovered as T;
    };
    const api = { expedition: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(unavailable) };
    const deps = props(api, runCommand as (request: unknown) => Promise<unknown>);
    render(<ExpeditionScreen {...deps} character={{ ...character, activityState: 'expedition', activityId: id }} />);
    expect(await screen.findByRole('button', { name: 'Cancel expedition' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel expedition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByText(/saved rules are no longer available/i)).toBeDefined();
    const recoverButton = screen.getByRole('button', { name: 'Return consumables and end expedition' }) as HTMLButtonElement;
    await waitFor(() => expect(recoverButton.disabled).toBe(false));
    fireEvent.click(recoverButton);
    expect(await screen.findByText(/The saved expedition version was unavailable. The server returned the escrow/)).toBeDefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.envelope.operation).toBe('expedition.cancel');
    expect(requests[1]?.envelope.operation).toBe('expedition.recoverUnavailable');
    expect(requests[1]?.envelope.command_id).not.toBe(requests[0]?.envelope.command_id);
  });
});
