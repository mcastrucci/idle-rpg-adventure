import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { layoutWorldMap, panMap, visibleWorldMapRoutes, zoomMapAt } from './world-map-layout.ts';
import type { MapPoint, MapViewport } from './world-map-layout.ts';
import type { WorldMapView } from './world-map-types.ts';
import { LABEL_FONT_SIZE, LABEL_LINE_HEIGHT, placeNodeLabels } from './world-map-labels.ts';
import type { LabelPlacement } from './world-map-labels.ts';
import './world-map.css';

export interface WorldMapLabels {
  mapLabel: string;
  zoomIn: string;
  zoomOut: string;
  resetZoom: string;
  hubAction: string;
  enterArea: string;
  startIdle: string;
  completion: string;
  locked: string;
  idleAvailable: string;
  closeDetails: string;
}

export interface WorldMapTheme {
  accent?: string;
  accentContrast?: string;
  surface?: string;
  surfaceRaised?: string;
  text?: string;
  mutedText?: string;
  route?: string;
  locked?: string;
  border?: string;
}

export interface WorldMapProps {
  view: WorldMapView;
  labels: WorldMapLabels;
  theme?: WorldMapTheme;
  hubActionLabel?: string;
  onSelectHub?: (hubId: string) => void;
  onHubAction?: (hubId: string) => void;
  onSelectArea?: (areaId: string) => void;
  onEnterArea?: (areaId: string) => void;
  onStartIdle?: (areaId: string) => void;
  /** Additional content for a selected visible area, rendered inside its detail sheet. */
  renderAreaDetails?: (areaId: string) => ReactNode;
}

interface PointPointer {
  x: number;
  y: number;
}

const INITIAL_VIEWPORT: MapViewport = { scale: 1, x: 0, y: 0 };

