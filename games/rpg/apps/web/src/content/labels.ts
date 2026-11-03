const KNOWN_LABELS: Readonly<Record<string, string>> = {
  'area.region_1.name': 'The Verdant Hollow',
  'area:region_1': 'The Verdant Hollow',
  'area.region_2.name': 'Region 2',
  'area:region_2': 'Region 2',
};

/** Humanize a stable content ID or a localization key when no translated label is available. */
export function displayLabel(value: string): string {
  const known = KNOWN_LABELS[value];
  if (known) return known;
  if (!/[.:/_-]/.test(value)) return value.trim();
  const normalized = value.trim().replace(/\.name$/i, '').replace(/^[a-z][a-z0-9_-]*[.:]/i, '')
    .replace(/(^|[.:/_-])region[_-]?\d+(?=$|[.:/_-])/gi, '$1');
  const words = normalized.split(/[.:/_-]+/).filter(Boolean);
  const readable = words.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return readable ? readable.replace(/\b\w/g, (letter) => letter.toUpperCase()) : value;
}

/** Legacy display fallback used outside live screens; command payloads retain the original value. */
export function displayId(id: string): string {
  const raw = id.slice(id.indexOf(':') + 1).replaceAll('_', ' ').replaceAll('.', ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export interface ContentLabels {
  skill(id: string): string;
  item(id: string): string;
}

export const ID_LABELS: ContentLabels = { skill: displayId, item: displayId };
