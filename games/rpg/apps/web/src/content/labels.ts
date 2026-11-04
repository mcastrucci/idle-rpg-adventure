import { contentText, t } from '../i18n/index.ts';

/** Labels the client knows by heart; kept as catalog keys so they follow the active locale. */
const KNOWN_LABEL_KEYS: Readonly<Record<string, string>> = {
  'area.region_1.name': 'ui.label.area_region_1',
  'area:region_1': 'ui.label.area_region_1',
  'area.region_2.name': 'ui.label.area_region_2',
  'area:region_2': 'ui.label.area_region_2',
  'area.sanctuary.name': 'ui.label.area_sanctuary',
  'area:sanctuary': 'ui.label.area_sanctuary',
};

/**
 * Content-catalog text for a localization key or a stable ID. Both spellings are tried: the value itself
 * (`item.minor_healing_potion.name`, `item:minor_healing_potion`) and, for `namespace:leaf` IDs, the dotted name key
 * (`item.minor_healing_potion.name`).
 */
export function contentLabel(value: string): string | undefined {
  const direct = contentText(value);
  if (direct !== undefined) return direct;
  const separator = value.indexOf(':');
  if (separator > 0) return contentText(`${value.slice(0, separator)}.${value.slice(separator + 1)}.name`);
  return undefined;
}

/** Content-catalog text for the first candidate that has one. */
export function firstContentLabel(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const text = contentLabel(candidate);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Display text for a stable content ID or a localization key: the content catalog (active locale, then English), the
 * client's own known labels, and finally a humanized form of the ID so nothing raw is ever shown.
 */
export function displayLabel(value: string): string {
  const translated = contentLabel(value);
  if (translated !== undefined) return translated;
  const known = KNOWN_LABEL_KEYS[value];
  if (known) return t(known);
  if (!/[.:/_-]/.test(value)) return value.trim();
  const normalized = value.trim().replace(/\.name$/i, '').replace(/^[a-z][a-z0-9_-]*[.:]/i, '')
    .replace(/(^|[.:/_-])region[_-]?\d+(?=$|[.:/_-])/gi, '$1');
  const words = normalized.split(/[.:/_-]+/).filter(Boolean);
  const readable = words.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return readable ? readable.replace(/\b\w/g, (letter) => letter.toUpperCase()) : value;
}

/** Legacy display fallback used outside live screens; command payloads retain the original value. */
export function displayId(id: string): string {
  const translated = contentLabel(id);
  if (translated !== undefined) return translated;
  const raw = id.slice(id.indexOf(':') + 1).replaceAll('_', ' ').replaceAll('.', ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Title-cased words of an ID (`item:minor_healing_potion` → `Minor Healing Potion`); the no-catalog fallback. */
export function humanizeId(value: string): string {
  const leaf = (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toLocaleUpperCase());
}

/** Catalog name for any ID or localization key, then the client's known labels, then `humanizeId`. */
export function labelOrHumanized(value: string): string {
  const known = KNOWN_LABEL_KEYS[value];
  return contentLabel(value) ?? (known === undefined ? humanizeId(value) : t(known));
}

/** Item name from the server catalog: the localization key, then the ID, then the humanized last name segment. */
export function itemDisplayName(nameKey: string | undefined, id: string): string {
  const translated = firstContentLabel(nameKey, id);
  if (translated !== undefined) return translated;
  const candidate = nameKey?.split('.').filter((part) => part && part !== 'item' && part !== 'name').at(-1);
  return humanizeId(candidate || id);
}

export interface ContentLabels {
  skill(id: string): string;
  item(id: string): string;
}

export const ID_LABELS: ContentLabels = { skill: displayId, item: displayId };
