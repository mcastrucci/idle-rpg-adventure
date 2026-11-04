import { CATALOGS } from './catalogs/index.ts';
import { FALLBACK_LOCALE, getLocale } from './locale.ts';
import type { Locale } from './locale.ts';

export type Params = Readonly<Record<string, string | number>>;

function fromCatalog(locale: Locale, key: string): string | undefined {
  const catalog = CATALOGS[locale];
  return catalog.ui[key] ?? catalog.content[key];
}

/** Active locale first, then English. `undefined` when neither has the key. */
function lookup(key: string, locale: Locale): string | undefined {
  return fromCatalog(locale, key) ?? (locale === FALLBACK_LOCALE ? undefined : fromCatalog(FALLBACK_LOCALE, key));
}

/** Whether `key` has a translation (active locale or English). */
export function has(key: string): boolean {
  return lookup(key, getLocale()) !== undefined;
}

/** Content-catalog text only (names of items, skills, areas…), active locale then English. */
export function contentText(key: string): string | undefined {
  const locale = getLocale();
  return CATALOGS[locale].content[key] ?? (locale === FALLBACK_LOCALE ? undefined : CATALOGS[FALLBACK_LOCALE].content[key]);
}

/** CLDR plural category reduced to the two forms both locales use. */
function pluralForm(locale: Locale, count: number): 'one' | 'other' {
  return new Intl.PluralRules(locale).select(count) === 'one' ? 'one' : 'other';
}

function interpolate(template: string, params: Params | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    return value === undefined ? '' : String(value);
  });
}

/** Last resort so a missing key never shows raw: `ui.inventory.empty_slot` becomes "Empty slot". */
function humanizeKey(key: string): string {
  const leaf = key.split('.').at(-1) ?? key;
  const words = leaf.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Translates `key` in the active locale. `{name}` placeholders take `params`; when `params.count` is a number, the
 * `<key>_one` / `<key>_other` entries are preferred (Spanish and English plural rules). Missing keys fall back to
 * English and then to a humanized key, never the raw key.
 */
export function t(key: string, params?: Params): string {
  const locale = getLocale();
  const count = params?.['count'];
  if (typeof count === 'number') {
    const form = pluralForm(locale, count);
    const plural = lookup(`${key}_${form}`, locale) ?? lookup(`${key}_other`, locale);
    if (plural !== undefined) return interpolate(plural, params);
  }
  const text = lookup(key, locale);
  return text === undefined ? humanizeKey(key) : interpolate(text, params);
}
