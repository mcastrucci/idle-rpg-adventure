import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpeditionDto, ExpeditionOptionsDto } from '@rpg/protocol';
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
const complete: ExpeditionDto = { ...running, state: 'completed', endsAtMs: Date.now(), outcome: { text: 'Victory' }, summary: { text: 'Returned safely' } };
const failed: ExpeditionDto = { ...running, state: 'completed', endsAtMs: Date.now(), outcome: 'failed', summary: {
  segments: 3, encounters: 2, victories: 1, outcome: 'failed', gold: 11, xp: { [id]: 20 }, loot: { 'item:iron_shard': 2 },
  kills: {}, consumablesUsed: {}, deathLog: { actorId: id, encounter: 2, causes: [] },
} };

function props(apiOverrides: Partial<ApiClient> = {}, onCommand: (request: unknown) => Promise<unknown> = async () => running) {
  const api = { expeditionOptions: vi.fn(async () => options), expedition: vi.fn(async () => running), ...apiOverrides } as unknown as ApiClient;
  return { api, character, canCommand: true, runCommand: onCommand as <T,>(request: { path: string }) => Promise<T>, refreshCharacter: vi.fn(async () => {}) };
}

afterEach(() => cleanup());

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
    expect(screen.getByText(/Outcome: Victory/)).toBeDefined();
    await waitFor(() => expect(refreshCharacter).toHaveBeenCalled());
  });

  it('labels failed-outcome totals as gross and explains death losses', async () => {
    const deps = props({ expedition: vi.fn(async () => failed) });
    render(<ExpeditionScreen {...deps} character={{ ...character, activityState: 'expedition', activityId: id }} />);
    expect(await screen.findByText('Gross gold found: 11')).toBeDefined();
    expect(screen.getByText('Character: 20 gross XP before penalties')).toBeDefined();
    expect(screen.getByText('Gross loot found: Iron Shard ×2')).toBeDefined();
    expect(screen.getByText(/50% of the expedition bag is lost \(loss rounded down\)/)).toBeDefined();
  });
});
