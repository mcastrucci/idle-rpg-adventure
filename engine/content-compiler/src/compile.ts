/**
 * Content compilation pipeline (ADR-0008, docs/spec/content-format.md §4):
 *
 * 1. assign each JSON file to a collection by directory, parse it and validate every entity with its collection schema
 *    (plus the game's extension schema for world entities) and ID namespace;
 * 2. duplicate IDs across all collections, world graph validation (`@engine/world` `validateWorld`), referential
 *    integrity of the references the game declares, frozen completion baselines against a previous bundle;
 * 3. the game's own `validate` hook;
 * 4. a bundle whose `contentHash` is the SHA-256 of its canonical JSON.
 *
 * Each stage runs only if the previous one produced no error, to avoid cascades. Entities are sorted by ID, so the
 * bundle and its hash do not depend on file names or file system order.
 */
import {
  AreaSchema,
  LocationSchema,
  NAMESPACED_ID_PATTERN,
  RouteSchema,
  type SceneGeometry,
  SceneGeometrySchema,
  validateWorld,
  WorldSchema,
  type World,
} from '@engine/world';
import { z } from 'zod';

import { checkFrozenBaselines } from './baseline.ts';
import { contentHashOf } from './canonical.ts';
import type { ContentError, JsonPath } from './errors.ts';
import type { ContentFile } from './load.ts';
import { loadContentFiles } from './load.ts';
import { importTiledMap } from './tiled.ts';
import type {
  CollectionDefinition,
  CompiledContent,
  ContentEntity,
  ContentGamePlugin,
  ReferenceCheck,
  WorldCollectionName,
} from './plugin.ts';

/** Version of the bundle layout; bump when the bundle shape changes. */
export const BUNDLE_FORMAT = 1 as const;
export const BUNDLE_FORMAT_WITH_SCENES = 2 as const;

/** Engine-owned collections and their directories under the content root. */
export const WORLD_COLLECTIONS: Readonly<Record<WorldCollectionName, CollectionDefinition>> = {
  areas: { dir: 'world/areas', schema: AreaSchema, idPrefix: 'area' },
  locations: { dir: 'world/locations', schema: LocationSchema, idPrefix: 'loc' },
  routes: { dir: 'world/routes', schema: RouteSchema, idPrefix: 'route' },
};

const WORLD_COLLECTION_NAMES = Object.keys(WORLD_COLLECTIONS) as WorldCollectionName[];

function isWorldCollection(name: string): name is WorldCollectionName {
  return (WORLD_COLLECTION_NAMES as string[]).includes(name);
}

export interface ContentBundle {
  readonly format: typeof BUNDLE_FORMAT | typeof BUNDLE_FORMAT_WITH_SCENES;
  readonly game: string;
  /** Lowercase SHA-256 of canonical format-1 fields, plus `scenes` for format 2. */
  readonly contentHash: string;
  readonly world: World;
  /** Game collections, each sorted by ID. */
  readonly collections: Readonly<Record<string, readonly ContentEntity[]>>;
  /** Present only in format 2. Keyed by location ID. */
  readonly scenes?: Readonly<Record<string, SceneGeometry>>;
}

export interface CompileOptions {
  /** A previously published bundle (parsed JSON) whose frozen completion baselines must be preserved. */
  readonly previous?: unknown;
  /** Label used as `file` for errors about the previous bundle (default `previous bundle`). */
  readonly previousLabel?: string;
  /** Required to resolve background image paths for Tiled scene files. */
  readonly contentRoot?: string;
}

export type CompileResult =
  | { readonly ok: true; readonly bundle: ContentBundle; readonly errors: readonly [] }
  | {
      readonly ok: false;
      /** The assembled world when parsing succeeded (useful for graphs of invalid content). */
      readonly world?: World;
      readonly errors: readonly ContentError[];
    };

/** Reads `root` from disk and compiles it. */
export function compileContentDirectory(root: string, plugin: ContentGamePlugin, options: CompileOptions = {}): CompileResult {
  return compileContent(loadContentFiles(root), plugin, { ...options, contentRoot: root });
}

/** One parsed entity and where it came from. */
interface Entry {
  readonly collection: string;
  readonly entity: ContentEntity;
  readonly file: string;
  /** Path of the entity inside its file (`[]` or `[index]` for array files). */
  readonly prefix: JsonPath;
}

