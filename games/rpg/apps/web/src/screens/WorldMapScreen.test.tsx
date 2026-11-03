import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { ApiClient } from '../api/http.ts';
import type { FetchLike } from '../api/http.ts';
import type { WorldViewDTO } from '@rpg/protocol';
import { WorldMapScreen } from './WorldMapScreen.tsx';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const knownArea: WorldViewDTO['areas'][number] = {
  id: 'area:region_1', label: 'area.region_1.name', visibility: 'known' as const, position: { x: 0, y: 100 }, lockedReasons: [],
  completion: { discovered: 3, required: 6, completed: false,
    mandatoryBosses: { required: 1, defeated: 0, complete: false, bosses: [{ label: 'Mandatory boss', defeated: false }] } },
  danger: { status: 'known' as const, minLevel: 1, maxLevel: 5 },
  idle: { unlocked: false, activities: [] }, actions: { enterLive: true, startIdle: false },
};
const view: WorldViewDTO = { hub: { id: 'area:sanctuary', label: 'area.sanctuary.name', position: { x: 0, y: 0 } }, areas: [knownArea],
  routes: [{ id: 'route:sanctuary-region1', from: 'area:sanctuary', to: 'area:region_1' }] };

function renderMap(result: unknown = view) {
  const fetch: FetchLike = vi.fn(async () => result instanceof Error
    ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(result));
  const api = new ApiClient(fetch);
  const onEnterLive = vi.fn();
  const onStartIdle = vi.fn();
  const rendered = render(<WorldMapScreen actorId={actorId} characterLevel={3} api={api} onEnterLive={onEnterLive}
    onStartIdle={onStartIdle} liveActive={false} idleActive={false} />);
  return { ...rendered, api, onEnterLive, onStartIdle, fetch };
}

afterEach(cleanup);