export function WorldMap({
  view,
  labels,
  theme,
  hubActionLabel,
  onSelectHub,
  onHubAction,
  onSelectArea,
  onEnterArea,
  onStartIdle,
  renderAreaDetails,
}: WorldMapProps) {
  const layout = useMemo(() => layoutWorldMap(view), [view]);
  const instanceId = useId().replaceAll(':', '');
  const [selected, setSelected] = useState<{ kind: 'hub' } | { kind: 'area'; id: string } | null>(null);
  const [viewport, setViewport] = useState<MapViewport>(INITIAL_VIEWPORT);
  const [pixelScale, setPixelScale] = useState(1);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, PointPointer>());
  const gesture = useRef<{ kind: 'pan'; pointerId: number; origin: PointPointer; viewport: MapViewport } | null>(null);
  const pinch = useRef<{ ids: [number, number]; points: [PointPointer, PointPointer]; viewport: MapViewport } | null>(null);
  const pinching = useRef(false);
  const themeStyle = themeToStyle(theme);
  const selectedArea = selected?.kind === 'area' ? view.areas.find((area) => area.id === selected.id) : undefined;
  const selectedHub = selected?.kind === 'hub' ? view.hub : undefined;
  const inverseScale = 1 / (pixelScale * viewport.scale);
  const selectedId = selected?.kind === 'hub' ? view.hub.id : selected?.kind === 'area' ? selected.id : null;
  const labelPlacements = useMemo(() => {
    const priorityOf = (id: string, base: number) => (selectedId === id ? 3000 : focusedId === id ? 2000 : base);
    const entries = [
      { id: view.hub.id, label: view.hub.label, point: layout.hub, base: 1000 },
      ...view.areas.flatMap((area) => {
        const point = layout.areas.get(area.id);
        return point ? [{ id: area.id, label: area.label, point, base: 0 }] : [];
      }),
    ].map((entry) => ({
      ...entry,
      x: (viewport.x + entry.point.x * viewport.scale) * pixelScale,
      y: (viewport.y + entry.point.y * viewport.scale) * pixelScale,
    }));
    const ranked = [...entries].sort((left, right) => left.x - right.x);
    const preferBelow = new Map(ranked.map((entry, index) => [entry.id, index % 2 === 0]));
    return placeNodeLabels(entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      x: entry.x,
      y: entry.y,
      priority: priorityOf(entry.id, entry.base),
      preferBelow: preferBelow.get(entry.id) ?? true,
    })), { width: layout.width * pixelScale, height: layout.height * pixelScale });
  }, [layout, view, viewport, pixelScale, selectedId, focusedId]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateScale = () => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nextScale = Math.min(rect.width / layout.width, rect.height / layout.height);
      if (Number.isFinite(nextScale) && nextScale > 0) setPixelScale(nextScale);
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateScale);
    observer?.observe(svg);
    return () => {
      window.removeEventListener('resize', updateScale);
      observer?.disconnect();
    };
  }, [layout.height, layout.width]);

  function selectHub() {
    setSelected({ kind: 'hub' });
    onSelectHub?.(view.hub.id);
  }

  function selectArea(id: string) {
    setSelected({ kind: 'area', id });
    onSelectArea?.(id);
  }

  function nodePoint(point: MapPoint): string {
    return `${point.x},${point.y}`;
  }

  function pointerPoint(event: ReactPointerEvent<SVGSVGElement>): PointPointer {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 && rect.height > 0
      ? Math.min(rect.width / layout.width, rect.height / layout.height)
      : pixelScale;
    const contentWidth = layout.width * scale;
    const contentHeight = layout.height * scale;
    const left = rect.left + (rect.width - contentWidth) / 2;
    const top = rect.top + (rect.height - contentHeight) / 2;
    return {
      x: (event.clientX - left) / scale,
      y: (event.clientY - top) / scale,
    };
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-map-node]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = pointerPoint(event);
    pointers.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is missing in some DOM test environments; real browsers support it.
    }
    if (pointers.current.size === 1) {
      gesture.current = { kind: 'pan', pointerId: event.pointerId, origin: point, viewport };
      pinching.current = false;
    } else if (pointers.current.size === 2) {
      gesture.current = null;
      pinching.current = true;
      const entries = [...pointers.current.entries()];
      const first = entries[0];
      const second = entries[1];
      if (first && second) {
        pinch.current = { ids: [first[0], second[0]], points: [first[1], second[1]], viewport };
      }
    }
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = pointerPoint(event);
    pointers.current.set(event.pointerId, point);
    const currentPointers = [...pointers.current.values()];
    if (currentPointers.length >= 2) {
      const activePinch = pinch.current;
      const first = pointers.current.get(activePinch?.ids[0] ?? -1);
      const second = pointers.current.get(activePinch?.ids[1] ?? -1);
      if (!activePinch || !first || !second) return;
      const currentDistance = distance(first, second);
      const startDistance = Math.max(1, distance(activePinch.points[0], activePinch.points[1]));
      const currentMidpoint = midpointOf(first, second);
      const startMidpoint = midpointOf(activePinch.points[0], activePinch.points[1]);
      const zoomed = zoomMapAt(activePinch.viewport, startMidpoint, activePinch.viewport.scale * (currentDistance / startDistance));
      setViewport(panMap(zoomed, currentMidpoint.x - startMidpoint.x, currentMidpoint.y - startMidpoint.y));
      return;
    }
    const activeGesture = gesture.current;
    if (!activeGesture || activeGesture.pointerId !== event.pointerId || pinching.current) return;
    setViewport(panMap(activeGesture.viewport, point.x - activeGesture.origin.x, point.y - activeGesture.origin.y));
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      pinch.current = null;
      pinching.current = false;
    } else if (pointers.current.size === 1) {
      const [pointerId, origin] = [...pointers.current.entries()][0] ?? [];
      if (pointerId !== undefined && origin) {
        gesture.current = { kind: 'pan', pointerId, origin, viewport };
      }
      pinch.current = null;
      pinching.current = false;
    }
  }

  function zoomBy(factor: number) {
    const center = { x: layout.width / 2, y: layout.height / 2 };
    setViewport(zoomMapAt(viewport, center, viewport.scale * factor));
  }

  const visibleRoutes = visibleWorldMapRoutes(view);

  return (
    <section className="world-map" style={themeStyle} aria-label={labels.mapLabel}>
      <div className="world-map__canvas-wrap">
        <svg
          ref={svgRef}
          className="world-map__canvas"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
          role="group"
          aria-label={view.hub.label}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <radialGradient id={`${instanceId}-glow`}>
              <stop offset="0" stopColor="var(--world-map-accent)" stopOpacity=".17" />
              <stop offset="1" stopColor="var(--world-map-accent)" stopOpacity="0" />
            </radialGradient>
            <pattern id={`${instanceId}-grain`} width="46" height="46" patternUnits="userSpaceOnUse">
              <circle cx="7" cy="10" r="1.15" fill="currentColor" opacity=".1" />
              <circle cx="31" cy="34" r=".8" fill="currentColor" opacity=".08" />
            </pattern>
          </defs>
          <rect width={layout.width} height={layout.height} fill={`url(#${instanceId}-glow)`} />
          <rect width={layout.width} height={layout.height} fill={`url(#${instanceId}-grain)`} />
          <g className="world-map__viewport" transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            {visibleRoutes.map((route) => {
              const from = route.from === view.hub.id ? layout.hub : layout.areas.get(route.from);
              const to = route.to === view.hub.id ? layout.hub : layout.areas.get(route.to);
              if (!from || !to) return null;
              return <path key={route.id} className="world-map__route" d={`M ${nodePoint(from)} L ${nodePoint(to)}`} aria-hidden="true" />;
            })}
            <g
              className="world-map__hub"
              data-map-node
              data-map-node-id={view.hub.id}
              role="button"
              tabIndex={0}
              aria-label={view.hub.label}
              aria-pressed={selected?.kind === 'hub'}
              onClick={selectHub}
              onFocus={() => setFocusedId(view.hub.id)}
              onBlur={() => setFocusedId((current) => (current === view.hub.id ? null : current))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectHub();
                }
              }}
            >
              <g transform={`translate(${layout.hub.x} ${layout.hub.y})`}>
                <circle className="world-map__hit-area" cx="0" cy="0" r={22 * inverseScale} />
                <circle className="world-map__node-halo" style={{ fill: `url(#${instanceId}-glow)` }} cx="0" cy="0" r={32 * inverseScale} />
                <circle className="world-map__hub-core" cx="0" cy="0" r={12 * inverseScale} />
                <path className="world-map__hub-mark" d={`M 0 ${-5 * inverseScale} l ${5 * inverseScale} ${5 * inverseScale} ${-5 * inverseScale} ${5 * inverseScale} ${-5 * inverseScale} ${-5 * inverseScale} z`} />
                <NodeLabel placement={labelPlacements.get(view.hub.id)} inverseScale={inverseScale} />
              </g>
            </g>
            {view.areas.map((area) => {
              const point = layout.areas.get(area.id);
              if (!point) return null;
              const locked = area.visibility === 'locked';
              const ariaLabel = [
                area.label,
                locked ? labels.locked : undefined,
                area.idleAvailable ? labels.idleAvailable : undefined,
                area.completion ? `${labels.completion} ${area.completion.complete} / ${area.completion.required}` : undefined,
              ].filter(Boolean).join(', ');
              return (
                <g
                  key={area.id}
                  className={`world-map__area${locked ? ' is-locked' : ''}`}
                  data-map-node
                  data-map-node-id={area.id}
                  role="button"
                  tabIndex={0}
                  aria-label={ariaLabel}
                  aria-pressed={selected?.kind === 'area' && selected.id === area.id}
                  onClick={() => selectArea(area.id)}
                  onFocus={() => setFocusedId(area.id)}
                  onBlur={() => setFocusedId((current) => (current === area.id ? null : current))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectArea(area.id);
                    }
                  }}
                >
                  <g transform={`translate(${point.x} ${point.y})`}>
                    <circle className="world-map__hit-area" cx="0" cy="0" r={22 * inverseScale} />
                    <circle className="world-map__node-halo" style={{ fill: `url(#${instanceId}-glow)` }} cx="0" cy="0" r={30 * inverseScale} />
                    <circle className="world-map__area-core" cx="0" cy="0" r={11 * inverseScale} />
                    {locked ? <path className="world-map__lock" d={lockPath(inverseScale)} aria-hidden="true" /> : <circle className="world-map__area-dot" cx="0" cy="0" r={2.4 * inverseScale} />}
                    {area.completion && <circle className="world-map__completion-ring" cx="0" cy="0" r={19 * inverseScale} transform="rotate(-90 0 0)" strokeDasharray={completionDash(area.completion.complete, area.completion.required, inverseScale)} />}
                    <NodeLabel placement={labelPlacements.get(area.id)} inverseScale={inverseScale} />
                    {area.idleAvailable && <text className="world-map__badge" x={16 * inverseScale} y={-12 * inverseScale} textAnchor="middle" aria-hidden="true" style={{ fontSize: `${16 * inverseScale}px` }}>✦</text>}
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="world-map__zoom-controls" aria-label="Map zoom controls">
          <button type="button" aria-label={labels.zoomIn} onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" aria-label={labels.zoomOut} onClick={() => zoomBy(0.8)}>−</button>
          <button type="button" aria-label={labels.resetZoom} onClick={() => setViewport(INITIAL_VIEWPORT)}>⌂</button>
        </div>
      </div>

      {(selectedArea || selectedHub) && (
        <aside className="world-map__details" aria-live="polite" aria-label={selectedArea?.label ?? selectedHub?.label}>
          <button className="world-map__close" type="button" aria-label={labels.closeDetails} onClick={() => setSelected(null)}>×</button>
          <h2>{selectedArea?.label ?? selectedHub?.label}</h2>
          {selectedArea?.visibility === 'locked' && (
            <div className="world-map__locked-copy" id={`${instanceId}-locked-reasons`}>
              <strong>{labels.locked}</strong>
              {selectedArea.lockedReasons.length > 0 && <ul>{selectedArea.lockedReasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul>}
            </div>
          )}
          {selectedArea?.completion && (
            <p className="world-map__completion-copy">
              {labels.completion}: {selectedArea.completion.complete} / {selectedArea.completion.required}
              {selectedArea.completion.completed ? ' ✓' : ''}
            </p>
          )}
          {selectedArea?.idleAvailable && <p className="world-map__idle-badge">{labels.idleAvailable}</p>}
          {selectedArea?.badges?.length ? <ul className="world-map__badges">{selectedArea.badges.map((badge, index) => <li key={`${badge}-${index}`}>{badge}</li>)}</ul> : null}
          {selectedArea?.details?.map((detail, index) => <p key={`${detail}-${index}`}>{detail}</p>)}
          {selectedArea && renderAreaDetails?.(selectedArea.id)}
          <div className="world-map__actions">
            {selectedHub && onHubAction && <button type="button" onClick={() => onHubAction(selectedHub.id)}>{hubActionLabel ?? labels.hubAction}</button>}
            {selectedArea?.visibility === 'locked' && (
              <button type="button" disabled aria-describedby={selectedArea.lockedReasons.length > 0 ? `${instanceId}-locked-reasons` : undefined}>{labels.enterArea}</button>
            )}
            {selectedArea?.visibility === 'known' && selectedArea.actions.enter && onEnterArea && <button type="button" onClick={() => onEnterArea(selectedArea.id)}>{labels.enterArea}</button>}
            {selectedArea?.visibility === 'known' && selectedArea.actions.startIdle && onStartIdle && <button type="button" onClick={() => onStartIdle(selectedArea.id)}>{labels.startIdle}</button>}
          </div>
        </aside>
      )}
    </section>
  );
}

function themeToStyle(theme?: WorldMapTheme): CSSProperties {
  return {
    '--world-map-accent': theme?.accent ?? '#8fd5c3',
    '--world-map-accent-contrast': theme?.accentContrast ?? '#102520',
    '--world-map-surface': theme?.surface ?? '#10191b',
    '--world-map-raised': theme?.surfaceRaised ?? '#1b292b',
    '--world-map-text': theme?.text ?? '#f1f5ee',
    '--world-map-muted': theme?.mutedText ?? '#a8b8b2',
    '--world-map-route': theme?.route ?? '#65857e',
    '--world-map-locked': theme?.locked ?? '#87918f',
    '--world-map-border': theme?.border ?? '#314344',
  } as CSSProperties;
}

function completionDash(complete: number, required: number, inverseScale: number): string {
  const circumference = 2 * Math.PI * 19 * inverseScale;
  const ratio = required <= 0 ? 0 : clamp(complete / required, 0, 1);
  return `${circumference * ratio} ${circumference}`;
}

function lockPath(inverseScale: number): string {
  return `M ${-6 * inverseScale} ${-2 * inverseScale} v ${-4 * inverseScale} a ${6 * inverseScale} ${6 * inverseScale} 0 0 1 ${12 * inverseScale} 0 v ${4 * inverseScale} M ${-9 * inverseScale} ${-2 * inverseScale} h ${18 * inverseScale} v ${13 * inverseScale} h ${-18 * inverseScale} z`;
}

function NodeLabel({
  placement,
  inverseScale,
}: {
  placement: LabelPlacement | undefined;
  inverseScale: number;
}) {
  if (!placement?.visible) return null;
  const x = placement.offsetX * inverseScale;
  return (
    <text
      className="world-map__node-label"
      x={x}
      y={placement.baselineY * inverseScale}
      textAnchor="middle"
      style={{ fontSize: `${LABEL_FONT_SIZE * inverseScale}px`, strokeWidth: `${2.5 * inverseScale}px` }}
      aria-hidden="true"
    >
      {placement.lines.map((line, index) => <tspan key={`${index}-${line}`} x={x} dy={index === 0 ? 0 : LABEL_LINE_HEIGHT * inverseScale}>{line}</tspan>)}
    </text>
  );
}

function distance(left: PointPointer, right: PointPointer): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function midpointOf(left: PointPointer, right: PointPointer): PointPointer {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
