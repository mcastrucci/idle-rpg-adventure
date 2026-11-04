/** Locales the POC UI ships. Spanish is the default; English is the fallback and second locale. */
export const LOCALES = ['es', 'en'] as const;
export type Locale = typeof LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'es';
/** Missing keys fall back to this locale before the humanizer runs. */
export const FALLBACK_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'rpg.locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the first supported language of the browser's preference list; anything unsupported (or an empty list)
 * resolves to the default Spanish.
 */
export function detectLocale(languages: readonly string[] | undefined): Locale {
  for (const tag of languages ?? []) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'en') return 'en';
    if (primary === 'es') return 'es';
  }
  return DEFAULT_LOCALE;
}

function safeStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** The locale this device chose last, or `null` (nothing stored, storage blocked, or an unknown value). */
export function readStoredLocale(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Locale | null {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch { return null; }
}

function browserLanguages(): readonly string[] | undefined {
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (!nav) return undefined;
    return nav.languages.length > 0 ? nav.languages : [nav.language];
  } catch { return undefined; }
}

export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectLocale(browserLanguages());
}

let current: Locale | null = null;
const listeners = new Set<() => void>();

function applyDocumentLanguage(locale: Locale): void {
  try { globalThis.document.documentElement.lang = locale; } catch { /* no DOM (SSR) */ }
}

export function getLocale(): Locale {
  if (current === null) {
    current = resolveInitialLocale();
    applyDocumentLanguage(current);
  }
  return current;
}

export interface SetLocaleOptions {
  /** Remember the choice on this device (default true). Tests pass `false`. */
  readonly persist?: boolean;
}

export function setLocale(locale: Locale, { persist = true }: SetLocaleOptions = {}): void {
  const changed = current !== locale;
  current = locale;
  applyDocumentLanguage(locale);
  if (persist) {
    try { safeStorage()?.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* the choice just is not remembered */ }
  }
  if (changed) for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
