import type { CommandJson } from './commands.ts';

export interface ExpeditionConsumableConfig {
  readonly item: string;
  readonly qty: number;
}

export interface ExpeditionConfig {
  readonly consumables: readonly ExpeditionConsumableConfig[];
  readonly retreat: { readonly belowHpBp: number; readonly onlyWhenNoHealing: boolean };
}

export interface ExpeditionStartPayload {
  readonly actorId: string;
  readonly request: { readonly areaId: string; readonly activityId: string; readonly durationMin: number; readonly paceBp: number };
  readonly config: ExpeditionConfig;
}

export interface ExpeditionCancelPayload { readonly expeditionId: string }

export interface ExpeditionOptionsDto {
  readonly actorId: string;
  readonly areas: readonly {
    readonly areaId: string;
    readonly kind: string;
    readonly activities: readonly { readonly activityId: string; readonly simulatorId: string; readonly available: boolean; readonly reason?: string }[];
  }[];
  readonly durationsMin: readonly number[];
  readonly paceBp: { readonly min: number; readonly max: number; readonly default: number };
  readonly consumables: readonly { readonly item: string; readonly availableQty: number }[];
}

export interface ExpeditionCancelPreviewDto {
  readonly rewards: readonly { readonly asset: CommandJson; readonly qty: number }[];
  readonly consumablesUsed: readonly { readonly item: string; readonly qty: number }[];
  readonly consumablesReturned: readonly { readonly item: string; readonly qty: number }[];
  readonly keptProgress: readonly { readonly actorId: string; readonly xpEarned: number; readonly died: boolean; readonly deathPenaltyApplied: boolean }[];
  readonly converted: boolean;
}

/** Client-visible expedition state. `segments` contains only entries revealed by the server's cutoff. */
export interface ExpeditionDto {
  readonly id: string;
  readonly actorId: string;
  readonly state: 'running' | 'completed' | 'cancelled';
  readonly areaId: string;
  readonly activityId: string;
  readonly startsAtMs: number;
  readonly plannedEndsAtMs: number;
  readonly progress: { readonly revealed: number };
  readonly segments: readonly { readonly index: number; readonly revealAtMs: number; readonly events: readonly CommandJson[] }[];
  readonly revealedDeltas: CommandJson;
  readonly summary?: CommandJson;
  readonly cancelPreview?: ExpeditionCancelPreviewDto;
  readonly endsAtMs?: number;
  readonly outcome?: CommandJson;
}

export function parseExpeditionStartPayload(input: unknown): ExpeditionStartPayload {
  const root = record(input, ['actorId', 'request', 'config']);
  const request = record(root['request'], ['areaId', 'activityId', 'durationMin', 'paceBp']);
  const config = record(root['config'], ['consumables', 'retreat']);
  const retreat = record(config['retreat'], ['belowHpBp', 'onlyWhenNoHealing']);
  if (typeof root['actorId'] !== 'string' || !uuid.test(root['actorId']) ||
      typeof request['areaId'] !== 'string' || request['areaId'].length === 0 ||
      typeof request['activityId'] !== 'string' || request['activityId'].length === 0 ||
      !positiveInt(request['durationMin']) || !positiveInt(request['paceBp']) ||
      !Array.isArray(config['consumables']) || !Number.isInteger(retreat['belowHpBp']) ||
      (retreat['belowHpBp'] as number) < 0 || (retreat['belowHpBp'] as number) > 10_000 ||
      typeof retreat['onlyWhenNoHealing'] !== 'boolean') throw new TypeError('invalid expedition.start payload');
  const consumables = config['consumables'].map((raw) => {
    const item = record(raw, ['item', 'qty']);
    if (typeof item['item'] !== 'string' || item['item'].length === 0 || !positiveInt(item['qty'])) throw new TypeError('invalid expedition consumable');
    return Object.freeze({ item: item['item'], qty: item['qty'] as number });
  });
  return Object.freeze({
    actorId: root['actorId'].toLowerCase(),
    request: Object.freeze({ areaId: request['areaId'], activityId: request['activityId'], durationMin: request['durationMin'] as number, paceBp: request['paceBp'] as number }),
    config: Object.freeze({ consumables: Object.freeze(consumables), retreat: Object.freeze({ belowHpBp: retreat['belowHpBp'] as number, onlyWhenNoHealing: retreat['onlyWhenNoHealing'] }) }),
  });
}

export function parseExpeditionCancelPayload(input: unknown): ExpeditionCancelPayload {
  const root = record(input, ['expeditionId']);
  if (typeof root['expeditionId'] !== 'string' || !uuid.test(root['expeditionId'])) throw new TypeError('invalid expedition.cancel payload');
  return Object.freeze({ expeditionId: root['expeditionId'].toLowerCase() });
}

/** Rejects extra response keys as well as hidden/unrevealed timeline fields at the top level. */
export function parseExpeditionDto(input: unknown): ExpeditionDto {
  const root = record(input, ['id', 'actorId', 'state', 'areaId', 'activityId', 'startsAtMs', 'plannedEndsAtMs', 'progress', 'segments', 'revealedDeltas', 'summary', 'cancelPreview', 'endsAtMs', 'outcome']);
  const progress = record(root['progress'], ['revealed']);
  if (typeof root['id'] !== 'string' || !uuid.test(root['id']) || typeof root['actorId'] !== 'string' || !uuid.test(root['actorId']) ||
      !['running', 'completed', 'cancelled'].includes(String(root['state'])) || typeof root['areaId'] !== 'string' || typeof root['activityId'] !== 'string' ||
      !finite(root['startsAtMs']) || !finite(root['plannedEndsAtMs']) || !nonnegativeInt(progress['revealed']) || !Array.isArray(root['segments']) ||
      !isJson(root['revealedDeltas'])) throw new TypeError('invalid expedition DTO');
  const segments = root['segments'].map((raw) => {
    const segment = record(raw, ['index', 'revealAtMs', 'events']);
    if (!nonnegativeInt(segment['index']) || !finite(segment['revealAtMs']) || !Array.isArray(segment['events']) || !segment['events'].every(isJson)) throw new TypeError('invalid expedition segment');
    return Object.freeze({ index: segment['index'] as number, revealAtMs: segment['revealAtMs'] as number, events: Object.freeze(segment['events'] as CommandJson[]) });
  });
  if (root['state'] === 'running' && (root['endsAtMs'] !== undefined || root['outcome'] !== undefined)) throw new TypeError('running expedition exposes terminal outcome');
  if (root['state'] === 'running' && root['cancelPreview'] === undefined) throw new TypeError('running expedition is missing its cancellation preview');
  if (root['state'] !== 'running' && (!finite(root['endsAtMs']) || !isJson(root['outcome']))) throw new TypeError('terminal expedition is missing final outcome');
  const result: ExpeditionDto = {
    id: root['id'], actorId: root['actorId'], state: root['state'] as ExpeditionDto['state'], areaId: root['areaId'], activityId: root['activityId'],
    startsAtMs: root['startsAtMs'] as number, plannedEndsAtMs: root['plannedEndsAtMs'] as number,
    progress: Object.freeze({ revealed: progress['revealed'] as number }), segments: Object.freeze(segments), revealedDeltas: root['revealedDeltas'] as CommandJson,
    ...(root['summary'] === undefined ? {} : { summary: jsonValue(root['summary']) }),
    ...(root['cancelPreview'] === undefined ? {} : { cancelPreview: parseCancelPreview(root['cancelPreview']) }),
    ...(root['endsAtMs'] === undefined ? {} : { endsAtMs: root['endsAtMs'] as number }),
    ...(root['outcome'] === undefined ? {} : { outcome: jsonValue(root['outcome']) }),
  };
  return Object.freeze(result);
}

export function parseExpeditionOptionsDto(input: unknown): ExpeditionOptionsDto {
  const root = record(input, ['actorId', 'areas', 'durationsMin', 'paceBp', 'consumables']);
  const pace = record(root['paceBp'], ['min', 'max', 'default']);
  if (typeof root['actorId'] !== 'string' || !uuid.test(root['actorId']) || !Array.isArray(root['areas']) || !Array.isArray(root['durationsMin']) ||
      !root['durationsMin'].every(positiveInt) || !Array.isArray(root['consumables']) || !positiveInt(pace['min']) || !positiveInt(pace['max']) ||
      !positiveInt(pace['default']) || (pace['min'] as number) > (pace['default'] as number) || (pace['default'] as number) > (pace['max'] as number)) throw new TypeError('invalid expedition options DTO');
  const areas = root['areas'].map((raw) => {
    const area = record(raw, ['areaId', 'kind', 'activities']);
    if (typeof area['areaId'] !== 'string' || typeof area['kind'] !== 'string' || !Array.isArray(area['activities'])) throw new TypeError('invalid expedition option area');
    const activities = area['activities'].map((rawActivity) => {
      const activity = record(rawActivity, ['activityId', 'simulatorId', 'available', 'reason']);
      if (typeof activity['activityId'] !== 'string' || typeof activity['simulatorId'] !== 'string' || typeof activity['available'] !== 'boolean' ||
          (activity['reason'] !== undefined && typeof activity['reason'] !== 'string')) throw new TypeError('invalid expedition option activity');
      return Object.freeze({ activityId: activity['activityId'], simulatorId: activity['simulatorId'], available: activity['available'], ...(activity['reason'] === undefined ? {} : { reason: activity['reason'] as string }) });
    });
    return Object.freeze({ areaId: area['areaId'], kind: area['kind'], activities: Object.freeze(activities) });
  });
  const consumables = root['consumables'].map((raw) => {
    const item = record(raw, ['item', 'availableQty']);
    if (typeof item['item'] !== 'string' || !nonnegativeInt(item['availableQty'])) throw new TypeError('invalid expedition option consumable');
    return Object.freeze({ item: item['item'], availableQty: item['availableQty'] as number });
  });
  return Object.freeze({ actorId: root['actorId'].toLowerCase(), areas: Object.freeze(areas), durationsMin: Object.freeze(root['durationsMin'] as number[]),
    paceBp: Object.freeze({ min: pace['min'] as number, max: pace['max'] as number, default: pace['default'] as number }), consumables: Object.freeze(consumables) });
}

function parseCancelPreview(input: unknown): ExpeditionCancelPreviewDto {
  const root = record(input, ['rewards', 'consumablesUsed', 'consumablesReturned', 'keptProgress', 'converted']);
  if (!Array.isArray(root['rewards']) || !Array.isArray(root['consumablesUsed']) || !Array.isArray(root['consumablesReturned']) ||
      !Array.isArray(root['keptProgress']) || typeof root['converted'] !== 'boolean') throw new TypeError('invalid cancel preview');
  const rewards = root['rewards'].map((raw) => {
    const row = record(raw, ['asset', 'qty']);
    if (!isJson(row['asset']) || !nonnegativeInt(row['qty'])) throw new TypeError('invalid preview reward');
    return Object.freeze({ asset: row['asset'] as CommandJson, qty: row['qty'] as number });
  });
  const consumables = (value: unknown): readonly { item: string; qty: number }[] => {
    if (!Array.isArray(value)) throw new TypeError('invalid preview consumable rows');
    return Object.freeze(value.map((raw) => {
      const row = record(raw, ['item', 'qty']);
      if (typeof row['item'] !== 'string' || !nonnegativeInt(row['qty'])) throw new TypeError('invalid preview consumable row');
      return Object.freeze({ item: row['item'], qty: row['qty'] as number });
    }));
  };
  const keptProgress = Object.freeze(root['keptProgress'].map((raw) => {
    const row = record(raw, ['actorId', 'xpEarned', 'died', 'deathPenaltyApplied']);
    if (typeof row['actorId'] !== 'string' || !uuid.test(row['actorId']) || !nonnegativeInt(row['xpEarned']) || typeof row['died'] !== 'boolean' || typeof row['deathPenaltyApplied'] !== 'boolean') throw new TypeError('invalid preview progress');
    return Object.freeze({ actorId: row['actorId'].toLowerCase(), xpEarned: row['xpEarned'] as number, died: row['died'], deathPenaltyApplied: row['deathPenaltyApplied'] });
  }));
  return Object.freeze({ rewards: Object.freeze(rewards), consumablesUsed: consumables(root['consumablesUsed']), consumablesReturned: consumables(root['consumablesReturned']), keptProgress, converted: root['converted'] });
}

function record(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('expected object');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !allowed.includes(key) || !('value' in (descriptors[key] ?? {})))) throw new TypeError('unexpected or unsafe object property');
  return input as Record<string, unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonnegativeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function isJson(value: unknown): value is CommandJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).every((key) => isJson((value as Record<string, unknown>)[key]));
  return false;
}
function jsonValue(value: unknown): CommandJson {
  if (!isJson(value)) throw new TypeError('invalid JSON value');
  return value;
}
