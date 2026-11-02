/**
 * Display labels for content IDs. GAP: the server has no client content endpoint yet (`GET /content` is metadata only),
 * so names are derived from the stable IDs (`skill:shield_bash` → `Shield bash`). Swap `ID_LABELS` for real names once
 * the endpoint exists; IDs never change (ADR-0008).
 */
export function displayId(id: string): string {
  const raw = id.slice(id.indexOf(':') + 1).replaceAll('_', ' ').replaceAll('.', ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export interface ContentLabels {
  skill(id: string): string;
  item(id: string): string;
}

export const ID_LABELS: ContentLabels = { skill: displayId, item: displayId };
