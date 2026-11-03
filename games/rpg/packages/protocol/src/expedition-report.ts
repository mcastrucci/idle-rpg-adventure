/** Safe, persisted-only presentation of an expedition's terminal result. Null means the stored source did not support it. */
export interface ExpeditionResultReportDto {
  readonly availability: 'available' | 'returned_escrow' | 'legacy_unavailable';
  readonly effectiveDurationMs: number | null;
  readonly outcome: 'completed' | 'retreated' | 'failed' | 'cancelled' | 'version_unavailable' | null;
  readonly enemiesDefeated: number | null;
  readonly xp: {
    readonly earned: number | null;
    readonly penaltyLost: number | null;
    readonly net: number | null;
    /** Historical total XP, as recorded at settlement; no conversion through current progression rules. */
    readonly beforeTotal: number | null;
    readonly afterTotal: number | null;
  };
  readonly gold: { readonly earned: number | null; readonly lost: number | null; readonly secured: number | null };
  readonly loot: readonly { readonly item: string; readonly earned: number; readonly lost: number; readonly secured: number }[] | null;
  readonly consumables: readonly { readonly item: string; readonly used: number | null; readonly returned: number | null }[] | null;
  /** Short server-safe labels derived only from persisted, cutoff-revealed events. */
  readonly events: readonly string[] | null;
  readonly finalState: { readonly hp: number | null; readonly maxHp: number | null; readonly xpTotal: number | null };
  readonly death: null | {
    readonly causes: readonly {
      readonly key: string;
      readonly enemy?: string;
      readonly skill?: string;
      readonly amount?: number;
      readonly count?: number;
      readonly crit?: boolean;
    }[];
    readonly suggestions: readonly string[];
  };
}

