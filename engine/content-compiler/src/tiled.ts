import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { SceneGeometry } from '@engine/world';

import type { ContentError } from './errors.ts';

export interface TiledImportResult {
  readonly geometry?: SceneGeometry;
  readonly error?: ContentError;
}

/** Imports the deliberately small, inert subset of Tiled JSON used by scene authoring. */
export function importTiledMap(file: string, text: string, contentRoot: string): TiledImportResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    return failure('scene.jsonInvalid', file, [], error instanceof Error ? error.message : String(error));
  }
  if (!record(input)) return failure('scene.invalid', file, [], 'Tiled map must be a JSON object');
  if (input['orientation'] !== 'orthogonal') return failure('scene.unsupportedMap', file, ['orientation'], 'only orthogonal Tiled maps are supported');
  if (input['infinite'] !== false) return failure('scene.unsupportedMap', file, ['infinite'], 'infinite maps are not supported');
  if (!positiveInteger(input['width']) || !positiveInteger(input['height']) || !positiveInteger(input['tilewidth']) || !positiveInteger(input['tileheight'])) {
    return failure('scene.invalid', file, [], 'map width, height, tilewidth and tileheight must be positive integers');
  }
  if (input['tilesets'] !== undefined && (!Array.isArray(input['tilesets']) || input['tilesets'].length !== 0)) {
    return failure('scene.unsupportedMap', file, ['tilesets'], 'tilesets are not supported; scenes use one image layer');
  }
  if (input['properties'] !== undefined) return failure('scene.unsupportedMap', file, ['properties'], 'custom Tiled properties are not supported');
  const width = input['width'] * input['tilewidth'];
  const height = input['height'] * input['tileheight'];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return failure('scene.invalid', file, [], 'map pixel dimensions exceed the safe integer range');
  if (!Array.isArray(input['layers'])) return failure('scene.invalid', file, ['layers'], 'map layers must be an array');

  const mapDir = path.dirname(path.resolve(contentRoot, file));
  const backgroundLayers: Record<string, unknown>[] = [];
  const geometry: { exits: Record<string, { x: number; y: number; width: number; height: number }>; hotspots: Record<string, { x: number; y: number; width: number; height: number }>; enemyAnchors: Record<string, { x: number; y: number }>; resources: Record<string, { x: number; y: number }> } = {
    exits: emptyRecord(), hotspots: emptyRecord(), enemyAnchors: emptyRecord(), resources: emptyRecord(),
  };
  const seenLayers = new Set<string>();
  const expectedLayers = new Set(['exits', 'hotspots', 'enemyAnchors', 'resources']);
  for (let i = 0; i < input['layers'].length; i += 1) {
    const layer: unknown = input['layers'][i];
    if (!record(layer)) return failure('scene.invalid', file, ['layers', i], 'layer must be an object');
    const name = layer['name'];
    const type = layer['type'];
    if (typeof name !== 'string' || name.length === 0) return failure('scene.invalid', file, ['layers', i, 'name'], 'layer needs a name');
    if (layer['properties'] !== undefined) return failure('scene.unsupportedLayer', file, ['layers', i, 'properties'], 'custom Tiled properties are not supported');
    if (seenLayers.has(name)) return failure('scene.duplicateLayer', file, ['layers', i, 'name'], `duplicate layer "${name}"`);
    seenLayers.add(name);
    if (!optionalBoolean(layer['visible']) || layer['visible'] === false || !optionalFinite(layer['opacity']) ||
        (layer['opacity'] !== undefined && !one(layer['opacity'])) || !optionalFinite(layer['parallaxx']) ||
        !optionalFinite(layer['parallaxy']) || (layer['parallaxx'] !== undefined && !one(layer['parallaxx'])) ||
        (layer['parallaxy'] !== undefined && !one(layer['parallaxy'])) || layer['tintcolor'] !== undefined ||
        (layer['mode'] !== undefined && layer['mode'] !== 'normal')) {
      return failure('scene.unsupportedTransform', file, ['layers', i], 'hidden, faded, tinted or parallax layers are not supported');
    }
    if (type === 'imagelayer') {
      backgroundLayers.push(layer);
      continue;
    }
    if (type !== 'objectgroup' || !expectedLayers.has(name)) {
      return failure('scene.unsupportedLayer', file, ['layers', i], `unsupported layer "${name}" of type "${String(type)}"`);
    }
    if (!optionalFinite(layer['x']) || !optionalFinite(layer['y']) || !optionalFinite(layer['offsetx']) || !optionalFinite(layer['offsety']) ||
        (layer['x'] !== undefined && !zero(layer['x'])) || (layer['y'] !== undefined && !zero(layer['y'])) ||
        (layer['offsetx'] !== undefined && !zero(layer['offsetx'])) || (layer['offsety'] !== undefined && !zero(layer['offsety']))) {
      return failure('scene.unsupportedTransform', file, ['layers', i], 'object layer offsets and transforms must be zero');
    }
    if (!Array.isArray(layer['objects'])) return failure('scene.invalid', file, ['layers', i, 'objects'], 'object layer objects must be an array');
    const target = geometry[name as keyof typeof geometry];
    for (let j = 0; j < layer['objects'].length; j += 1) {
      const item: unknown = layer['objects'][j];
      if (!record(item)) return failure('scene.invalid', file, ['layers', i, 'objects', j], 'object must be an object');
      if (item['properties'] !== undefined) return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j, 'properties'], 'custom Tiled properties are not supported');
      if (!optionalBoolean(item['visible']) || item['visible'] === false) {
        return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j, 'visible'], 'hidden objects and non-boolean visibility are not supported');
      }
      if (!optionalBoolean(item['point']) || !optionalBoolean(item['ellipse'])) {
        return failure('scene.invalid', file, ['layers', i, 'objects', j], 'point and ellipse fields must be booleans when present');
      }
      if (!optionalFinite(item['opacity']) || (item['opacity'] !== undefined && !one(item['opacity']))) {
        return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j, 'opacity'], 'object opacity must be 1 when present');
      }
      const id = item['name'];
      if (typeof id !== 'string' || id.length === 0) return failure('scene.objectNameMissing', file, ['layers', i, 'objects', j, 'name'], 'objects need a stable non-empty name');
      if (Object.hasOwn(target, id)) return failure('scene.duplicateObject', file, ['layers', i, 'objects', j, 'name'], `duplicate object name "${id}" in layer "${name}"`);
      if (!finiteNonnegative(item['x']) || !finiteNonnegative(item['y']) || !optionalFinite(item['rotation']) ||
          (item['rotation'] !== undefined && !zero(item['rotation'])) || item['gid'] !== undefined || item['ellipse'] === true ||
          item['polygon'] !== undefined || item['polyline'] !== undefined || item['text'] !== undefined || item['template'] !== undefined) {
        return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j], 'objects must be unrotated points or rectangles without tile, shape, text, or template transforms');
      }
      const x = item['x'];
      const y = item['y'];
      const point = item['point'] === true;
      if (point) {
        if (name === 'exits' || name === 'hotspots' || !pointDimension(item['width']) || !pointDimension(item['height'])) {
          return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j], 'exits and hotspots need rectangles; anchors and resources need points with omitted or zero dimensions');
        }
        if (x >= width || y >= height) return failure('scene.outOfBounds', file, ['layers', i, 'objects', j], 'point must fit within the map bounds');
        (target as Record<string, { x: number; y: number }>)[id] = { x, y };
      } else {
        if (name === 'enemyAnchors' || name === 'resources' || !positive(item['width']) || !positive(item['height'])) {
          return failure('scene.unsupportedObject', file, ['layers', i, 'objects', j], 'exits and hotspots need positive-size rectangles; anchors and resources need points');
        }
        const w = item['width'];
        const h = item['height'];
        if (!inside(x + w, y + h, width, height)) return failure('scene.outOfBounds', file, ['layers', i, 'objects', j], 'rectangle must fit within the map bounds');
        (target as Record<string, { x: number; y: number; width: number; height: number }>)[id] = { x, y, width: w, height: h };
      }
    }
  }

  if (backgroundLayers.length !== 1) return failure('scene.backgroundCount', file, ['layers'], 'map must contain exactly one image background layer');
  const background = backgroundLayers[0];
  if (!background) return failure('scene.backgroundCount', file, ['layers'], 'map must contain exactly one image background layer');
  const image = background['image'];
  if (typeof image !== 'string') return failure('scene.backgroundMissing', file, ['layers'], 'background layer needs an image path');
  if (!optionalFinite(background['x']) || !optionalFinite(background['y']) || !optionalFinite(background['offsetx']) || !optionalFinite(background['offsety']) ||
      (background['x'] !== undefined && !zero(background['x'])) || (background['y'] !== undefined && !zero(background['y'])) ||
      (background['offsetx'] !== undefined && !zero(background['offsetx'])) || (background['offsety'] !== undefined && !zero(background['offsety']))) {
    return failure('scene.unsupportedTransform', file, ['layers'], 'background layer offsets and transforms must be zero');
  }
  if (!optionalBoolean(background['repeatx']) || !optionalBoolean(background['repeaty']) || background['repeatx'] === true || background['repeaty'] === true) {
    return failure('scene.unsupportedTransform', file, ['layers'], 'repeating backgrounds and non-boolean repeat fields are not supported');
  }
  if (background['transparentcolor'] !== undefined) return failure('scene.unsupportedTransform', file, ['layers'], 'transparent-color background layers are not supported');
  if (!optionalDimension(background['imagewidth']) || !optionalDimension(background['imageheight'])) {
    return failure('scene.backgroundSize', file, ['layers'], 'declared imagewidth and imageheight must be positive integers');
  }
  if ((background['imagewidth'] !== undefined && background['imagewidth'] !== width) ||
      (background['imageheight'] !== undefined && background['imageheight'] !== height)) {
    return failure('scene.backgroundSize', file, ['layers'], `declared image dimensions must match ${width}x${height} map pixels`);
  }
  const imagePath = resolveLocalImage(image, file, contentRoot, mapDir);
  if ('error' in imagePath) return imagePath;
  return {
    geometry: { width, height, background: imagePath.path, exits: sortRecord(geometry.exits), hotspots: sortRecord(geometry.hotspots),
      enemyAnchors: sortRecord(geometry.enemyAnchors), resources: sortRecord(geometry.resources) },
  };
}

