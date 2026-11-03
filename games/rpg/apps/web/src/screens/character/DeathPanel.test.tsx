import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../../api/http.ts';
import type { FetchLike } from '../../api/http.ts';
import type { LiveServerFrame } from '@rpg/protocol';
import type { LiveClient } from '../../live/client.ts';
import { DeathPanel, ProvisionalLiveRiskNotice } from './DeathPanel.tsx';

const DEATH = {
  deathId: '33333333-3333-4333-8333-333333333333', occurredAt: Date.UTC(2026, 10, 3, 12), areaId: 'area:ruins', locationId: 'location:crypt',
  xpBefore: { level: 3, xpIntoLevel: 90, totalXp: 290 }, xpLost: 10,
  xpAfter: { level: 3, xpIntoLevel: 80, totalXp: 280 },
  causes: [{ sourceId: 'enemy:wraith', label: 'Wraith', damage: 24 }, { sourceId: 'enemy:shade', label: 'Shade', damage: 8 }],
  corpse: { id: '33333333-3333-4333-8333-333333333333', status: 'active', expiresAt: Date.UTC(2026, 10, 4, 12), contents: {
    stacks: [{ item: 'item:herb', qty: 2 }], gold: 7,
    uniques: [{ itemId: '44444444-4444-4444-8444-444444444444', definition: 'Copper ring', slot: 'finger', rolls: {} }],
  } },
};

function api(response: unknown, before?: () => Promise<Response>): ApiClient {
  const fetch: FetchLike = async () => before ? before() : Response.json(response);
  return new ApiClient(fetch);
}

describe('DeathPanel', () => {
  afterEach(() => cleanup());

  it('shows loading, reports a fetch failure and retries', async () => {
    let fail = true;
    const client = api({ death: null }, async () => {
      if (fail) throw new Error('offline');
      return Response.json({ death: null });
    });
    render(<DeathPanel actorId="actor-1" api={client} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByRole('alert')).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No recent live death.')).toBeDefined();
  });

  it('shows an honest empty state', async () => {
    render(<DeathPanel actorId="actor-1" api={api({ death: null })} />);
    expect(await screen.findByText('No recent live death.')).toBeDefined();
  });

  it('states the draft live death consequences as provisional for a future risk entry point', () => {
    render(<ProvisionalLiveRiskNotice />);
    expect(screen.getByRole('heading', { name: 'Death consequences · provisional' })).toBeDefined();
    expect(screen.getByText(/apply an XP loss of 10% of the XP required for the next level/)).toBeDefined();
    expect(screen.getByText(/Your run bag moves to a corpse for 24 hours/)).toBeDefined();
  });

  it('loads the durable record after a remount and shows server consequences and active recovery guidance', async () => {
    let reads = 0;
    const client = api(null, async () => { reads++; return Response.json({ death: DEATH }); });
    const first = render(<DeathPanel actorId="actor-1" api={client} />);
    expect(await screen.findByText('Wraith · 24 damage')).toBeDefined();
    expect(screen.getByText(/Lost 10 XP/).textContent).toContain('total XP 290 → 280.');
    expect(screen.getByText(/Lost 10 XP/).textContent).toContain('Level 3 → 3; XP in level 90 → 80.');
    expect(screen.getByText('Copper ring')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
    expect(screen.getByText(/Sanctuary alone cannot recover it/)).toBeDefined();
    expect(screen.getByText(/remains at risk until you return to Sanctuary/)).toBeDefined();
    first.unmount();
    render(<DeathPanel actorId="actor-1" api={client} />);
    expect(await screen.findByText('Wraith · 24 damage')).toBeDefined();
    expect(reads).toBe(2);
  });

  it('does not invent a cause when the server has no attributable damage', async () => {
    render(<DeathPanel actorId="actor-1" api={api({ death: { ...DEATH, causes: [] } })} />);
    expect(await screen.findByText(/Damage source details are unavailable for this fight/)).toBeDefined();
  });

  it('refreshes only for this actor’s committed death/recovery events and after any terminal close', async () => {
    const listeners = new Set<(frame: LiveServerFrame) => void>();
    let reads = 0;
    const client = api(null, async () => { reads++; return Response.json({ death: DEATH }); });
    const live = { subscribeFrames(listener: (frame: LiveServerFrame) => void) {
      listeners.add(listener); return () => listeners.delete(listener);
    } } as Pick<LiveClient, 'subscribeFrames'>;
    render(<DeathPanel actorId="actor-1" api={client} live={live} />);
    await screen.findByText('Wraith · 24 damage');
    expect(reads).toBe(1);
    const emit = (frame: LiveServerFrame) => { for (const listener of listeners) listener(frame); };
    act(() => emit({ type: 'live.event', instanceId: 'i', epoch: 1, seq: 1, source: 'game',
      event: { type: 'heroDied', actorId: 'actor-2', causes: [] } } as never));
    expect(reads).toBe(1);
    act(() => emit({ type: 'live.event', instanceId: 'i', epoch: 1, seq: 2, source: 'host',
      event: { type: 'heroDied', actorId: 'actor-1', causes: [] } } as never));
    expect(reads).toBe(1);
    act(() => emit({ type: 'live.event', instanceId: 'i', epoch: 1, seq: 3, source: 'game',
      event: { type: 'heroDied', actorId: 'actor-1', causes: [] } } as never));
    await waitFor(() => expect(reads).toBe(2));
    act(() => emit({ type: 'live.event', instanceId: 'i', epoch: 1, seq: 4, source: 'game',
      event: { type: 'corpseRecovered', actorId: 'actor-2', corpseId: 'corpse-2', repeat: false } } as never));
    expect(reads).toBe(2);
    act(() => emit({ type: 'live.event', instanceId: 'i', epoch: 1, seq: 5, source: 'game',
      event: { type: 'corpseRecovered', actorId: 'actor-1', corpseId: 'corpse-1', repeat: false } } as never));
    await waitFor(() => expect(reads).toBe(3));
    act(() => emit({ type: 'live.closed', instanceId: 'i', outcome: 'returned', result: {} }));
    await waitFor(() => expect(reads).toBe(4));
  });

  it.each(['expired', 'recovered'] as const)('explains a %s corpse without implying it is still recoverable', async (status) => {
    const death = { ...DEATH, corpse: { ...DEATH.corpse, status } };
    render(<DeathPanel actorId="actor-1" api={api({ death })} />);
    expect(await screen.findByRole('heading', { name: `Corpse · ${status}` })).toBeDefined();
    if (status === 'expired') expect(screen.getByText(/can no longer be recovered/)).toBeDefined();
    else expect(screen.getByText(/has been recovered/)).toBeDefined();
    expect(screen.queryByText(/Enter a new live instance/)).toBeNull();
  });
});
