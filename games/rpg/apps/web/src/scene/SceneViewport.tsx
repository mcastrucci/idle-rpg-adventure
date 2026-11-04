import { useEffect, useRef, useState } from 'react';
import { createSceneRenderer } from '@engine/client-kit';
import type { SceneRenderer, SceneRendererMode, SceneSpec } from '@engine/client-kit';

import { t, useLocale } from '../i18n/index.ts';
import { sceneForLocation } from './placeholderScene.ts';
import './scene-viewport.css';

type Props = {
  /** Current location ID from the server's live view. The viewport never decides anything, it only illustrates. */
  locationId: string | undefined;
  /** Test seams. */
  createRenderer?: () => SceneRenderer;
  buildScene?: (locationId: string) => SceneSpec;
};

const REDUCE_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Illustrated scene above the live DOM controls. Purely decorative and hidden from assistive technology: the DOM
 * navigation and actions stay the accessible source of truth. Falls back to nothing (plus a short note) when WebGL
 * is unavailable.
 */
export function SceneViewport({ locationId, createRenderer = createSceneRenderer, buildScene = sceneForLocation }: Props) {
  useLocale();
  const host = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const [renderer, setRenderer] = useState<SceneRenderer | null>(null);
  const [mode, setMode] = useState<SceneRendererMode | 'pending'>('pending');

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const next = createRenderer();
    let cancelled = false;
    shown.current = false;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_MOTION) : null;
    next.setReducedMotion(media?.matches ?? false);
    const onMotionChange = (event: MediaQueryListEvent) => next.setReducedMotion(event.matches);
    media?.addEventListener?.('change', onMotionChange);
    void next.mount(element).then((result) => {
      if (cancelled) return;
      setMode(result);
      if (result === 'canvas') setRenderer(next);
    });
    return () => {
      cancelled = true;
      media?.removeEventListener?.('change', onMotionChange);
      setRenderer(null);
      next.destroy();
    };
  }, [createRenderer]);

  useEffect(() => {
    if (!renderer || !locationId) return;
    const spec = buildScene(locationId);
    // First scene appears at once; later location changes preload the next scene and then fade to it.
    const job = shown.current ? renderer.transitionTo(spec) : renderer.loadScene(spec);
    shown.current = true;
    job.catch(() => undefined); // A scene that fails to load leaves the previous one on screen; the DOM view is unaffected.
  }, [renderer, locationId, buildScene]);

  return <>
    <div className="scene-viewport" ref={host} aria-hidden="true" hidden={mode === 'fallback'} data-scene={locationId} data-mode={mode} />
    {mode === 'fallback' && <p className="muted scene-viewport__note">{t('ui.live.viewport_fallback')}</p>}
  </>;
}
