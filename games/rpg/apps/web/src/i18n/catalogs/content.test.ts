// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import EN from './en/content.ts';
import ES from './es/content.ts';

const CONTENT_ROOT = fileURLToPath(new URL('../../../../../content/', import.meta.url));
const DISPLAYABLE_ID = /^(item|skill|enemy|area|loc|res|idle|offer|merchant|route):/;

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) return jsonFiles(`${full}/`);
    return entry.name.endsWith('.json') ? [full] : [];
  });
}

function collect(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, keys);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith('Key') && typeof child === 'string') keys.add(child);
    else if (key === 'id' && typeof child === 'string' && DISPLAYABLE_ID.test(child)) keys.add(child);
    else collect(child, keys);
  }
}

const REQUIRED = new Set<string>();
for (const file of jsonFiles(CONTENT_ROOT)) collect(JSON.parse(readFileSync(file, 'utf8')), REQUIRED);

describe('content catalogs', () => {
  it('discovers content keys and IDs', () => {
    expect(REQUIRED.size).toBeGreaterThan(100);
  });

  for (const [locale, catalog] of [['en', EN], ['es', ES]] as const) {
    it(`${locale} has a non-empty entry for every content text key and displayable ID`, () => {
      const missing = [...REQUIRED].filter((key) => (catalog[key] ?? '').trim() === '');
      expect(missing).toEqual([]);
    });

    it(`${locale} has no value equal to its key`, () => {
      const same = Object.entries(catalog).filter(([key, value]) => key === value).map(([key]) => key);
      expect(same).toEqual([]);
    });
  }

  it('es and en define the same keys', () => {
    expect(Object.keys(ES).sort()).toEqual(Object.keys(EN).sort());
  });

  it('es differs from en for translated names (not a copy)', () => {
    const translated = Object.keys(EN).filter((key) => ES[key] !== EN[key]);
    expect(translated.length).toBeGreaterThan(Object.keys(EN).length / 2);
  });
});
