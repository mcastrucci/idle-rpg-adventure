import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface LoadedContent {
  readonly format: 1 | 2;
  readonly game: string;
  readonly contentHash: string;
  readonly world: unknown;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
  readonly scenes?: Readonly<Record<string, unknown>>;
}
/** Canonical JSON matches the compiler's format-1 hash contract; runtime does not import compiler/tooling. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export async function loadContentBundle(path: string, expectedGame: string): Promise<LoadedContent> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!object(input) || ![1, 2].includes(input['format'] as number) || input['game'] !== expectedGame || typeof input['contentHash'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input['contentHash']) || !object(input['world']) || !object(input['collections']) ||
      Object.values(input['collections']).some((value) => !Array.isArray(value)) ||
      Object.keys(input).some((key) => !['format', 'game', 'contentHash', 'world', 'collections', ...(input['format'] === 2 ? ['scenes'] : [])].includes(key)) ||
      (input['format'] === 1 && Object.hasOwn(input, 'scenes')) ||
      (input['format'] === 2 && (!object(input['scenes']) || Object.keys(input['scenes']).length === 0 ||
        !validSceneMap(input['scenes']) || !sceneReferencesMatch(input['world'], input['scenes'])))) {
    throw new Error('invalid compiled content bundle envelope');
  }
  const { contentHash, ...body } = input;
  const computed = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
  if (computed !== contentHash) throw new Error('compiled content hash mismatch');
  return deepFreeze(input) as unknown as LoadedContent;
}
function validSceneMap(value: Record<string, unknown>): boolean {
  return Object.values(value).every(validSceneGeometry);
}
function validSceneGeometry(value: unknown): boolean {
  if (!object(value) || !Number.isSafeInteger(value['width']) || (value['width'] as number) <= 0 ||
      !Number.isSafeInteger(value['height']) || (value['height'] as number) <= 0 || typeof value['background'] !== 'string' ||
      value['background'].startsWith('/') || value['background'].includes('\\') || value['background'].includes(':') ||
      value['background'].split('/').some((part) => !part || part === '.' || part === '..') ||
      Object.keys(value).some((key) => !['width', 'height', 'background', 'exits', 'hotspots', 'enemyAnchors', 'resources'].includes(key))) return false;
  const width = value['width'] as number;
  const height = value['height'] as number;
  for (const layer of ['exits', 'hotspots', 'enemyAnchors', 'resources']) {
    const entries = value[layer];
    if (!object(entries)) return false;
    for (const geometry of Object.values(entries)) if (!validGeometry(layer, geometry, width, height)) return false;
  }
  return true;
}
function validGeometry(layer: string, value: unknown, width: number, height: number): boolean {
  if (!object(value) || !Number.isFinite(value['x']) || !Number.isFinite(value['y']) ||
      (value['x'] as number) < 0 || (value['y'] as number) < 0) return false;
  const x = value['x'] as number;
  const y = value['y'] as number;
  if (layer === 'exits' || layer === 'hotspots') {
    if (!Number.isFinite(value['width']) || !Number.isFinite(value['height']) || (value['width'] as number) <= 0 || (value['height'] as number) <= 0 ||
        x + (value['width'] as number) > width || y + (value['height'] as number) > height) return false;
    return Object.keys(value).every((key) => ['x', 'y', 'width', 'height'].includes(key));
  }
  return x < width && y < height && Object.keys(value).every((key) => ['x', 'y'].includes(key));
}
function sceneReferencesMatch(world: Record<string, unknown>, scenes: Record<string, unknown>): boolean {
  if (!Array.isArray(world['locations'])) return false;
  const ids = new Set<string>();
  for (const location of world['locations']) {
    if (!object(location) || typeof location['id'] !== 'string') return false;
    if (typeof location['scene'] === 'string') ids.add(location['id']);
  }
  return ids.size === Object.keys(scenes).length && Object.keys(scenes).every((id) => ids.has(id));
}
function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
