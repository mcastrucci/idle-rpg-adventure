import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpeditionDto, ExpeditionEstimateDto, ExpeditionEstimateRequest, ExpeditionOptionsDto } from '@rpg/protocol';
import type { CommandRequest } from '../api/commands.ts';
import { ApiError } from '../api/http.ts';
import type { ApiClient } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { ExpeditionScreen } from './ExpeditionScreen.tsx';
import { loadLastExpedition, saveLastExpedition } from './expedition/lastExpedition.ts';

const id = '11111111-1111-4111-8111-111111111111';
const POTION = 'item:minor_healing_potion';
const character: CharacterDto = { actorId: id, accountId: id, gameId: 'rpg', name: 'Ada', level: 1, xp: 0,
  attributes: { STR: 1, AGI: 1, INT: 1, VIT: 1, SPI: 1 }, unspentPoints: 0, skillLoadout: ['skill:mend'],
  automationRules: [{ when: { selfHpBelowBp: 4000 }, do: { useSkill: 'skill:mend', target: 'self' } }, { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } }],
  activityState: 'none', activityId: null, version: 1 };
const options: ExpeditionOptionsDto = { actorId: id,
  areas: [{ areaId: 'area:region_1', kind: 'explorable', activities: [
    { activityId: 'idle:region_1.hunt', simulatorId: 'rpg.hunt', available: true }, { activityId: 'idle:region_1.gather', simulatorId: 'rpg.gather', available: true }] }],
  durationsMin: [15, 30, 60, 180], paceBp: { min: 10_000, max: 10_000, default: 10_000 }, consumables: [{ item: POTION, availableQty: 3 }] };
const estimate: ExpeditionEstimateDto = { estimate: true, actorId: id, areaId: 'area:region_1', activityId: 'idle:region_1.hunt', durationMin: 30, paceBp: 10_000,
  n: 166, xp: { p10: 289, p50: 324, p90: 368 }, gold: { p10: 12, p50: 20, p90: 31 }, consumablesUsed: [], outcomeRatesBp: { completed: 9_150, retreated: 0, died: 850 }, cached: false };
const running: ExpeditionDto = { id, actorId: id, state: 'running', areaId: 'area:region_1', activityId: 'idle:region_1.hunt', startsAtMs: Date.now(),
  plannedEndsAtMs: Date.now() + 60_000, progress: { revealed: 0 }, segments: [], revealedDeltas: [],
  cancelPreview: { rewards: [], consumablesUsed: [], consumablesReturned: [], keptProgress: [], converted: false } };

function setup(overrides: { estimateImpl?: (actorId: string, body: ExpeditionEstimateRequest) => Promise<ExpeditionEstimateDto>; debounceMs?: number } = {}) {
  const expeditionEstimate = vi.fn(overrides.estimateImpl ?? (async (_actorId: string, body: ExpeditionEstimateRequest) => ({ ...estimate, ...body.request })));
  const api = { expeditionOptions: vi.fn(async () => options), expedition: vi.fn(async () => running), expeditionEstimate } as unknown as ApiClient;
  const requests: CommandRequest<ExpeditionDto>[] = [];
  const runCommand = async <T,>(request: CommandRequest<T>): Promise<T> => { requests.push(request as CommandRequest<ExpeditionDto>); return running as T; };
  render(<ExpeditionScreen character={character} canCommand api={api} runCommand={runCommand} refreshCharacter={async () => {}} estimateDebounceMs={overrides.debounceMs ?? 10} />);
  return { expeditionEstimate, requests };
}

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe('Expedition setup screen', () => {
  it('walks region → activity → duration chips → consumables → rules preview → estimate card → Start', async () => {
    const { expeditionEstimate, requests } = setup();
    const card = await screen.findByRole('region', { name: 'Estimated outcome' });
    await within(card).findByText('324 (289–368)');
    expect(within(card).getByText('Estimate')).toBeDefined();
    expect(within(card).getByText(/Estimate from 166 simulated runs/)).toBeDefined();
    expect(within(card).getByText('20 (12–31)')).toBeDefined();
    expect(within(card).getByText('8.5%')).toBeDefined();
    expect(within(card).getByText('None brought')).toBeDefined();
    // The estimate asks for exactly what Start would send: request + config, never stats.
    expect(expeditionEstimate).toHaveBeenLastCalledWith(id, { request: { areaId: 'area:region_1', activityId: 'idle:region_1.hunt', durationMin: 30, paceBp: 10_000 },
      config: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } });

    const rules = screen.getByRole('region', { name: 'Automation rules' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(2);
    expect(within(rules).getByRole('link', { name: 'Edit automation rules' }).getAttribute('href')).toBe('#/character/rules');

    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'idle:region_1.gather' } });
    fireEvent.click(screen.getByRole('button', { name: '3 h' }));
    expect(screen.getByRole('button', { name: '3 h' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Consumable (optional)'), { target: { value: POTION } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    await waitFor(() => expect(expeditionEstimate).toHaveBeenLastCalledWith(id, { request: { areaId: 'area:region_1', activityId: 'idle:region_1.gather', durationMin: 180, paceBp: 10_000 },
      config: { consumables: [{ item: POTION, qty: 2 }], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } }));

    fireEvent.click(screen.getByRole('button', { name: 'Start expedition' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope.payload).toEqual({ actorId: id, request: { areaId: 'area:region_1', activityId: 'idle:region_1.gather', durationMin: 180, paceBp: 10_000 },
      config: { consumables: [{ item: POTION, qty: 2 }], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } });
    expect(loadLastExpedition(id)).toEqual({ request: { areaId: 'area:region_1', activityId: 'idle:region_1.gather', durationMin: 180, paceBp: 10_000 },
      config: { consumables: [{ item: POTION, qty: 2 }], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } });
  });

  it('debounces estimate requests while the setup is changing', async () => {
    const { expeditionEstimate } = setup({ debounceMs: 250 });
    const chip = await screen.findByRole('button', { name: '15 min' });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: '1 h' }));
    fireEvent.click(screen.getByRole('button', { name: '3 h' }));
    expect(screen.getByRole('status').textContent).toBe('Estimating…');
    await waitFor(() => expect(expeditionEstimate).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(expeditionEstimate.mock.calls[0]?.[1].request.durationMin).toBe(180);
    await screen.findByText(/Estimate from 166 simulated runs/);
    expect(expeditionEstimate).toHaveBeenCalledTimes(1);
  });

  it('shows estimate errors with a retry', async () => {
    let fail = true;
    const { expeditionEstimate } = setup({ estimateImpl: async () => { if (fail) throw new ApiError(503, 'estimate_busy'); return estimate; } });
    expect(await screen.findByText(/Could not estimate this expedition/)).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry estimate' }));
    expect(await screen.findByText('324 (289–368)')).toBeDefined();
    expect(expeditionEstimate).toHaveBeenCalledTimes(2);
  });

  it('repeats the last started expedition with one tap', async () => {
    const last = { request: { areaId: 'area:region_1', activityId: 'idle:region_1.gather', durationMin: 60, paceBp: 10_000 },
      config: { consumables: [{ item: POTION, qty: 1 }], retreat: { belowHpBp: 2_500, onlyWhenNoHealing: true } } };
    saveLastExpedition(id, last);
    const { requests } = setup();
    const card = await screen.findByRole('region', { name: 'Last expedition' });
    expect(card.textContent).toContain('Gather · Region 1 · 1 h · Minor Healing Potion ×1');
    fireEvent.click(within(card).getByRole('button', { name: 'Repeat last expedition' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope.operation).toBe('expedition.start');
    expect(requests[0]?.envelope.payload).toEqual({ actorId: id, ...last });
  });

  it('disables repeat when the saved loadout is no longer possible', async () => {
    saveLastExpedition(id, { request: { areaId: 'area:region_1', activityId: 'idle:region_1.hunt', durationMin: 30, paceBp: 10_000 },
      config: { consumables: [{ item: POTION, qty: 9 }], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } });
    setup();
    const card = await screen.findByRole('region', { name: 'Last expedition' });
    expect(within(card).getByText(/Not enough consumables/)).toBeDefined();
    expect((within(card).getByRole('button', { name: 'Repeat last expedition' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
