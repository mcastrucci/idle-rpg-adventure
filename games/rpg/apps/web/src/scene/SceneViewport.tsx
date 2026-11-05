import { useEffect, useRef, useState } from 'react';
import { createSceneRenderer } from '@engine/client-kit';
import type { SceneRenderer, SceneRendererMode, SceneSpec } from '@engine/client-kit';

import type { LiveSceneDto } from '@rpg/protocol';

import { t, useLocale } from '../i18n/index.ts';
import { sceneForLocation } from './placeholderScene.ts';
import { parseSceneRegionId, sceneRegions } from './sceneRegions.ts';
import type { SceneRegionKind } from './sceneRegions.ts';
import './scene-viewport.css';

type Props = {
  /** Current location ID from the server's live view. The viewport never decides anything, it only illustrates. */
  locationId: string | undefined;
  /** Server geometry of the current location (absent: no tappable regions). */
  scene?: LiveSceneDto | undefined;
  /** Whether the DOM control for this exit/hotspot is currently usable; `undefined`: no such control, so no region. */
  regionEnabled?: (kind: SceneRegionKind, id: string) => boolean | undefined;
  /** A tap on an enabled region. The host sends the same command as the matching DOM button; the canvas decides nothing. */
  onRegionTap?: (kind: SceneRegionKind, id: string) => void;
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
export function SceneViewport({ locationId, scene, regionEnabled, onRegionTap, createRenderer = createSceneRenderer, buildScene = sceneForLocation }: Props) {
  useLocale();
  const host = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const enabledRef = useRef(regionEnabled);
  enabledRef.current = regionEnabled;
  const [renderer, setRenderer] = useState<SceneRenderer | null>(null);
  const job = useRef<Promise<unknown>>(Promise.resolve());
  const tap = useRef(onRegionTap);
  tap.current = onRegionTap;
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
    const built = buildScene(locationId);
    const spec = { ...built, regions: sceneRegions(sceneRef.current, built.background, (kind, id) => enabledRef.current?.(kind, id)) };
    // First scene appears at once; later location changes preload the next scene and then fade to it.
    const next = shown.current ? renderer.transitionTo(spec) : renderer.loadScene(spec);
    shown.current = true;
    job.current = next.catch(() => undefined); // A scene that fails to load leaves the previous one on screen; the DOM view is unaffected.
  }, [renderer, locationId, buildScene]);

  // Regions follow the server view and the DOM controls' enabled state without reloading the scene. Applied after any
  // pending load, so they never land on the previous location's scene.
  useEffect(() => {
    if (!renderer || !locationId) return undefined;
    let current = true;
    const art = buildScene(locationId).background;
    const regions = sceneRegions(scene, art, (kind, id) => regionEnabled?.(kind, id));
    void job.current.then(() => { if (current) renderer.setRegions(regions); });
    return () => { current = false; };
  }, [renderer, locationId, buildScene, scene, regionEnabled]);

  useEffect(() => {
    if (!renderer) return undefined;
    return renderer.on('regionTap', ({ regionId }) => {
      const region = parseSceneRegionId(regionId);
      if (region) tap.current?.(region.kind, region.id);
    });
  }, [renderer]);

  return <>
    <div className="scene-viewport" ref={host} aria-hidden="true" hidden={mode === 'fallback'} data-scene={locationId} data-mode={mode} />
    {mode === 'fallback' && <p className="muted scene-viewport__note">{t('ui.live.viewport_fallback')}</p>}
  </>;
}
