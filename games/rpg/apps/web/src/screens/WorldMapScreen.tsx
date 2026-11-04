import { useEffect, useMemo, useRef, useState } from 'react';
import { WorldMap } from '@engine/client-kit';
import type { WorldMapView } from '@engine/client-kit';
import type { WorldViewDTO } from '@rpg/protocol';

import type { ApiClient } from '../api/http.ts';
import { describeError } from '../app/useGameSession.ts';
import { contentLabel } from '../content/labels.ts';
import { codeText, hasCode, t, useLocale } from '../i18n/index.ts';
import './world-map.css';

type Props = {
  readonly actorId: string;
  readonly characterLevel: number;
  readonly api: ApiClient;
  readonly onEnterLive: (areaId: string) => void;
  readonly onStartIdle: (areaId: string) => void;
  readonly liveActive: boolean;
  readonly idleActive: boolean;
  readonly active?: boolean;
  readonly refreshKey?: string;
};

/** RPG presentation over the engine-neutral map. All progress, gates and available actions come from the server DTO. */
export function WorldMapScreen({ actorId, characterLevel, api, onEnterLive, onStartIdle, liveActive, idleActive, active = true, refreshKey = '' }: Props) {
  const locale = useLocale();
  const [view, setView] = useState<WorldViewDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const previousCompletion = useRef(new Map<string, boolean>());
  const previousActorId = useRef(actorId);

  useEffect(() => {
    let cancelled = false;
    if (previousActorId.current !== actorId) {
      previousActorId.current = actorId;
      previousCompletion.current.clear();
      setView(null);
      setCelebration(null);
    }
    if (!active) {
      setCelebration(null);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setError(null);
    api.getWorldView(actorId).then((next) => {
      if (cancelled) return;
      const newlyCompleted = next.areas.find((area) => previousCompletion.current.get(area.id) === false && area.completion?.completed);
      setCelebration(newlyCompleted ? t(newlyCompleted.idle.unlocked ? 'ui.world.conquered_idle' : 'ui.world.conquered', { name: displayAreaName(newlyCompleted.label) }) : null);
      previousCompletion.current.clear();
      for (const area of next.areas) if (area.completion) previousCompletion.current.set(area.id, area.completion.completed);
      setView(next);
    }, (failure: unknown) => {
      if (cancelled) return;
      setView(null);
      setError(describeError(failure));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, actorId, api, refreshKey, retryCount]);

  const mapView = useMemo(() => view ? toMapView(view) : null, [view, locale]);
  const currentView = view;
  const live = (areaId: string) => {
    const area = view?.areas.find((entry) => entry.id === areaId);
    if (area?.actions.enterLive && !liveActive && !idleActive) onEnterLive(areaId);
  };
  const idle = (areaId: string) => {
    const area = view?.areas.find((entry) => entry.id === areaId);
    if (area?.actions.startIdle && !liveActive && !idleActive) onStartIdle(areaId);
  };

  return <section className="screen world-map-screen" aria-labelledby="world-map-title">
    <header className="world-map-screen__heading">
      <p className="world-map-screen__eyebrow">{t('ui.world.eyebrow')}</p>
      <h1 id="world-map-title" className="screen__title">{t('ui.world.title')}</h1>
      <p className="muted">{t('ui.world.intro')}</p>
    </header>

    {liveActive && <aside className="world-map-resume" aria-label={t('ui.world.live_banner_label')}>
      <span>{t('ui.world.live_in_progress')}</span>
      <a className="button button--secondary button--link" href="#/world/live">{t('ui.world.live_resume')}</a>
    </aside>}
    {!liveActive && <p className="world-map-open-live"><a href="#/world/live">{t('ui.world.live_open')}</a></p>}
    {idleActive && <aside className="world-map-resume" aria-label={t('ui.world.expedition_banner_label')}>
      <span>{t('ui.world.expedition_in_progress')}</span>
      <a className="button button--secondary button--link" href="#/expeditions">{t('ui.world.expedition_view')}</a>
    </aside>}
    {loading && <p className="muted" role="status">{t('ui.world.loading')}</p>}
    {error && <div className="world-map-error" role="alert">
      <p>{t('ui.world.load_failed', { error: codeText(error) })}</p>
      <button type="button" className="button button--secondary" onClick={() => setRetryCount((count) => count + 1)}>{t('ui.common.try_again')}</button>
    </div>}
    {!loading && !error && mapView && mapView.areas.length === 0 && <p className="muted">{t('ui.world.no_paths')}</p>}
    {!loading && mapView && mapView.areas.length > 0 && <div className="world-map-frame">
      <WorldMap view={mapView} theme={{ accent: '#80e2c5', accentContrast: '#09251e', surface: '#172922', surfaceRaised: '#223a31', text: '#f2f1df', mutedText: '#b4c7b9', route: '#567b67', locked: '#766c68', border: '#4d6e5a' }}
        labels={{ mapLabel: t('ui.world.map_label'), zoomIn: t('ui.world.zoom_in'), zoomOut: t('ui.world.zoom_out'), resetZoom: t('ui.world.reset_map'), hubAction: t('ui.world.hub_action'), enterArea: t('ui.world.enter_live'), startIdle: t('ui.world.start_expedition'), completion: t('ui.world.required_locations'), idleAvailable: t('ui.world.idle_unlocked'), locked: t('ui.world.locked'), closeDetails: t('ui.world.close_details') }}
        onEnterArea={live} onStartIdle={idle}
        renderAreaDetails={(areaId) => {
          const area = currentView?.areas.find((entry) => entry.id === areaId);
          return area ? <AreaDetails area={area} characterLevel={characterLevel} /> : null;
        }} />
    </div>}
    {celebration && <p className="world-map-celebration" role="status" aria-live="polite">{celebration}</p>}
  </section>;
}

function AreaDetails({ area, characterLevel }: { area: WorldViewDTO['areas'][number]; characterLevel: number }) {
  const completion = area.completion;
  return <div className="world-area-details">
    <p className="world-map-screen__eyebrow">{area.visibility === 'known' ? t('ui.world.known_region') : t('ui.world.beyond_veil')}</p>
    {area.visibility === 'known' && <>
      {completion && completion.mandatoryBosses.required > 0 && <div className="world-area-details__boss">
        <strong>{t('ui.world.mandatory_bosses')}</strong><span>{t('ui.world.bosses_defeated', { defeated: completion.mandatoryBosses.defeated, required: completion.mandatoryBosses.required })}</span>
        <ul>{completion.mandatoryBosses.bosses.map((entry, index) => <li key={`${index}:${entry.label}`}>{humanizePublicName(entry.label)}: {entry.defeated ? t('ui.world.boss_defeated') : t('ui.world.boss_not_defeated')}</li>)}</ul>
      </div>}
      {area.danger.status === 'known'
        ? <p className="world-area-details__danger">{t('ui.world.danger_known', { level: characterLevel, min: area.danger.minLevel, max: area.danger.maxLevel })}</p>
        : <p className="world-area-details__danger">{t('ui.world.danger_unknown', { level: characterLevel })}</p>}
    </>}
  </div>;
}

function toMapView(view: WorldViewDTO): WorldMapView {
  return {
    hub: { ...view.hub, label: displayAreaName(view.hub.label) },
    areas: view.areas.map((area) => ({
      id: area.id,
      label: displayAreaName(area.label),
      visibility: area.visibility,
      position: area.position,
      lockedReasons: area.lockedReasons.map(humanizeReason),
      ...(area.completion ? { completion: { complete: area.completion.discovered, required: area.completion.required, completed: area.completion.completed } } : {}),
      actions: { enter: area.actions.enterLive, startIdle: area.actions.startIdle },
      idleAvailable: area.idle.unlocked,
      ...(area.completion?.completed ? { badges: [t('ui.world.conquered_badge')] } : {}),
    })),
    routes: view.routes,
  };
}

function displayAreaName(label: string): string {
  const translated = contentLabel(label);
  if (translated !== undefined) return translated;
  if (label === 'area.region_1.name') return t('ui.label.area_region_1');
  if (label === 'area.sanctuary.name') return t('ui.label.area_sanctuary');
  return humanizePublicName(label);
}

function humanizePublicName(label: string): string {
  const translated = contentLabel(label);
  if (translated !== undefined) return translated;
  return label.split('.').filter((part) => part && part !== 'area' && part !== 'enemy' && part !== 'name').at(-1)?.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? label;
}

function humanizeReason(reason: string): string {
  return hasCode(reason) ? codeText(reason) : codeText('requires.other');
}
