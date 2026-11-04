// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATALOGS } from './catalogs/index.ts';
import { KNOWN_CODES } from './codes.ts';
import { LOCALES } from './locale.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every `'ui.…'` string literal in non-test source; catalog files themselves are excluded. */
function usedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel.startsWith(join('i18n', 'catalogs'))) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/'(ui\.[a-z0-9_.]+)'/gi)) used.set(match[1] ?? '', rel);
  }
  return used;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('UI catalogs', () => {
  const es = CATALOGS.es.ui;
  const en = CATALOGS.en.ui;

  it('define exactly the same keys in Spanish and English', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(LOCALES)('%s: every value is non-empty and never equals its key', (locale) => {
    for (const [key, value] of Object.entries(CATALOGS[locale].ui)) {
      expect(value.trim(), key).not.toBe('');
      expect(value, key).not.toBe(key);
      expect(key.startsWith('ui.'), key).toBe(true);
    }
  });

  it('use the same interpolation placeholders in both locales', () => {
    for (const key of Object.keys(en)) expect(placeholders(es[key] ?? ''), key).toEqual(placeholders(en[key] ?? ''));
  });

  it('provide both plural forms whenever one exists', () => {
    for (const locale of LOCALES) {
      const catalog = CATALOGS[locale].ui;
      for (const key of Object.keys(catalog)) {
        if (key.endsWith('_one')) expect(catalog[`${key.slice(0, -4)}_other`], key).toBeDefined();
        if (key.endsWith('_other') && catalog[`${key.slice(0, -6)}_one`] === undefined) {
          // an `_other` without `_one` is allowed only when no singular exists at all
          expect(key).toMatch(/_other$/);
        }
      }
    }
  });

  it('contain every ui.* key used in source, in both locales', () => {
    const missing: string[] = [];
    for (const [key, file] of usedKeys()) {
      for (const locale of LOCALES) {
        const catalog = CATALOGS[locale].ui;
        const direct = catalog[key] !== undefined;
        const plural = catalog[`${key}_one`] !== undefined && catalog[`${key}_other`] !== undefined;
        if (!direct && !plural) missing.push(`${locale}: ${key} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('have a message for every known server code in both locales', () => {
    for (const code of KNOWN_CODES) {
      for (const locale of LOCALES) expect(CATALOGS[locale].ui[`ui.code.${code}`], `${locale}:${code}`).toBeDefined();
    }
  });
});
