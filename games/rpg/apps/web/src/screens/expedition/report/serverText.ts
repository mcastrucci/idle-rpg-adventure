import type { ExpeditionReportCodeDto } from '@rpg/protocol';

import { labelOrHumanized } from '../../../content/labels.ts';
import { has, t } from '../../../i18n/index.ts';

/** Sentences the server currently writes in English into the persisted report; mapped to catalog keys. */
const SUGGESTION_KEYS: Readonly<Record<string, string>> = {
  'Consider bringing healing consumables.': 'ui.report.suggestion.bring_healing',
  'Consider bringing more healing consumables.': 'ui.report.suggestion.bring_more_healing',
  'Review the expedition risk and retreat settings.': 'ui.report.suggestion.review_risk',
  'Restore health before starting another expedition.': 'ui.report.suggestion.restore_health',
  'Review options for handling enemy stuns.': 'ui.report.suggestion.stuns',
  'Review defenses against the recorded enemy attacks.': 'ui.report.suggestion.defenses',
};

const FIXED_EVENT_KEYS: Readonly<Record<string, string>> = {
  'A character died in combat.': 'ui.report.event_died',
  'The party retreated.': 'ui.report.event_retreated',
};

/** `Defeated X.`, `Used 2 X.`, `Found 3 X.`, `Found 5 gold.` as the server writes them. */
const EVENT_PATTERNS: readonly { readonly pattern: RegExp; readonly render: (match: RegExpExecArray) => string }[] = [
  { pattern: /^Defeated (.+)\.$/, render: (m) => t('ui.report.event_defeated', { enemy: labelOrHumanized(m[1] ?? '') }) },
  { pattern: /^Used (\d+) (.+)\.$/, render: (m) => t('ui.report.event_used', { qty: m[1] ?? '', item: labelOrHumanized(m[2] ?? '') }) },
  { pattern: /^Found (\d+) gold\.$/, render: (m) => t('ui.report.event_found_gold', { qty: m[1] ?? '' }) },
  { pattern: /^Found (\d+) (.+)\.$/, render: (m) => t('ui.report.event_found', { qty: m[1] ?? '', item: labelOrHumanized(m[2] ?? '') }) },
];

/**
 * The server writes the report's event lines and suggestions as English text, not keys. Known sentences are translated
 * here; anything unrecognized is shown as received until the server sends catalog keys.
 */
export function localizeEventLine(line: string): string {
  const fixed = FIXED_EVENT_KEYS[line];
  if (fixed !== undefined) return t(fixed);
  for (const { pattern, render } of EVENT_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return render(match);
  }
  return line;
}

export function localizeSuggestion(text: string): string {
  const key = SUGGESTION_KEYS[text];
  return key === undefined ? text : t(key);
}

/** Wire shape of a server code with scalar params (`docs/spec/i18n-codes.md`). */
export type ReportCode = ExpeditionReportCodeDto;

const CONTENT_PARAMS = new Set(['enemy', 'item', 'skill']);

/** Renders `ui.code.<code>`; `enemy`/`item`/`skill` params are content IDs and resolve to display names. */
export function renderReportCode(entry: ReportCode): string | undefined {
  const key = `ui.code.${entry.code}`;
  if (!has(key)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(entry.params ?? {})) {
    params[name] = CONTENT_PARAMS.has(name) && typeof value === 'string' ? labelOrHumanized(value) : value;
  }
  return t(key, params);
}

/** Code first (when present and known), legacy English line otherwise. */
export function eventLine(line: string, code: ReportCode | undefined): string {
  return (code && renderReportCode(code)) ?? localizeEventLine(line);
}

export function suggestionLine(text: string, code: ReportCode | undefined): string {
  return (code && renderReportCode(code)) ?? localizeSuggestion(text);
}
