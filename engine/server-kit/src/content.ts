import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface LoadedContent {
  readonly format: 1;
  readonly game: string;
  readonly contentHash: string;
  readonly world: unknown;
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
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
  if (!object(input) || input['format'] !== 1 || input['game'] !== expectedGame || typeof input['contentHash'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input['contentHash']) || !object(input['world']) || !object(input['collections']) ||
      Object.values(input['collections']).some((value) => !Array.isArray(value)) ||
      Object.keys(input).some((key) => !['format', 'game', 'contentHash', 'world', 'collections'].includes(key))) {
    throw new Error('invalid compiled content bundle envelope');
  }
  const { contentHash, ...body } = input;
  const computed = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
  if (computed !== contentHash) throw new Error('compiled content hash mismatch');
  return deepFreeze(input) as unknown as LoadedContent;
}
function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