describe('WorldMapScreen', () => {
  it('shows accessible loading and empty states', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetch: FetchLike = () => new Promise((done) => { resolve = done; });
    const api = new ApiClient(fetch);
    render(<WorldMapScreen actorId={actorId} characterLevel={1} api={api} onEnterLive={() => {}} onStartIdle={() => {}}
      liveActive={false} idleActive={false} />);
    expect(screen.getByRole('status').textContent).toContain('Reading the explored paths');
    const empty = { hub: view.hub, areas: [], routes: [] };
    await act(async () => { resolve?.(Response.json(empty)); });
    expect(await screen.findByText('No paths are visible yet.')).toBeDefined();
  });

  it('shows server progress, mandatory boss status, authored level band, and readable lock reasons without hidden content', async () => {
    const lockedArea = { id: 'area:fracture_2', label: 'area.fracture_2.name', visibility: 'locked' as const, position: { x: 30, y: 180 },
      lockedReasons: ['requires.game.levelAtLeast'], completion: null, danger: { status: 'unknown' as const },
      idle: { unlocked: false, activities: [] }, actions: { enterLive: false, startIdle: false } };
    const { onEnterLive, onStartIdle } = renderMap({ ...view, areas: [knownArea, lockedArea] });
    const portal = await screen.findByRole('button', { name: /Verdant Hollow, Required locations 3 \/ 6/ });
    fireEvent.keyDown(portal, { key: 'Enter' });
    expect(await screen.findByText('Required locations: 3 / 6')).toBeDefined();
    expect(screen.getByText('Mandatory bosses')).toBeDefined();
    expect(screen.getByText('0 / 1 defeated')).toBeDefined();
    expect(screen.getByText('Your level 3 · Recommended 1–5')).toBeDefined();
    expect(onEnterLive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Fracture 2, Locked/ }));
    await waitFor(() => expect(screen.getAllByText('Reach the required level first.')).toHaveLength(1));
    expect(screen.queryByText(/Secret archive|sunken_greenhouse/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Verdant Hollow, Required locations 3 \/ 6/ }));
    expect(screen.getAllByRole('button', { name: 'Enter live' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Enter live' }));
    expect(onEnterLive).toHaveBeenCalledWith('area:region_1');
    expect(onStartIdle).not.toHaveBeenCalled();
  });

  it('keeps 44px targets and reduced-motion behavior in the mobile map styles', () => {
    const css = readFileSync('engine/client-kit/src/world-map.css', 'utf8');
    const appCss = readFileSync('games/rpg/apps/web/src/screens/world-map.css', 'utf8');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('@media (max-width: 420px)');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(appCss).toContain('.world-tab:not([hidden])');
  });

  it('does not celebrate permanent conquest on initial read or reload, only on an observed false-to-true transition', async () => {
    let current = view;
    let calls = 0;
    const fetch: FetchLike = async () => { calls++; return Response.json(current); };
    const api = new ApiClient(fetch);
    const screenView = (refreshKey: string) => <WorldMapScreen actorId={actorId} characterLevel={3} api={api}
      onEnterLive={() => {}} onStartIdle={() => {}} liveActive={false} idleActive={false} refreshKey={refreshKey} />;
    const rendered = render(screenView('first'));
    await screen.findByRole('button', { name: /Verdant Hollow/ });
    expect(calls).toBe(1);
    expect(rendered.container.querySelector('.world-map-celebration')).toBeNull();

    const conquered: WorldViewDTO['areas'][number] = { ...knownArea, completion: { discovered: 6, required: 6, completed: true,
      mandatoryBosses: { required: 1, defeated: 1, complete: true, bosses: [{ label: 'Hollow Matriarch', defeated: true }] } },
      idle: { unlocked: true, activities: ['idle:region_1.hunt'] }, actions: { enterLive: true, startIdle: true } };
    current = { ...view, areas: [conquered] };
    rendered.rerender(screenView('returned-from-live'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The Verdant Hollow conquered. Idle expeditions are now available.'));
    expect(calls).toBe(2);
    rendered.rerender(screenView('reload'));
    await waitFor(() => expect(rendered.container.querySelector('.world-map-celebration')).toBeNull());
    expect(calls).toBe(3);
  });

  it('does not fetch while inactive and announces conquest when returning to the visible map', async () => {
    let current = view;
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return Response.json(current); });
    const screenView = (active: boolean, refreshKey: string) => <WorldMapScreen actorId={actorId} characterLevel={3} api={api}
      onEnterLive={() => {}} onStartIdle={() => {}} liveActive={false} idleActive={false} active={active} refreshKey={refreshKey} />;
    const rendered = render(screenView(true, 'visible:level-3:none'));
    await screen.findByRole('button', { name: /Verdant Hollow/ });
    expect(calls).toBe(1);

    rendered.rerender(screenView(false, 'live:level-3:live'));
    expect(calls).toBe(1);
    const conquered: WorldViewDTO['areas'][number] = { ...knownArea,
      completion: { discovered: 6, required: 6, completed: true,
        mandatoryBosses: { required: 1, defeated: 1, complete: true, bosses: [{ label: 'Hollow Matriarch', defeated: true }] } },
      idle: { unlocked: true, activities: ['idle:region_1.hunt'] }, actions: { enterLive: false, startIdle: false } };
    current = { ...view, areas: [conquered] };

    rendered.rerender(screenView(false, 'hidden:level-4:none'));
    expect(calls).toBe(1);
    rendered.rerender(screenView(true, 'visible:level-4:none'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The Verdant Hollow conquered.'));
    expect(calls).toBe(2);

    rendered.rerender(screenView(false, 'live:level-4:live'));
    rendered.rerender(screenView(true, 'visible:level-4:none'));
    await waitFor(() => expect(calls).toBe(3));
    expect(rendered.container.querySelectorAll('.world-map-celebration')).toHaveLength(0);
  });

  it('does not celebrate completion already present on first activation', async () => {
    const complete: WorldViewDTO['areas'][number] = { ...knownArea,
      completion: { discovered: 6, required: 6, completed: true,
        mandatoryBosses: { required: 1, defeated: 1, complete: true, bosses: [{ label: 'Hollow Matriarch', defeated: true }] } },
      idle: { unlocked: true, activities: ['idle:region_1.hunt'] }, actions: { enterLive: false, startIdle: false } };
    const api = new ApiClient(async () => Response.json({ ...view, areas: [complete] }));
    const screenView = (active: boolean) => <WorldMapScreen actorId={actorId} characterLevel={3} api={api}
      onEnterLive={() => {}} onStartIdle={() => {}} liveActive={false} idleActive={false} active={active} />;
    const rendered = render(screenView(false));
    expect(rendered.container.querySelector('.world-map-celebration')).toBeNull();
    rendered.rerender(screenView(true));
    await screen.findByRole('button', { name: /Verdant Hollow/ });
    expect(rendered.container.querySelector('.world-map-celebration')).toBeNull();
  });

  it('reports read failures and retries the same server-owned map read', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return calls === 1 ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(view);
    };
    const api = new ApiClient(fetch);
    render(<WorldMapScreen actorId={actorId} characterLevel={1} api={api} onEnterLive={() => {}} onStartIdle={() => {}}
      liveActive={false} idleActive={false} />);
    expect(await screen.findByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Verdant Hollow/ })).toBeDefined();
    expect(calls).toBe(2);
  });
});
