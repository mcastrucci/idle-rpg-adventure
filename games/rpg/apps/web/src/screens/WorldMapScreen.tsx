import { useEffect, useMemo, useRef, useState } from 'react';
import { WorldMap } from '@engine/client-kit';
import type { WorldMapView } from '@engine/client-kit';
import type { WorldViewDTO } from '@rpg/protocol';

import type { ApiClient } from '../api/http.ts';
import { describeError } from '../app/useGameSession.ts';
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
      setCelebration(newlyCompleted ? `${displayAreaName(newlyCompleted.label)} conquered.${newlyCompleted.idle.unlocked ? ' Idle expeditions are now available.' : ''}` : null);
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

  const mapView = useMemo(() => view ? toMapView(view) : null, [view]);
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
      <p className="world-map-screen__eyebrow">SANCTUARY · THE FRACTURE</p>
      <h1 id="world-map-title" className="screen__title">World map</h1>
      <p className="muted">Choose a portal to inspect its path. Entering an area is always a separate action.</p>
    </header>

    {liveActive && <aside className="world-map-resume" aria-label="Live adventure in progress">
      <span>A live adventure is already in progress.</span>
      <a className="button button--secondary button--link" href="#/world/live">Resume live adventure</a>
    </aside>}
    {idleActive && <aside className="world-map-resume" aria-label="Expedition in progress">
      <span>An expedition is already in progress.</span>
      <a className="button button--secondary button--link" href="#/expeditions">View expedition</a>
    </aside>}
    {loading && <p className="muted" role="status">Reading the explored paths…</p>}
    {error && <div className="world-map-error" role="alert">
      <p>Could not load the world map ({error}).</p>
      <button type="button" className="button button--secondary" onClick={() => setRetryCount((count) => count + 1)}>Try again</button>
    </div>}
    {!loading && !error && mapView && mapView.areas.length === 0 && <p className="muted">No paths are visible yet.</p>}
    {!loading && mapView && mapView.areas.length > 0 && <div className="world-map-frame">
      <WorldMap view={mapView} theme={{ accent: '#80e2c5', accentContrast: '#09251e', surface: '#172922', surfaceRaised: '#223a31', text: '#f2f1df', mutedText: '#b4c7b9', route: '#567b67', locked: '#766c68', border: '#4d6e5a' }}
        labels={{ mapLabel: 'Sanctuary and Fracture world map', zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetZoom: 'Reset map', hubAction: 'Return to Sanctuary', enterArea: 'Enter live', startIdle: 'Start expedition', completion: 'Required locations', idleAvailable: 'Idle unlocked', locked: 'Locked', closeDetails: 'Close area details' }}
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
    <p className="world-map-screen__eyebrow">{area.visibility === 'known' ? 'KNOWN REGION' : 'BEYOND THE VEIL'}</p>
    {area.visibility === 'known' && <>
      {completion && completion.mandatoryBosses.required > 0 && <div className="world-area-details__boss">
        <strong>Mandatory bosses</strong><span>{completion.mandatoryBosses.defeated} / {completion.mandatoryBosses.required} defeated</span>
        <ul>{completion.mandatoryBosses.bosses.map((entry, index) => <li key={`${index}:${entry.label}`}>{humanizePublicName(entry.label)}: {entry.defeated ? 'defeated' : 'not defeated'}</li>)}</ul>
      </div>}
      {area.danger.status === 'known'
        ? <p className="world-area-details__danger">Your level {characterLevel} · Recommended {area.danger.minLevel}–{area.danger.maxLevel}</p>
        : <p className="world-area-details__danger">Your level {characterLevel} · Recommended level unknown</p>}
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
      ...(area.completion?.completed ? { badges: ['Conquered'] } : {}),
    })),
    routes: view.routes,
  };
}

function displayAreaName(label: string): string {
  if (label === 'area.region_1.name') return 'The Verdant Hollow';
  if (label === 'area.sanctuary.name') return 'Sanctuary';
  return humanizePublicName(label);
}

function humanizePublicName(label: string): string {
  return label.split('.').filter((part) => part && part !== 'area' && part !== 'enemy' && part !== 'name').at(-1)?.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? label;
}

function humanizeReason(reason: string): string {
  const publicReasons: Readonly<Record<string, string>> = {
    'world.noRouteFromReachableArea': 'No known route reaches this portal yet.',
    'requires.areaCompleted': 'Conquer the preceding area first.',
    'requires.discovered': 'Explore more of the region first.',
    'requires.flag': 'Complete the required landmark first.',
    'requires.hasItem': 'Bring the required item first.',
    'requires.game.levelAtLeast': 'Reach the required level first.',
    'requires.game.defeated': 'Defeat the required guardian first.',
    'requires.not': 'A required condition is not met.',
    'requires.other': 'A required condition is not met.',
  };
  return publicReasons[reason] ?? 'A required condition is not met.';
}
