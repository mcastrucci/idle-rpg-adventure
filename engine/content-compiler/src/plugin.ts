/**
 * Game plugin interface of the content compiler (docs/engine/overview.md §3, "Content schema extensions").
 *
 * The engine owns the world collections (`areas`, `locations`, `routes` under `world/`); a game registers its own
 * collections, may extend the world entity schemas with its own fields, declares which fields reference which
 * collections, and may add game-specific checks.
 */
import type { PredicateRegistry, SceneGeometry, World } from '@engine/world';
import type { z } from 'zod';

import type { ContentErrorCode, JsonPath } from './errors.ts';

/** A content entity: any JSON object with a namespaced `id`. */
export interface ContentEntity {
  readonly id: string;
  readonly [field: string]: unknown;
}

export interface CollectionDefinition {
  /** Directory of the collection, relative to the content root (POSIX, no leading/trailing slash). */
  readonly dir: string;
  /** Schema of one entity. Its output must keep the `id` field. */
  readonly schema: z.ZodType;
  /** Namespace every ID of the collection must use, e.g. `item` for `item:rope`. Unique across collections. */
  readonly idPrefix: string;
}

/** Engine-owned world collections. */
export type WorldCollectionName = 'areas' | 'locations' | 'routes';

/** Compiled content handed to plugin hooks: game collections (sorted by ID) and the assembled world. */
export interface CompiledContent {
  readonly game: string;
  readonly collections: Readonly<Record<string, readonly ContentEntity[]>>;
  readonly world: World;
}

/**
 * One reference found in content. `collection` + `from` identify the referencing entity (a game collection or a
 * world collection), `path` is relative to that entity, `to` names the collection(s) the ID must exist in.
 */
export interface ReferenceCheck {
  readonly collection: string;
  readonly from: string;
  readonly path: JsonPath;
  readonly id: unknown;
  readonly to: string | readonly string[];
}

/** A problem reported by a plugin's `validate` hook; the compiler resolves `collection` + `id` to a file. */
export interface PluginIssue {
  readonly code: ContentErrorCode;
  readonly collection?: string;
  readonly id?: string;
  readonly path?: JsonPath;
  readonly message: string;
}

export interface ContentGamePlugin<G = unknown> {
  /** Game identifier stored in the bundle, e.g. `rpg`. */
  readonly id: string;
  /** Game collections. Names must not clash with the world collections. */
  readonly collections: Readonly<Record<string, CollectionDefinition>>;
  /** Game requirement predicates, used to validate requirements in world content. */
  readonly predicates: PredicateRegistry<G>;
  /** Extra schemas every world entity must also satisfy (game fields on areas, locations, routes). */
  readonly extend?: Readonly<Partial<Record<WorldCollectionName, z.ZodType>>>;
  /** Lists the references the compiler must resolve (see {@link referencesAt}). */
  references?(content: CompiledContent): readonly ReferenceCheck[];
  /** Game-specific checks run after every engine check passed for the parsed content. */
  validate?(content: CompiledContent): readonly PluginIssue[];
  /**
   * Resolves a logical scene image key (an image layer path `asset:<key>`) to the pixel size of art the game ships
   * outside the content root. Return `undefined` for an unknown key. Without this hook `asset:` keys are rejected.
   */
  resolveSceneImage?(key: string): { readonly width: number; readonly height: number } | undefined;
  /** Game checks for authored geometry, after each referenced Tiled map has been safely imported. */
  validateScenes?(content: CompiledContent, scenes: Readonly<Record<string, SceneGeometry>>): readonly PluginIssue[];
}

/** Identity helper giving plugin authors type inference. */
export function defineContentPlugin<G>(plugin: ContentGamePlugin<G>): ContentGamePlugin<G> {
  return plugin;
}

/**
 * Collects the values found at `pattern` in each entity of `collection` as references to `to`.
 *
 * `pattern` is a dot-separated field path where `*` matches every element of an array (or value of an object), e.g.
 * `location`, `drops.*.item`, `exits.*.requires.hasItem.item`. Missing fields are skipped (optional references).
 * `collection` may be a game collection or a world collection (`areas`, `locations`, `routes`).
 */
export function referencesAt(
  content: CompiledContent,
  collection: string,
  pattern: string,
  to: string | readonly string[],
): ReferenceCheck[] {
  const entities = entitiesOf(content, collection);
  const segments = pattern.split('.');
  const found: ReferenceCheck[] = [];
  for (const entity of entities) {
    walk(entity, segments, [], (value, path) => {
      found.push({ collection, from: entity.id, path, id: value, to });
    });
  }
  return found;
}

/** Entities of a game or world collection (`undefined` if the collection does not exist). */
export function entitiesOf(content: CompiledContent, collection: string): readonly ContentEntity[] {
  if (collection === 'areas' || collection === 'locations' || collection === 'routes') {
    return content.world[collection] as readonly ContentEntity[];
  }
  return content.collections[collection] ?? [];
}

function walk(
  value: unknown,
  segments: readonly string[],
  path: readonly (string | number)[],
  emit: (value: unknown, path: JsonPath) => void,
): void {
  if (value === undefined) return;
  const [head, ...rest] = segments;
  if (head === undefined) {
    emit(value, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (head === '*') {
    if (Array.isArray(value)) value.forEach((item: unknown, i) => walk(item, rest, [...path, i], emit));
    else for (const [key, item] of Object.entries(value)) walk(item, rest, [...path, key], emit);
    return;
  }
  if (Array.isArray(value)) return;
  walk((value as Record<string, unknown>)[head], rest, [...path, head], emit);
}
