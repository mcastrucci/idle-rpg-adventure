import type { ExpeditionReportCodeDto, ExpeditionResultReportDto } from '@rpg/protocol';

type Row = { readonly actorId: string; readonly status: 'running' | 'completed' | 'cancelled'; readonly startsAtMs: number; readonly endsAtMs: number; readonly settledAt: Date | null; readonly outcome: 'completed' | 'retreated' | 'failed' | null };
type AnyRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is AnyRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
// Keep projections within the public protocol's signed 32-bit integer bound.
const MAX_REPORT_INT = 2_147_483_647;
const nonnegative = (value: unknown): number | null => safeInt(value) && value <= MAX_REPORT_INT ? value : null;
const stringMap = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, qty] of Object.entries(value)) {
    if (key.length === 0 || !safeInt(qty) || qty > MAX_REPORT_INT) return null;
    result[key] = qty;
  }
  return result;
};
const rows = (value: unknown): readonly unknown[] | null => Array.isArray(value) ? value : null;

function assetIdentity(value: unknown): { kind: 'gold' } | { kind: 'item'; item: string } | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'currency' && value['currency'] === 'gold') return { kind: 'gold' };
  if ((value['kind'] === 'stack' || value['kind'] === 'unique_mint') && typeof value['item'] === 'string' && value['item'].length > 0) {
    return { kind: 'item', item: value['item'] };
  }
  return null;
}
function totals(deltas: readonly unknown[] | null, actorId: string, mode: 'gross' | 'secured' | 'returned' | 'used') {
  const result = new Map<string, number>();
  if (!deltas) return null;
  for (const value of deltas) {
    if (!isRecord(value) || typeof value['actorId'] !== 'string') return null;
    if (value['actorId'] !== actorId) continue;
    if (mode === 'gross') {
      // revealedDeltas are signed net-delta entries with a container, not ledger from/to rows.
      const qty = value['qty'];
      if (!Number.isSafeInteger(qty) || Math.abs(qty as number) > MAX_REPORT_INT ||
          !(value['container'] === null || typeof value['container'] === 'string')) return null;
      const asset = assetIdentity(value['asset']);
      if (!asset) return null;
      // Consumptions reduce a bag's net delta; only positive amounts contribute to earned loot.
      if ((qty as number) <= 0) continue;
      const key = asset.kind === 'gold' ? 'currency:gold' : `item:${asset.item}`;
      const sum = (result.get(key) ?? 0) + (qty as number);
      if (!Number.isSafeInteger(sum) || sum > MAX_REPORT_INT) return null;
      result.set(key, sum);
      continue;
    }
    if (!safeInt(value['qty']) || value['qty'] > MAX_REPORT_INT) return null;
    const asset = assetIdentity(value['asset']);
    if (!asset) return null;
    const from = value['from'];
    const to = value['to'];
    const match = mode === 'secured' ? from === undefined
      : mode === 'returned' ? from === 'escrow' && typeof to === 'string'
      : from === 'escrow' && to === undefined;
    if (!match) {
      // Other valid ledger movements may be unrelated to this displayed total.
      // But a target-actor movement whose shape is not recognized makes it unknown.
      if ((mode === 'returned' || mode === 'used') && from === 'escrow' && to !== undefined && typeof to !== 'string') return null;
      if (mode === 'secured' && from === undefined && to !== undefined && to !== 'inventory') return null;
      continue;
    }
    // A grant in the terminal settlement is secured only when it leaves the simulated bag for the player.
    if (mode === 'secured' && to !== undefined && to !== 'inventory') continue;
    const key = asset.kind === 'gold' ? 'currency:gold' : `item:${asset.item}`;
    const sum = (result.get(key) ?? 0) + value['qty'];
    if (!Number.isSafeInteger(sum) || sum > MAX_REPORT_INT) return null;
    result.set(key, sum);
  }
  return result;
}
type SafeDeathCause = NonNullable<ExpeditionResultReportDto['death']>['causes'][number];
function safeCause(value: unknown): SafeDeathCause | null {
  if (!isRecord(value) || typeof value['key'] !== 'string' || value['key'].length === 0 || value['key'].length > 100) return null;
  const cause: AnyRecord = { key: value['key'] };
  for (const key of ['enemy', 'skill'] as const) if (typeof value[key] === 'string' && value[key].length <= 160) cause[key] = value[key];
  for (const key of ['amount', 'count'] as const) if (nonnegative(value[key]) !== null) cause[key] = value[key];
  if (typeof value['crit'] === 'boolean') cause['crit'] = value['crit'];
  return cause as unknown as SafeDeathCause;
}
type CodeEntry = ExpeditionReportCodeDto;
// Each entry pairs the stable i18n code with its legacy English text; the text stays until clients render from codes.
const SUGGESTIONS: readonly { readonly cause: readonly string[]; readonly code: string; readonly text: string }[] = [
  { cause: ['idle.death.no_consumables'], code: 'idle.suggestion.bring_healing', text: 'Consider bringing healing consumables.' },
  { cause: ['idle.death.out_of_consumables'], code: 'idle.suggestion.bring_more_healing', text: 'Consider bringing more healing consumables.' },
  { cause: ['idle.death.outnumbered'], code: 'idle.suggestion.review_risk_retreat', text: 'Review the expedition risk and retreat settings.' },
  { cause: ['idle.death.started_wounded'], code: 'idle.suggestion.restore_health', text: 'Restore health before starting another expedition.' },
  { cause: ['idle.death.stunned'], code: 'idle.suggestion.review_stuns', text: 'Review options for handling enemy stuns.' },
  { cause: ['idle.death.damage_taken', 'idle.death.biggest_hit'], code: 'idle.suggestion.review_defenses', text: 'Review defenses against the recorded enemy attacks.' },
];
function suggestionsFor(causes: readonly SafeDeathCause[]): { texts: string[]; codes: CodeEntry[] } {
  const keys = new Set(causes.map(cause => cause['key']));
  const hits = SUGGESTIONS.filter(entry => entry.cause.some(key => keys.has(key)));
  return { texts: hits.map(entry => entry.text), codes: hits.map(entry => ({ code: entry.code })) };
}
function eventEntries(segments: readonly unknown[]): { labels: string[]; codes: CodeEntry[] } {
  const labels: string[] = [];
  const codes: CodeEntry[] = [];
  const push = (label: string, code: string, params?: Record<string, string | number>) => {
    labels.push(label);
    codes.push(params ? { code, params } : { code });
  };
  for (const segment of segments.slice(0, 500)) {
    if (!isRecord(segment) || !Array.isArray(segment['events'])) continue;
    for (const event of segment['events']) {
      if (!isRecord(event)) continue;
      const item = typeof event['item'] === 'string' ? event['item'].slice(0, 120) : '';
      const enemy = typeof event['enemy'] === 'string' ? event['enemy'].slice(0, 120) : '';
      const qty = event['qty'];
      switch (event['type']) {
        case 'kill': if (enemy) push(`Defeated ${enemy}.`, 'idle.event.kill', { enemy }); break;
        case 'consumable': if (item && safeInt(qty)) push(`Used ${qty} ${item}.`, 'idle.event.consumable', { item, qty }); break;
        case 'loot': if (item && safeInt(qty)) push(`Found ${qty} ${item}.`, 'idle.event.loot', { item, qty }); break;
        case 'gold': if (safeInt(qty)) push(`Found ${qty} gold.`, 'idle.event.gold', { qty }); break;
        case 'death': push('A character died in combat.', 'idle.event.death'); break;
        case 'retreat': push('The party retreated.', 'idle.event.retreat'); break;
      }
      if (labels.length >= 50) return { labels: labels.slice(0, 50), codes: codes.slice(0, 50) };
    }
  }
  return { labels, codes };
}

