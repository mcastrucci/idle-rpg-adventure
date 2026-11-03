import type { WorldMapView } from './world-map-types.ts';

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapViewport {
  scale: number;
  x: number;
  y: number;
}

export const MIN_MAP_SCALE = 0.7;
export const MAX_MAP_SCALE = 2.6;

export function panMap(viewport: MapViewport, dx: number, dy: number): MapViewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/** Zoom around a screen point while keeping its represented map coordinate in place. */
export function zoomMapAt(viewport: MapViewport, anchor: MapPoint, requestedScale: number): MapViewport {
  const scale = Math.min(MAX_MAP_SCALE, Math.max(MIN_MAP_SCALE, requestedScale));
  const worldAtAnchor = {
    x: (anchor.x - viewport.x) / viewport.scale,
    y: (anchor.y - viewport.y) / viewport.scale,
  };
  return {
    scale,
    x: anchor.x - worldAtAnchor.x * scale,
    y: anchor.y - worldAtAnchor.y * scale,
  };
}

export interface MapLayout {
  hub: MapPoint;
  areas: ReadonlyMap<string, MapPoint>;
  width: number;
  height: number;
}

export function visibleWorldMapRoutes(view: WorldMapView): WorldMapView['routes'] {
  const visibleNodeIds = new Set([view.hub.id, ...view.areas.map((area) => area.id)]);
  return view.routes.filter((route) => visibleNodeIds.has(route.from) && visibleNodeIds.has(route.to));
}

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 620;
const NODE_GAP_X = 430;
const NODE_GAP_Y = 340;
const MOBILE_VIEWPORT_WIDTH = 360;
const MIN_TARGET_DIAMETER = 44;

/** Fit authored positions to the canvas and place missing or colliding nodes deterministically. */
export function layoutWorldMap(view: WorldMapView): MapLayout {
  const width = view.size?.width ?? DEFAULT_WIDTH;
  const requestedHeight = view.size?.height ?? DEFAULT_HEIGHT;
  const columns = Math.max(1, Math.floor((width - 80) / NODE_GAP_X));
  const emptyCount = view.areas.filter((area) => !area.position).length;
  const rows = Math.max(1, Math.ceil(emptyCount / columns));
  const minNodeSeparation = Math.ceil((width * MIN_TARGET_DIAMETER) / (MOBILE_VIEWPORT_WIDTH * MIN_MAP_SCALE));
  const nodeRows = Math.ceil((view.areas.length + 1) / columns);
  const height = Math.max(requestedHeight, rows * NODE_GAP_Y + 120, nodeRows * minNodeSeparation + 120);
  const center = { x: width / 2, y: height / 2 };
  const authored = [view.hub.position, ...view.areas.map((area) => area.position)].filter((point): point is MapPoint => point !== null);
  const fitted = fitPositions(authored, center, width, height);
  const authoredByKey = new Map<string, MapPoint>();
  if (view.hub.position) authoredByKey.set(view.hub.id, fitted.get(positionKey(view.hub.position)) ?? center);
  for (const area of view.areas) {
    if (area.position) authoredByKey.set(area.id, fitted.get(positionKey(area.position)) ?? center);
  }
  const placed: MapPoint[] = [];
  const hubBase = view.hub.position ? authoredByKey.get(view.hub.id) ?? center : center;
  const hub = findFreePoint(hubBase, placed, minNodeSeparation, width, height);
  placed.push(hub);
  const startY = center.y - ((rows - 1) * NODE_GAP_Y) / 2;
  const missing = view.areas.filter((area) => !area.position);
  const areas = new Map<string, MapPoint>();
  let generatedIndex = 0;

  for (const area of view.areas) {
    if (area.position) {
      const point = findFreePoint(authoredByKey.get(area.id) ?? center, placed, minNodeSeparation, width, height);
      placed.push(point);
      areas.set(area.id, point);
      continue;
    }

    const row = Math.floor(generatedIndex / columns);
    const column = generatedIndex % columns;
    const rowCount = Math.min(columns, missing.length - row * columns);
    const rowWidth = (rowCount - 1) * NODE_GAP_X;
    const origin: MapPoint = {
      x: center.x - rowWidth / 2 + column * NODE_GAP_X,
      y: startY + row * NODE_GAP_Y,
    };
    generatedIndex += 1;
    const point = findFreePoint(origin, placed, minNodeSeparation, width, height);
    placed.push(point);
    areas.set(area.id, point);
  }

  return { hub, areas, width, height };
}

function fitPositions(points: readonly MapPoint[], center: MapPoint, width: number, height: number): ReadonlyMap<string, MapPoint> {
  if (points.length === 0) return new Map();
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const scaleX = rangeX > 0 ? (width - 240) / rangeX : Number.POSITIVE_INFINITY;
  const scaleY = rangeY > 0 ? (height - 200) / rangeY : Number.POSITIVE_INFINITY;
  const scale = Number.isFinite(Math.min(scaleX, scaleY)) ? Math.max(0.001, Math.min(scaleX, scaleY)) : 1;
  const sourceCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const result = new Map<string, MapPoint>();
  for (const point of points) {
    result.set(positionKey(point), {
      x: center.x + (point.x - sourceCenter.x) * scale,
      y: center.y + (point.y - sourceCenter.y) * scale,
    });
  }
  return result;
}

function findFreePoint(origin: MapPoint, placed: readonly MapPoint[], minSeparation: number, width: number, height: number): MapPoint {
  const xLimit = minSeparation / 2;
  const yLimit = minSeparation / 2;
  for (let ring = 0; ring <= 12; ring += 1) {
    const candidates = ring === 0
      ? [origin]
      : [
          { x: origin.x, y: origin.y - ring * minSeparation },
          { x: origin.x, y: origin.y + ring * minSeparation },
          { x: origin.x - ring * minSeparation, y: origin.y },
          { x: origin.x + ring * minSeparation, y: origin.y },
          { x: origin.x - ring * minSeparation, y: origin.y - ring * minSeparation },
          { x: origin.x + ring * minSeparation, y: origin.y - ring * minSeparation },
          { x: origin.x - ring * minSeparation, y: origin.y + ring * minSeparation },
          { x: origin.x + ring * minSeparation, y: origin.y + ring * minSeparation },
        ];
    const candidate = candidates.find((point) =>
      point.x >= xLimit && point.x <= width - xLimit && point.y >= yLimit && point.y <= height - yLimit &&
      placed.every((other) => distanceSquared(other, point) >= minSeparation * minSeparation),
    );
    if (candidate) return candidate;
  }
  return { x: origin.x, y: Math.max(yLimit, Math.min(height - yLimit, origin.y + 13 * minSeparation)) };
}

function positionKey(point: MapPoint): string {
  return `${point.x}:${point.y}`;
}

function distanceSquared(left: MapPoint, right: MapPoint): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}
