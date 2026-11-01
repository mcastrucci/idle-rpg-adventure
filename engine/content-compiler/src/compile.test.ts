import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PredicateRegistry } from '@engine/world';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  canonicalJson,
  compileContentDirectory,
  defineContentPlugin,
  formatErrors,
  referencesAt,
  type CompileResult,
  type ContentBundle,
  type ContentError,
} from './index.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Test game: `widget:` items placed at locations, one game predicate, a game field on locations.
// ---------------------------------------------------------------------------------------------------------------------

const testPlugin = defineContentPlugin<{ readonly score: number }>({
  id: 'test',
  collections: {
    widgets: {
      dir: 'widgets',
      schema: z.strictObject({ id: z.string(), location: z.string(), weight: z.int().positive() }),
      idPrefix: 'widget',
    },
  },
  predicates: new PredicateRegistry<{ readonly score: number }>().register('scoreAtLeast', {
    args: z.strictObject({ score: z.int().positive() }),
    evaluate: ({ score }, ctx) => ctx.game.score >= score,
  }),
  extend: { locations: z.looseObject({ light: z.enum(['dark', 'lit']).optional() }) },
  references: (content) => referencesAt(content, 'widgets', 'location', 'locations'),
  validate: (content) =>
    (content.collections['widgets'] ?? [])
      .filter((w) => w['weight'] === 13)
      .map((w) => ({ code: 'test.unluckyWeight', collection: 'widgets', id: w.id, path: ['weight'], message: 'Unlucky weight' })),
});

type Files = Record<string, unknown>;