/** Creates a presentation projection from a persisted terminal report only; never simulates, reads balances, or mutates rows. */
export function projectExpeditionResultReport(row: Row, terminalReport: unknown): ExpeditionResultReportDto {
  const report = isRecord(terminalReport) ? terminalReport : null;
  const kind = report?.['kind'];
  const recovered = kind === 'escrow_returned';
  const summary = report && isRecord(report['summary']) ? report['summary'] : null;
  const supported = !!report && report['version'] === 1 && (kind === 'settled' || recovered);
  const durationEnd = !recovered && report && safeInt(report['endsAtMs']) ? report['endsAtMs'] : null;
  const rawDuration = durationEnd === null || durationEnd < row.startsAtMs ? null : durationEnd - row.startsAtMs;
  const duration = rawDuration !== null && safeInt(rawDuration) && rawDuration <= MAX_REPORT_INT ? rawDuration : null;
  const segments = rows(report?.['segments']);
  const settledDeltas = rows(report?.['settledDeltas']);
  const revealedDeltas = rows(report?.['revealedDeltas']);
  const xpRows = rows(report?.['xp']);
  const xpRow = xpRows?.find(value => isRecord(value) && value['actorId'] === row.actorId);
  const xp = isRecord(xpRow) ? xpRow : null;
  const earnedXp = nonnegative(xp?.['xpEarned']);
  const actualPenalty = nonnegative(xp?.['xpPenaltyLost']);
  const xpAfter = nonnegative(xp?.['xpAfter']);
  const xpBefore = nonnegative(xp?.['xpBefore']);
  const xpNet = earnedXp === null || actualPenalty === null ? null : earnedXp - actualPenalty;
  const summaryKills = stringMap(summary?.['kills']);
  const killTotal = summaryKills ? Object.values(summaryKills).reduce((sum, count) => sum + count, 0) : null;
  const enemiesDefeated = killTotal !== null && Number.isSafeInteger(killTotal) && killTotal <= MAX_REPORT_INT ? killTotal : null;
  const gross = totals(revealedDeltas, row.actorId, 'gross');
  const secured = totals(settledDeltas, row.actorId, 'secured');
  let goldEarned: number | null = null;
  let goldSecured: number | null = null;
  if (gross) goldEarned = gross.get('currency:gold') ?? 0;
  if (secured) goldSecured = secured.get('currency:gold') ?? 0;
  const loot: { item: string; earned: number; lost: number; secured: number }[] | null = gross && secured ? [] : null;
  if (loot && gross && secured) {
    for (const key of new Set([...gross.keys(), ...secured.keys()])) {
      if (!key.startsWith('item:')) continue;
      const earned = gross.get(key) ?? 0;
      const kept = secured.get(key) ?? 0;
      if (earned > 0) loot.push({ item: key.slice(5), earned, lost: Math.max(0, earned - kept), secured: kept });
    }
    loot.sort((a, b) => a.item.localeCompare(b.item));
  }
  const goldLost = goldEarned === null || goldSecured === null ? null : Math.max(0, goldEarned - goldSecured);
  const returnedTotals = totals(settledDeltas, row.actorId, 'returned');
  const usedSummary = stringMap(summary?.['consumablesUsed']);
  const usedTotals = totals(settledDeltas, row.actorId, 'used');
  let consumables: { item: string; used: number | null; returned: number | null }[] | null = null;
  if (supported && (usedSummary || usedTotals || returnedTotals)) {
    const itemKeys = new Set<string>();
    for (const item of usedSummary ? Object.keys(usedSummary) : []) itemKeys.add(item);
    for (const key of [...(usedTotals ? [...usedTotals.keys()] : []), ...(returnedTotals ? [...returnedTotals.keys()] : [])])
      if (key.startsWith('item:')) itemKeys.add(key.slice(5));
    consumables = [...itemKeys].sort().map(item => ({ item,
      used: recovered ? null : usedSummary ? usedSummary[item] ?? 0 : usedTotals ? usedTotals.get(`item:${item}`) ?? 0 : null,
      returned: returnedTotals ? returnedTotals.get(`item:${item}`) ?? 0 : null }));
  }
  const deathLog = isRecord(summary?.['deathLog']) ? summary['deathLog'] : null;
  const rawCauses = deathLog?.['causes'];
  const parsedCauses = Array.isArray(rawCauses) && rawCauses.length <= 20 ? rawCauses.map(safeCause) : null;
  const causes = parsedCauses && parsedCauses.every((cause): cause is SafeDeathCause => cause !== null) &&
    (deathLog?.['actorId'] === undefined || deathLog['actorId'] === row.actorId) ? parsedCauses : null;
  const advice = causes ? suggestionsFor(causes) : null;
  const death = deathLog && causes && advice ? { causes, suggestions: advice.texts, suggestionCodes: advice.codes } : null;
  const eventList = supported && !recovered && segments ? eventEntries(segments) : null;
  const hpRows = rows(summary?.['hp']);
  const hpRow = hpRows?.find(value => isRecord(value) && value['actorId'] === row.actorId);
  const hp = isRecord(hpRow) ? nonnegative(hpRow['end']) : null;
  const maxHp = isRecord(hpRow) ? nonnegative(hpRow['maxHp']) : null;
  const rawOutcome = report?.['outcome'] ?? (row.outcome ?? (report?.['reason'] === 'version_unavailable' ? 'version_unavailable' : null));
  const outcome = ['completed', 'retreated', 'failed', 'cancelled', 'version_unavailable'].includes(String(rawOutcome))
    ? rawOutcome as ExpeditionResultReportDto['outcome'] : row.status === 'cancelled' ? 'cancelled' : row.outcome;
  const unknown = !supported;
  return {
    availability: unknown ? 'legacy_unavailable' : recovered ? 'returned_escrow' : 'available',
    effectiveDurationMs: unknown ? null : duration,
    outcome: unknown ? (row.status === 'cancelled' ? 'cancelled' : outcome) : outcome,
    enemiesDefeated: unknown || recovered ? null : enemiesDefeated,
    xp: { earned: unknown || recovered ? null : earnedXp, penaltyLost: unknown || recovered ? null : actualPenalty,
      net: unknown || recovered ? null : xpNet, beforeTotal: unknown || recovered ? null : xpBefore, afterTotal: unknown || recovered ? null : xpAfter },
    gold: { earned: unknown || recovered ? null : goldEarned, lost: unknown || recovered ? null : goldLost, secured: unknown || recovered ? null : goldSecured },
    loot: unknown || recovered ? null : loot,
    consumables: unknown ? null : consumables,
    events: eventList ? eventList.labels : null,
    eventCodes: eventList ? eventList.codes : null,
    finalState: { hp: unknown || recovered ? null : hp, maxHp: unknown || recovered ? null : maxHp, xpTotal: unknown || recovered ? null : xpAfter },
    death: unknown || recovered ? null : death,
  };
}
