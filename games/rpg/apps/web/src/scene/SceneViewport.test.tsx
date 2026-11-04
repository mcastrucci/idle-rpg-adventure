import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneRenderer, SceneSpec } from '@engine/client-kit';

import { setLocale } from '../i18n/locale.ts';
import { SceneViewport } from './SceneViewport.tsx';

function fakeRenderer(mode: 'canvas' | 'fallback' = 'canvas') {
  const calls: string[] = [];
  const renderer: SceneRenderer = {
    mode,
    mount: vi.fn(() => Promise.resolve(mode)),
    loadScene: vi.fn((spec: SceneSpec) => { calls.push(`load:${spec.id}`); return Promise.resolve(); }),
    transitionTo: vi.fn((spec: SceneSpec) => { calls.push(`transition:${spec.id}`); return Promise.resolve({ status: 'completed' as const, prepareMs: 0, animationMs: 0 }); }),
    setRegions: vi.fn(),
    resize: vi.fn(),
    setReducedMotion: vi.fn(),
    on: vi.fn(() => () => undefined),
    destroy: vi.fn(),
  };
  return { renderer, calls };
}

const buildScene = (id: string): SceneSpec => ({ id, background: { key: id, width: 4, height: 4, load: () => Promise.reject(new Error('unused')) }, layers: [], regions: [] });

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SceneViewport', () => {
  it('loads the scene for the location, then transitions when the location changes', async () => {
    const { renderer, calls } = fakeRenderer();
    const create = () => renderer;
    const view = render(<SceneViewport locationId="location:a" createRenderer={create} buildScene={buildScene} />);
    await flush();
    view.rerender(<SceneViewport locationId="location:a" createRenderer={create} buildScene={buildScene} />);
    view.rerender(<SceneViewport locationId="location:b" createRenderer={create} buildScene={buildScene} />);
    await flush();
    expect(calls).toEqual(['load:location:a', 'transition:location:b']);
  });

  it('is decorative: hidden from assistive technology and without text', async () => {
    const { renderer } = fakeRenderer();
    const { container } = render(<SceneViewport locationId="location:a" createRenderer={() => renderer} buildScene={buildScene} />);
    await flush();
    const viewport = container.querySelector('.scene-viewport');
    expect(viewport?.getAttribute('aria-hidden')).toBe('true');
    expect(viewport?.textContent).toBe('');
  });

  it('passes the reduced-motion preference to the renderer and follows changes', async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: (_: string, l: typeof listener) => { listener = l; }, removeEventListener: () => undefined }));
    const { renderer } = fakeRenderer();
    render(<SceneViewport locationId="location:a" createRenderer={() => renderer} buildScene={buildScene} />);
    await flush();
    expect(renderer.setReducedMotion).toHaveBeenLastCalledWith(true);
    listener?.({ matches: false } as MediaQueryListEvent);
    expect(renderer.setReducedMotion).toHaveBeenLastCalledWith(false);
  });

  it('shows a localized note and loads no scene when WebGL is unavailable', async () => {
    const { renderer } = fakeRenderer('fallback');
    const { container } = render(<SceneViewport locationId="location:a" createRenderer={() => renderer} buildScene={buildScene} />);
    await flush();
    expect(screen.getByText('Scene view unavailable on this device. Use the controls below.')).toBeTruthy();
    expect(container.querySelector('.scene-viewport')?.hasAttribute('hidden')).toBe(true);
    expect(renderer.loadScene).not.toHaveBeenCalled();
    cleanup();
    setLocale('es', { persist: false });
    const { renderer: second } = fakeRenderer('fallback');
    render(<SceneViewport locationId="location:a" createRenderer={() => second} buildScene={buildScene} />);
    await flush();
    expect(screen.getByText(/La vista de escena no está disponible/)).toBeTruthy();
  });

  it('destroys the renderer on unmount', async () => {
    const { renderer } = fakeRenderer();
    const view = render(<SceneViewport locationId="location:a" createRenderer={() => renderer} buildScene={buildScene} />);
    await flush();
    view.unmount();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the DOM-only view with the real renderer when the browser has no WebGL', async () => {
    const { container } = render(<SceneViewport locationId="location:a" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('.scene-viewport')?.getAttribute('data-mode')).toBe('fallback');
  });
});