function baseFiles(): Files {
  return {
    'world/areas/base.json': { id: 'area:base', kind: 'hub' },
    'world/areas/field.json': {
      id: 'area:field',
      kind: 'explorable',
      startLocation: 'loc:field.a',
      locations: ['loc:field.a', 'loc:field.b', 'loc:field.c'],
      completion: { pool: { tag: 'ordinary' }, thresholdBp: 5000, frozen: { poolSize: 2, requiredCount: 1, at: '2026-11-01' } },
    },
    'world/locations/field.json': [
      { id: 'loc:field.a', tags: ['ordinary'], exits: [{ id: 'exit:field.a_b', to: 'loc:field.b' }] },
      {
        id: 'loc:field.b',
        tags: ['ordinary'],
        light: 'dark',
        exits: [
          { id: 'exit:field.b_a', to: 'loc:field.a' },
          { id: 'exit:field.b_c', to: 'loc:field.c', requires: { game: 'scoreAtLeast', score: 3 } },
        ],
      },
      { id: 'loc:field.c', exits: [{ id: 'exit:field.c_b', to: 'loc:field.b' }] },
    ],
    'world/routes/base_field.json': { id: 'route:base_field', from: 'area:base', to: 'area:field', travel: { mode: 'instant' } },
    'widgets/bolt.json': { id: 'widget:bolt', location: 'loc:field.a', weight: 1 },
    'widgets/nested/nut.json': { id: 'widget:nut', location: 'loc:field.c', weight: 2 },
    'README.md': 'ignored',
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeContent(files: Files, order: readonly string[] = Object.keys(files)): string {
  const root = mkdtempSync(path.join(tmpdir(), 'content-compiler-'));
  roots.push(root);
  for (const rel of order) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const value = files[rel];
    writeFileSync(abs, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return root;
}

function compile(files: Files, previous?: unknown): CompileResult {
  return compileContentDirectory(writeContent(files), testPlugin, previous === undefined ? {} : { previous });
}

function build(files: Files): ContentBundle {
  const result = compile(files);
  if (!result.ok) throw new Error(formatErrors(result.errors));
  return result.bundle;
}

function errorsOf(result: CompileResult): readonly ContentError[] {
  expect(result.ok).toBe(false);
  return result.errors;
}

describe('compileContentDirectory', () => {
  it('builds a bundle with the world, game collections sorted by ID and a SHA-256 contentHash', () => {
    const bundle = build(baseFiles());
    expect(bundle.format).toBe(1);
    expect(bundle.game).toBe('test');
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.world.areas.map((a) => a.id)).toEqual(['area:base', 'area:field']);
    expect(bundle.world.locations.map((l) => l.id)).toEqual(['loc:field.a', 'loc:field.b', 'loc:field.c']);
    expect(bundle.world.locations[1]).toMatchObject({ light: 'dark' }); // game field kept
    expect(bundle.world.locations[2]?.tags).toEqual([]); // engine defaults applied
    expect(bundle.collections['widgets']?.map((w) => w.id)).toEqual(['widget:bolt', 'widget:nut']);
  });

  it('reports schema errors with file and JSON path (including array files and game extensions)', () => {
    const files = baseFiles();
    files['widgets/bolt.json'] = { id: 'widget:bolt', location: 'loc:field.a', weight: -1 };
    const locations = files['world/locations/field.json'] as Record<string, unknown>[];
    locations[1] = { ...locations[1], light: 'blinding' };
    files['world/routes/base_field.json'] = { id: 'route:base_field', from: 'area:base', to: 'area:field', travel: { mode: 'warp' } };
    const errors = errorsOf(compile(files));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'schema.invalid', file: 'widgets/bolt.json', path: ['weight'] }));
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'schema.invalid', file: 'world/locations/field.json', path: [1, 'light'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'schema.invalid', file: 'world/routes/base_field.json', path: ['travel', 'mode'] }),
    );
    expect(formatErrors(errors)).toContain('widgets/bolt.json\n  schema.invalid  $.weight  ');
  });

  it('reports invalid JSON, files outside collections and IDs in the wrong namespace', () => {
    const files = baseFiles();
    files['widgets/broken.json'] = '{ "id": ';
    files['gadgets/x.json'] = { id: 'gadget:x' };
    files['widgets/wrong.json'] = { id: 'loc:not_a_widget', location: 'loc:field.a', weight: 1 };
    const errors = errorsOf(compile(files));
    expect(errors.map((e) => [e.code, e.file])).toEqual([
      ['file.unknownCollection', 'gadgets/x.json'],
      ['json.invalid', 'widgets/broken.json'],
      ['id.wrongNamespace', 'widgets/wrong.json'],
    ]);
  });

  it('reports duplicate IDs across files once, naming the first file', () => {
    const files = baseFiles();
    files['widgets/bolt_copy.json'] = { id: 'widget:bolt', location: 'loc:field.b', weight: 3 };
    files['world/locations/extra.json'] = { id: 'loc:field.a' };
    const errors = errorsOf(compile(files));
    const duplicates = errors.filter((e) => e.code === 'id.duplicate');
    // Sorted by ID; "first" is the first file in path order, so the report is deterministic.
    expect(duplicates).toEqual([
      {
        code: 'id.duplicate',
        file: 'world/locations/field.json',
        path: [0, 'id'],
        message: 'Duplicate ID "loc:field.a" (first defined in world/locations/extra.json)',
      },
      { code: 'id.duplicate', file: 'widgets/bolt_copy.json', path: ['id'], message: 'Duplicate ID "widget:bolt" (first defined in widgets/bolt.json)' },
    ]);
  });

  it('reports dangling references declared by the game', () => {
    const files = baseFiles();
    files['widgets/nested/nut.json'] = { id: 'widget:nut', location: 'loc:field.missing', weight: 2 };
    expect(errorsOf(compile(files))).toEqual([
      { code: 'ref.unknown', file: 'widgets/nested/nut.json', path: ['location'], message: 'Unknown locations ID "loc:field.missing"' },
    ]);
  });

  it('surfaces world graph errors mapped to the file of the offending entity', () => {
    const files = baseFiles();
    const locations = files['world/locations/field.json'] as Record<string, unknown>[];
    locations[2] = { id: 'loc:field.c', exits: [{ id: 'exit:field.c_x', to: 'loc:field.x', requires: { game: 'nope' } }] };
    files['world/areas/base.json'] = { id: 'area:base', kind: 'camp' }; // no hub any more
    const errors = errorsOf(compile(files));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'world.noHub', path: ['areas'] }));
    expect(errors.find((e) => e.code === 'world.noHub')?.file).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'ref.unknownLocation', file: 'world/locations/field.json', path: [2, 'exits', 0, 'to'] }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'requirement.unknownPredicate',
        file: 'world/locations/field.json',
        path: [2, 'exits', 0, 'requires', 'game'],
      }),
    );
  });

  it('runs the game validate hook after engine checks', () => {
    const files = baseFiles();
    files['widgets/bolt.json'] = { id: 'widget:bolt', location: 'loc:field.a', weight: 13 };
    expect(errorsOf(compile(files))).toEqual([
      { code: 'test.unluckyWeight', file: 'widgets/bolt.json', path: ['weight'], message: 'Unlucky weight' },
    ]);
  });

  it('produces the same contentHash regardless of file creation order and file names', () => {
    const files = baseFiles();
    const keys = Object.keys(files);
    const a = compileContentDirectory(writeContent(files, keys), testPlugin);
    const b = compileContentDirectory(writeContent(files, [...keys].reverse()), testPlugin);
    const renamed = { ...files };
    renamed['widgets/zzz.json'] = renamed['widgets/bolt.json'];
    delete renamed['widgets/bolt.json'];
    const c = compileContentDirectory(writeContent(renamed), testPlugin);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.bundle.contentHash).toBe(a.bundle.contentHash);
    expect(c.bundle.contentHash).toBe(a.bundle.contentHash);
    expect(canonicalJson(b.bundle)).toBe(canonicalJson(a.bundle));

    const changed = baseFiles();
    changed['widgets/bolt.json'] = { id: 'widget:bolt', location: 'loc:field.a', weight: 2 };
    expect(build(changed).contentHash).not.toBe(a.bundle.contentHash);
  });

  describe('frozen completion baselines (--previous)', () => {
    const previous = (): unknown => JSON.parse(canonicalJson(build(baseFiles()))) as unknown;

    it('accepts unchanged baselines and added locations', () => {
      const files = baseFiles();
      (files['world/areas/field.json'] as { locations: string[] }).locations.push('loc:field.d');
      files['world/locations/d.json'] = { id: 'loc:field.d', tags: ['ordinary'], exits: [{ id: 'exit:field.d_a', to: 'loc:field.a' }] };
      const locations = files['world/locations/field.json'] as { exits: unknown[] }[];
      locations[0]?.exits.push({ id: 'exit:field.a_d', to: 'loc:field.d' });
      expect(compile(files, previous()).errors).toEqual([]);
    });

    it('detects changed frozen values and pool locations removed or untagged', () => {
      const prev = previous();
      const files = baseFiles();
      const area = files['world/areas/field.json'] as { completion: { frozen: { poolSize: number; requiredCount: number } } };
      area.completion.frozen = { ...area.completion.frozen, poolSize: 4, requiredCount: 2 };
      const locations = files['world/locations/field.json'] as { tags?: string[] }[];
      if (locations[1]) locations[1].tags = [];
      // The world checks also flag the inconsistent pool (completion.poolShrunk / infeasible); keep baseline errors.
      const errors = errorsOf(compile(files, prev)).filter((e) => e.code.startsWith('baseline.'));
      expect(errors).toEqual([
        expect.objectContaining({ code: 'baseline.frozenChanged', file: 'world/areas/field.json', path: ['completion', 'frozen', 'poolSize'] }),
        expect.objectContaining({ code: 'baseline.frozenChanged', file: 'world/areas/field.json', path: ['completion', 'frozen', 'requiredCount'] }),
        expect.objectContaining({ code: 'baseline.poolLocationUntagged', file: 'world/locations/field.json', path: [1, 'tags'] }),
      ]);

      const removed = baseFiles();
      const fieldArea = removed['world/areas/field.json'] as { locations: string[] };
      fieldArea.locations = ['loc:field.a', 'loc:field.c'];
      removed['world/locations/field.json'] = [
        { id: 'loc:field.a', tags: ['ordinary'], exits: [{ id: 'exit:field.a_c', to: 'loc:field.c' }] },
        { id: 'loc:field.c', exits: [{ id: 'exit:field.c_a', to: 'loc:field.a' }] },
      ];
      expect(errorsOf(compile(removed, prev))).toContainEqual(
        expect.objectContaining({ code: 'baseline.poolLocationRemoved', file: 'world/areas/field.json', path: ['locations'] }),
      );
    });

    it('rejects an unreadable previous bundle', () => {
      expect(errorsOf(compile(baseFiles(), { nope: true }))).toContainEqual(
        expect.objectContaining({ code: 'previous.invalid', file: 'previous bundle', path: ['world'] }),
      );
    });
  });

  it('rejects plugins whose collections clash with the world or each other', () => {
    const bad = defineContentPlugin({
      ...testPlugin,
      collections: {
        locations: { dir: 'stuff', schema: z.object({ id: z.string() }), idPrefix: 'stuff' },
        gizmos: { dir: 'world', schema: z.object({ id: z.string() }), idPrefix: 'area' },
      },
    });
    const result = compileContentDirectory(writeContent(baseFiles()), bad);
    expect(new Set(result.errors.map((e) => e.code))).toEqual(new Set(['plugin.invalid']));
    const messages = result.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('Collection name "locations" is reserved for the world');
    expect(messages).toContain('ID prefix "area" is also used by "areas"');
    expect(messages).toContain('Directory "world" overlaps the directory of "areas" ("world/areas")');
  });
});

describe('referencesAt', () => {
  it('walks wildcards over arrays and objects and skips missing fields', () => {
    const bundle = build(baseFiles());
    const content = { game: 'test', world: bundle.world, collections: bundle.collections };
    expect(referencesAt(content, 'locations', 'exits.*.to', 'locations').map((r) => [r.from, r.path, r.id])).toEqual([
      ['loc:field.a', ['exits', 0, 'to'], 'loc:field.b'],
      ['loc:field.b', ['exits', 0, 'to'], 'loc:field.a'],
      ['loc:field.b', ['exits', 1, 'to'], 'loc:field.c'],
      ['loc:field.c', ['exits', 0, 'to'], 'loc:field.b'],
    ]);
    expect(referencesAt(content, 'locations', 'exits.*.requires.hasItem.item', 'widgets')).toEqual([]);
  });
});
