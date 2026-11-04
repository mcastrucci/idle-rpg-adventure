import type { Locale } from '../locale.ts';
import enContent from './en/content.ts';
import enUi from './en/ui.ts';
import esContent from './es/content.ts';
import esUi from './es/ui.ts';

export interface Catalog {
  /** `ui.*` keys: interface copy owned by the web app. */
  readonly ui: Readonly<Record<string, string>>;
  /** Content names/descriptions keyed by content localization key or stable ID. */
  readonly content: Readonly<Record<string, string>>;
}

export const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  es: { ui: esUi, content: esContent },
  en: { ui: enUi, content: enContent },
};