const MAX_ITEMS = 500;
const MAX_EVENTS = 50;
const MAX_TEXT = 160;
const MAX_INT = 2_147_483_647;
const record = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid expedition report');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new TypeError('invalid expedition report');
  return row;
};
const nonnegativeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT;
const nullableInt = (value: unknown): value is number | null => value === null || nonnegativeInt(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
const textList = (value: unknown, max: number): value is readonly string[] => Array.isArray(value) && value.length <= max && value.every(text);

export function parseExpeditionResultReportDto(input: unknown): ExpeditionResultReportDto {
  const row = record(input, ['availability', 'effectiveDurationMs', 'outcome', 'enemiesDefeated', 'xp', 'gold', 'loot', 'consumables', 'events', 'finalState', 'death']);
  if (!['available', 'returned_escrow', 'legacy_unavailable'].includes(String(row['availability'])) ||
      !nullableInt(row['effectiveDurationMs']) ||
      !(row['outcome'] === null || ['completed', 'retreated', 'failed', 'cancelled', 'version_unavailable'].includes(String(row['outcome']))) ||
      !nullableInt(row['enemiesDefeated']) || !(row['loot'] === null || (Array.isArray(row['loot']) && row['loot'].length <= MAX_ITEMS)) ||
      !(row['consumables'] === null || (Array.isArray(row['consumables']) && row['consumables'].length <= MAX_ITEMS)) ||
      !(row['events'] === null || textList(row['events'], MAX_EVENTS))) throw new TypeError('invalid expedition report');
  const xp = record(row['xp'], ['earned', 'penaltyLost', 'net', 'beforeTotal', 'afterTotal']);
  if (!nullableInt(xp['earned']) || !nullableInt(xp['penaltyLost']) ||
      !(xp['net'] === null || (Number.isSafeInteger(xp['net']) && Math.abs(xp['net'] as number) <= MAX_INT)) ||
      !nullableInt(xp['beforeTotal']) || !nullableInt(xp['afterTotal'])) throw new TypeError('invalid expedition report XP');
  const gold = record(row['gold'], ['earned', 'lost', 'secured']);
  if (!nullableInt(gold['earned']) || !nullableInt(gold['lost']) || !nullableInt(gold['secured'])) throw new TypeError('invalid expedition report gold');
  const loot = row['loot'] === null ? null : row['loot'].map(raw => {
    const item = record(raw, ['item', 'earned', 'lost', 'secured']);
    if (!text(item['item']) || !nullableInt(item['earned']) || item['earned'] === null || !nullableInt(item['lost']) || item['lost'] === null || !nullableInt(item['secured']) || item['secured'] === null) throw new TypeError('invalid expedition report loot');
    return Object.freeze({ item: item['item'], earned: item['earned'], lost: item['lost'], secured: item['secured'] });
  });
  const consumables = row['consumables'] === null ? null : row['consumables'].map(raw => {
    const item = record(raw, ['item', 'used', 'returned']);
    if (!text(item['item']) || !nullableInt(item['used']) || !nullableInt(item['returned'])) throw new TypeError('invalid expedition report consumable');
    return Object.freeze({ item: item['item'], used: item['used'], returned: item['returned'] });
  });
  const finalState = record(row['finalState'], ['hp', 'maxHp', 'xpTotal']);
  if (!nullableInt(finalState['hp']) || !nullableInt(finalState['maxHp']) || !nullableInt(finalState['xpTotal'])) throw new TypeError('invalid expedition report final state');
  let death: ExpeditionResultReportDto['death'] = null;
  if (row['death'] !== null) {
    const d = record(row['death'], ['causes', 'suggestions']);
    if (!Array.isArray(d['causes']) || d['causes'].length > 20 || !textList(d['suggestions'], 20)) throw new TypeError('invalid expedition report death');
    const causes = d['causes'].map(raw => {
      const cause = record(raw, ['key', 'enemy', 'skill', 'amount', 'count', 'crit']);
      if (!text(cause['key']) || (cause['enemy'] !== undefined && !text(cause['enemy'])) || (cause['skill'] !== undefined && !text(cause['skill'])) ||
          (cause['amount'] !== undefined && !nonnegativeInt(cause['amount'])) || (cause['count'] !== undefined && !nonnegativeInt(cause['count'])) ||
          (cause['crit'] !== undefined && typeof cause['crit'] !== 'boolean')) throw new TypeError('invalid expedition report death cause');
      return Object.freeze({ key: cause['key'] as string, ...(cause['enemy'] === undefined ? {} : { enemy: cause['enemy'] as string }),
        ...(cause['skill'] === undefined ? {} : { skill: cause['skill'] as string }), ...(cause['amount'] === undefined ? {} : { amount: cause['amount'] as number }),
        ...(cause['count'] === undefined ? {} : { count: cause['count'] as number }), ...(cause['crit'] === undefined ? {} : { crit: cause['crit'] as boolean }) });
    });
    death = Object.freeze({ causes: Object.freeze(causes), suggestions: Object.freeze([...(d['suggestions'] as readonly string[])]) });
  }
  return Object.freeze({ availability: row['availability'] as ExpeditionResultReportDto['availability'], effectiveDurationMs: row['effectiveDurationMs'] as number | null,
    outcome: row['outcome'] as ExpeditionResultReportDto['outcome'], enemiesDefeated: row['enemiesDefeated'] as number | null,
    xp: Object.freeze({ earned: xp['earned'] as number | null, penaltyLost: xp['penaltyLost'] as number | null, net: xp['net'] as number | null,
      beforeTotal: xp['beforeTotal'] as number | null, afterTotal: xp['afterTotal'] as number | null }),
    gold: Object.freeze({ earned: gold['earned'] as number | null, lost: gold['lost'] as number | null, secured: gold['secured'] as number | null }),
    loot: loot === null ? null : Object.freeze(loot),
    consumables: consumables === null ? null : Object.freeze(consumables), events: row['events'] === null ? null : Object.freeze([...(row['events'] as readonly string[])]),
    finalState: Object.freeze({ hp: finalState['hp'] as number | null, maxHp: finalState['maxHp'] as number | null,
      xpTotal: finalState['xpTotal'] as number | null }), death });
}
