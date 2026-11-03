// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { WorldMap } from './world-map.tsx';
import type { WorldMapLabels } from './world-map.tsx';
import type { WorldMapView } from './world-map-types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const labels: WorldMapLabels = {
  mapLabel: 'World map',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetZoom: 'Reset zoom',
  hubAction: 'Open hub',
  enterArea: 'Enter area',
  startIdle: 'Start idle activity',
  completion: 'Completion',
  locked: 'Locked',
  idleAvailable: 'Idle available',
  closeDetails: 'Close details',
};

const view: WorldMapView = {
  hub: { id: 'hub:sanctuary', label: 'Sanctuary', position: { x: 500, y: 310 } },
  areas: [
    {
      id: 'area:known',
      label: 'Mosswood',
      visibility: 'known',
      position: { x: 760, y: 310 },
      lockedReasons: [],
      completion: { complete: 4, required: 7, completed: false },
      idleAvailable: true,
      actions: { enter: true, startIdle: true },
    },
    {
      id: 'area:locked',
      label: 'Frost Hollow',
      visibility: 'locked',
      position: { x: 240, y: 310 },
      lockedReasons: ['Complete Mosswood first'],
      actions: { enter: true, startIdle: true },
    },
  ],
  routes: [
    { id: 'hub-known', from: 'hub:sanctuary', to: 'area:known' },
    { id: 'known-locked', from: 'area:known', to: 'area:locked' },
    { id: 'hidden', from: 'area:locked', to: 'area:hidden' },
  ],
};

function setMapBounds() {
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 360,
    bottom: 223.2,
    width: 360,
    height: 223.2,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('WorldMap', () => {
  it('selects the hub and visible areas from keyboard input without invoking area actions', () => {
    const onSelectHub = vi.fn();
    const onSelectArea = vi.fn();
    const onEnterArea = vi.fn();
    const { container } = render(<WorldMap view={view} labels={labels} onSelectHub={onSelectHub} onSelectArea={onSelectArea} onEnterArea={onEnterArea} />);
    expect(container.querySelectorAll('.world-map__route').length).toBe(2);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Sanctuary' }), { key: 'Enter' });
    expect(onSelectHub).toHaveBeenCalledWith('hub:sanctuary');
    expect(screen.getByRole('heading', { name: 'Sanctuary' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('button', { name: /Mosswood/ }), { key: 'Enter' });
    expect(onSelectArea).toHaveBeenCalledWith('area:known');
    expect(onEnterArea).not.toHaveBeenCalled();
    expect(screen.getByText('Completion: 4 / 7')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter area' })).toBeTruthy();
  });

  it('shows a known locked reason and suppresses action buttons even if a projection has action flags set', () => {
    const onEnterArea = vi.fn();
    render(<WorldMap view={view} labels={labels} onEnterArea={onEnterArea} />);

    fireEvent.click(screen.getByRole('button', { name: 'Frost Hollow, Locked' }));
    expect(screen.getByText('Complete Mosswood first')).toBeTruthy();
    const enterButton = screen.getByRole('button', { name: 'Enter area' }) as HTMLButtonElement;
    expect(enterButton.disabled).toBe(true);
    expect(enterButton.getAttribute('aria-describedby')).not.toBeNull();
    fireEvent.click(enterButton);
    expect(screen.queryByRole('button', { name: 'Start idle activity' })).toBeNull();
    expect(onEnterArea).not.toHaveBeenCalled();
  });

  it('renders inverse-scaled 44px hit areas, legible labels, and node-centered completion rings at 360px', () => {
    setMapBounds();
    const { container } = render(<WorldMap view={view} labels={labels} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('World map SVG was not rendered');

    const areaNode = screen.getByRole('button', { name: /Mosswood/ });
    const hit = areaNode.querySelector('.world-map__hit-area');
    const nodeLabel = areaNode.querySelector('.world-map__node-label');
    const ring = areaNode.querySelector('.world-map__completion-ring');
    const mapScale = 360 / 1000;
    const hubLabel = container.querySelector('.world-map__hub .world-map__node-label');
    const lockedLabel = screen.getByRole('button', { name: /Frost Hollow/ }).querySelector('.world-map__node-label');

    expect(Number(hit?.getAttribute('r')) * mapScale).toBeCloseTo(22);
    expect(Number.parseFloat((nodeLabel as SVGTextElement).style.fontSize) * mapScale).toBeCloseTo(13);
    expect(ring?.getAttribute('transform')).toBe('rotate(-90 0 0)');
    expect(Number(hubLabel?.getAttribute('y'))).toBeLessThan(0);
    expect(Number(lockedLabel?.getAttribute('y'))).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomedHit = areaNode.querySelector('.world-map__hit-area');
    const zoomedLabel = areaNode.querySelector('.world-map__node-label') as SVGTextElement;
    expect(Number(zoomedHit?.getAttribute('r')) * mapScale * 1.25).toBeCloseTo(22);
    expect(Number.parseFloat(zoomedLabel.style.fontSize) * mapScale * 1.25).toBeCloseTo(13);
  });

  it('pans and pinches through the actual SVG pointer path', () => {
    setMapBounds();
    const { container } = render(<WorldMap view={view} labels={labels} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('World map SVG was not rendered');
    const viewport = container.querySelector('.world-map__viewport');
    if (!viewport) throw new Error('World map viewport group was not rendered');

    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'touch', clientX: 136, clientY: 118 });
    expect(viewport?.getAttribute('transform')).toContain('translate(100 50) scale(1)');
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'touch', clientX: 136, clientY: 118 });

    fireEvent.pointerDown(svg, { pointerId: 2, pointerType: 'touch', clientX: 90, clientY: 110 });
    fireEvent.pointerDown(svg, { pointerId: 3, pointerType: 'touch', clientX: 190, clientY: 110 });
    fireEvent.pointerMove(svg, { pointerId: 3, pointerType: 'touch', clientX: 240, clientY: 110 });
    expect(viewport?.getAttribute('transform')).toContain('scale(1.5)');
    fireEvent.pointerUp(svg, { pointerId: 2, pointerType: 'touch', clientX: 90, clientY: 110 });
    fireEvent.pointerUp(svg, { pointerId: 3, pointerType: 'touch', clientX: 240, clientY: 110 });
  });
});