/** Compiles loaded JSON and Tiled source files; scene builds also validate referenced local assets under contentRoot. */
export function compileContent(files: readonly ContentFile[], plugin: ContentGamePlugin, options: CompileOptions = {}): CompileResult {
  const pluginErrors = checkPlugin(plugin);
  if (pluginErrors.length > 0) return { ok: false, errors: pluginErrors };

  const definitions: [string, CollectionDefinition][] = [
    ...WORLD_COLLECTION_NAMES.map((name): [string, CollectionDefinition] => [name, WORLD_COLLECTIONS[name]]),
    ...Object.entries(plugin.collections),
  ];

  // Stage 1: files, JSON, schemas, ID namespaces.
  const errors: ContentError[] = [];
  const entries: Entry[] = [];
  for (const { file, text } of [...files].sort((a, b) => compareStrings(a.file, b.file))) {
    if (file.endsWith('.tmj')) continue;
    const match = definitions.find(([, def]) => file.startsWith(`${def.dir}/`));
    if (!match) {
      errors.push({
        code: 'file.unknownCollection',
        file,
        path: [],
        message: `File is not under any collection directory (${definitions.map(([, d]) => d.dir).join(', ')})`,
      });
      continue;
    }
    const [collection, def] = match;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push({ code: 'json.invalid', file, path: [], message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const items: [JsonPath, unknown][] = Array.isArray(json) ? json.map((item: unknown, i): [JsonPath, unknown] => [[i], item]) : [[[], json]];
    for (const [prefix, raw] of items) {
      const extension = isWorldCollection(collection) ? plugin.extend?.[collection] : undefined;
      const entity = parseEntity(raw, def, extension, (path, message, code = 'schema.invalid') =>
        errors.push({ code, file, path: [...prefix, ...path], message }),
      );
      if (entity) entries.push({ collection, entity, file, prefix });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  entries.sort((a, b) => compareStrings(a.entity.id, b.entity.id) || compareStrings(a.file, b.file) || comparePrefix(a.prefix, b.prefix));
  const byCollection = new Map<string, Entry[]>(definitions.map(([name]) => [name, []]));
  for (const entry of entries) byCollection.get(entry.collection)?.push(entry);
  const entryOf = new Map<string, Entry>();
  for (const entry of entries) {
    const key = entryKey(entry.collection, entry.entity.id);
    if (!entryOf.has(key)) entryOf.set(key, entry);
  }

  // Stage 2a: duplicate IDs across every collection.
  const firstById = new Map<string, Entry>();
  for (const entry of entries) {
    const first = firstById.get(entry.entity.id);
    if (first) {
      errors.push({
        code: 'id.duplicate',
        file: entry.file,
        path: [...entry.prefix, 'id'],
        message: `Duplicate ID "${entry.entity.id}" (first defined in ${first.file})`,
      });
    } else {
      firstById.set(entry.entity.id, entry);
    }
  }

  // Stage 2b: world graph.
  const worldInput = {
    areas: (byCollection.get('areas') ?? []).map((e) => e.entity),
    locations: (byCollection.get('locations') ?? []).map((e) => e.entity),
    routes: (byCollection.get('routes') ?? []).map((e) => e.entity),
  };
  const worldEntryAt = (collection: string, index: number): Entry | undefined =>
    isWorldCollection(collection) ? byCollection.get(collection)?.[index] : undefined;
  const fromWorldPath = (code: string, path: JsonPath, message: string): ContentError => {
    const [collection, index, ...rest] = path;
    const entry = typeof collection === 'string' && typeof index === 'number' ? worldEntryAt(collection, index) : undefined;
    return entry ? { code, file: entry.file, path: [...entry.prefix, ...rest], message } : { code, path, message };
  };

  const worldResult = validateWorld(worldInput, plugin.predicates);
  for (const error of worldResult.errors) {
    // Top-level duplicate IDs are already reported (with both files) by stage 2a.
    const topLevelDuplicate = error.code === 'id.duplicate' && error.path.length === 3 && error.path[2] === 'id';
    if (!topLevelDuplicate) errors.push(fromWorldPath(error.code, error.path, error.message));
  }
  const world = worldResult.world;
  if (!world) return { ok: false, errors };

  const collections: Record<string, ContentEntity[]> = {};
  for (const name of Object.keys(plugin.collections).sort()) {
    collections[name] = (byCollection.get(name) ?? []).map((e) => e.entity);
  }
  const content: CompiledContent = { game: plugin.id, collections, world };

  // Stage 2c: references declared by the game.
  const idsOf = (collection: string): Set<string> | undefined => {
    if (isWorldCollection(collection)) return new Set(world[collection].map((e) => e.id));
    const list = collections[collection];
    return list ? new Set(list.map((e) => e.id)) : undefined;
  };
  const idSets = new Map<string, Set<string> | undefined>();
  const locate = (collection: string | undefined, id: string | undefined, path: JsonPath): Pick<ContentError, 'file' | 'path'> => {
    const entry = collection !== undefined && id !== undefined ? entryOf.get(entryKey(collection, id)) : undefined;
    return entry ? { file: entry.file, path: [...entry.prefix, ...path] } : { path };
  };
  for (const ref of plugin.references?.(content) ?? []) {
    errors.push(...checkReference(ref, idSets, idsOf, locate));
  }

  // Stage 2d: frozen baselines of the previous bundle.
  if (options.previous !== undefined) {
    const previousFile = options.previousLabel ?? 'previous bundle';
    const previous = z.looseObject({ world: WorldSchema }).safeParse(options.previous);
    if (!previous.success) {
      for (const issue of previous.error.issues) {
        errors.push({ code: 'previous.invalid', file: previousFile, path: issue.path.map(pathSegment), message: issue.message });
      }
    } else {
      for (const v of checkFrozenBaselines(previous.data.world, world)) errors.push(fromWorldPath(v.code, v.path, v.message));
    }
  }
  if (errors.length > 0) return { ok: false, world, errors };

  // Stage 2e: safely import every explicitly referenced Tiled scene and reject orphan maps.
  const mapFiles = new Map(files.filter(({ file }) => file.endsWith('.tmj')).map(({ file, text }) => [file, text]));
  const sceneEntries: [string, SceneGeometry][] = [];
  const referencedSceneFiles = new Set<string>();
  for (const location of world.locations) {
    const sceneFile = (location as { scene?: string }).scene;
    if (!sceneFile) continue;
    const owner = entryOf.get(entryKey('locations', location.id));
    if (!mapFiles.has(sceneFile)) {
      errors.push({ code: 'scene.mapMissing', ...(owner ? { file: owner.file } : {}), path: owner ? [...owner.prefix, 'scene'] : [],
        message: `Tiled map "${sceneFile}" referenced by ${location.id} is missing` });
      continue;
    }
    referencedSceneFiles.add(sceneFile);
    if (!options.contentRoot) {
      errors.push({ code: 'scene.assetRootMissing', file: sceneFile, path: [], message: 'scene import requires a content root to validate local image paths' });
      continue;
    }
    const result = importTiledMap(sceneFile, mapFiles.get(sceneFile) ?? '', options.contentRoot);
    if (result.error) errors.push(result.error);
    else if (result.geometry) {
      const checked = SceneGeometrySchema.safeParse(result.geometry);
      if (!checked.success) {
        for (const issue of checked.error.issues) errors.push({ code: 'scene.geometryInvalid', file: sceneFile,
          path: issue.path.map((part) => typeof part === 'string' || typeof part === 'number' ? part : String(part)), message: issue.message });
      } else sceneEntries.push([location.id, checked.data]);
    }
  }
  for (const sceneFile of [...mapFiles.keys()].sort(compareStrings)) {
    if (!referencedSceneFiles.has(sceneFile)) errors.push({ code: 'scene.mapOrphan', file: sceneFile, path: [], message: 'Tiled map is not referenced by any location.scene' });
  }
  if (errors.length > 0) return { ok: false, world, errors };
  const scenes = Object.fromEntries(sceneEntries.sort(([a], [b]) => compareStrings(a, b)));
  for (const issue of plugin.validateScenes?.(content, scenes) ?? []) {
    errors.push({ code: issue.code, ...locate(issue.collection, issue.id, issue.path ?? []), message: issue.message });
  }
  if (errors.length > 0) return { ok: false, world, errors };

  // Stage 3: game checks.
  for (const issue of plugin.validate?.(content) ?? []) {
    errors.push({ code: issue.code, ...locate(issue.collection, issue.id, issue.path ?? []), message: issue.message });
  }
  if (errors.length > 0) return { ok: false, world, errors };

  // Stage 4: bundle.
  const body = Object.keys(scenes).length === 0
    ? { format: BUNDLE_FORMAT, game: plugin.id, world, collections }
    : { format: BUNDLE_FORMAT_WITH_SCENES, game: plugin.id, world, collections, scenes };
  return { ok: true, bundle: { ...body, contentHash: contentHashOf(body) } as ContentBundle, errors: [] };
}

function parseEntity(
  raw: unknown,
  def: CollectionDefinition,
  extension: z.ZodType | undefined,
  report: (path: JsonPath, message: string, code?: string) => void,
): ContentEntity | undefined {
  const parsed = def.schema.safeParse(raw);
  const extended = extension?.safeParse(raw);
  let failed = false;
  for (const result of [parsed, extended]) {
    if (result && !result.success) {
      failed = true;
      for (const issue of result.error.issues) report(issue.path.map(pathSegment), issue.message);
    }
  }
  if (failed || !parsed.success) return undefined;
  const value: unknown = extended?.success ? mergeObjects(extended.data, parsed.data) : parsed.data;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    report([], 'An entity must be a JSON object');
    return undefined;
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string') {
    report(['id'], 'An entity must have a string "id"', 'id.missing');
    return undefined;
  }
  if (!NAMESPACED_ID_PATTERN.test(id) || !id.startsWith(`${def.idPrefix}:`)) {
    report(['id'], `ID "${id}" must be a namespaced ID like "${def.idPrefix}:name"`, 'id.wrongNamespace');
    return undefined;
  }
  return value as ContentEntity;
}

/** Engine-parsed fields win over the extension's view of the same object. */
function mergeObjects(extension: unknown, engine: unknown): unknown {
  if (extension === null || typeof extension !== 'object' || engine === null || typeof engine !== 'object') return engine;
  return { ...extension, ...engine };
}

function checkReference(
  ref: ReferenceCheck,
  idSets: Map<string, Set<string> | undefined>,
  idsOf: (collection: string) => Set<string> | undefined,
  locate: (collection: string, id: string, path: JsonPath) => Pick<ContentError, 'file' | 'path'>,
): ContentError[] {
  const targets = typeof ref.to === 'string' ? [ref.to] : [...ref.to];
  const where = locate(ref.collection, ref.from, ref.path);
  const errors: ContentError[] = [];
  for (const target of targets) {
    if (!idSets.has(target)) idSets.set(target, idsOf(target));
    if (idSets.get(target) === undefined) {
      errors.push({ code: 'plugin.invalid', ...where, message: `Reference targets unknown collection "${target}"` });
    }
  }
  if (errors.length > 0) return errors;
  if (typeof ref.id !== 'string') {
    return [{ code: 'ref.invalid', ...where, message: `Reference must be an ID string, got ${JSON.stringify(ref.id)}` }];
  }
  const id = ref.id;
  if (targets.some((target) => idSets.get(target)?.has(id))) return [];
  return [{ code: 'ref.unknown', ...where, message: `Unknown ${targets.join(' | ')} ID "${id}"` }];
}

/** Structural checks of the plugin itself (reported as `plugin.invalid`). */
export function checkPlugin(plugin: ContentGamePlugin): ContentError[] {
  const errors: ContentError[] = [];
  const report = (path: JsonPath, message: string): void => {
    errors.push({ code: 'plugin.invalid', path, message });
  };
  if (!/^[a-z][a-z0-9_-]*$/.test(plugin.id)) report(['id'], `Invalid game id "${plugin.id}"`);
  const all: [string, CollectionDefinition, boolean][] = [
    ...WORLD_COLLECTION_NAMES.map((name): [string, CollectionDefinition, boolean] => [name, WORLD_COLLECTIONS[name], true]),
    ...Object.entries(plugin.collections).map(([name, def]): [string, CollectionDefinition, boolean] => [name, def, false]),
  ];
  for (const [name, def, engine] of all) {
    if (engine) continue;
    const path = ['collections', name];
    if (isWorldCollection(name)) report(path, `Collection name "${name}" is reserved for the world`);
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(name)) report(path, `Invalid collection name "${name}"`);
    if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(def.dir)) report([...path, 'dir'], `Invalid collection directory "${def.dir}"`);
    if (!/^[a-z]+$/.test(def.idPrefix)) report([...path, 'idPrefix'], `Invalid ID prefix "${def.idPrefix}"`);
    for (const [other, otherDef] of all) {
      if (other === name) continue;
      if (otherDef.idPrefix === def.idPrefix) report([...path, 'idPrefix'], `ID prefix "${def.idPrefix}" is also used by "${other}"`);
      if (nested(def.dir, otherDef.dir) || nested(otherDef.dir, def.dir)) {
        report([...path, 'dir'], `Directory "${def.dir}" overlaps the directory of "${other}" ("${otherDef.dir}")`);
      }
    }
  }
  return errors;
}

function nested(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(`${parent}/`);
}

function entryKey(collection: string, id: string): string {
  return `${collection}\u0000${id}`;
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === 'symbol' ? String(segment) : segment;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrefix(a: JsonPath, b: JsonPath): number {
  return Number(a[0] ?? -1) - Number(b[0] ?? -1);
}