function resolveLocalImage(image: string, file: string, contentRoot: string, mapDir: string): { path: string } | { error: ContentError } {
  if (image.includes('\\') || image.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(image) || image.split('/').some(part => part === '..' || part === '.' || part === '')) {
    return { error: { code: 'scene.imagePathRejected', file, path: ['layers'], message: `background path "${image}" must be a relative path without traversal, URLs, or absolute components` } };
  }
  const root = realpathSync(contentRoot);
  let absolute: string;
  try {
    absolute = realpathSync(path.resolve(mapDir, image));
    if (!statSync(absolute).isFile()) throw new Error('not a file');
  } catch {
    return { error: { code: 'scene.imageMissing', file, path: ['layers'], message: `background image "${image}" does not exist as a file` } };
  }
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    return { error: { code: 'scene.imagePathRejected', file, path: ['layers'], message: `background image "${image}" resolves outside the content root` } };
  }
  return { path: relative.split(path.sep).join('/') };
}

function failure(code: string, file: string, pathSegments: (string | number)[], message: string): TiledImportResult {
  return { error: { code, file, path: pathSegments, message } };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === 'boolean'; }
function optionalFinite(value: unknown): boolean { return value === undefined || (typeof value === 'number' && Number.isFinite(value)); }
function optionalDimension(value: unknown): boolean { return value === undefined || positiveInteger(value); }
function pointDimension(value: unknown): boolean { return value === undefined || value === 0; }
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function zero(value: unknown): boolean { return value === 0; }
function one(value: unknown): boolean { return value === 1; }
function inside(x: number, y: number, width: number, height: number): boolean { return x <= width && y <= height; }
function sortRecord<T>(value: Record<string, T>): Record<string, T> { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }
function emptyRecord<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }
