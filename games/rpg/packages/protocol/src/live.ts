import type { CommandJson } from './commands.ts';
import { z } from 'zod';

export type LiveJson = CommandJson;

export interface LiveResumeCursor { readonly epoch: number; readonly seq: number }
export interface LiveAttachRequest {
  readonly op: 'live.attach';
  readonly instanceId: string;
  readonly actorId: string;
  readonly resume?: LiveResumeCursor;
}
export interface LiveCommandRequest {
  readonly op: 'live.command';
  readonly instanceId: string;
  readonly actorId: string;
  readonly commandId: string;
  readonly command: LiveJson;
}
export type LiveClientRequest = LiveAttachRequest | LiveCommandRequest;

export interface LiveParticipantDto {
  readonly actorId: string;
  readonly status: 'connected' | 'disconnected' | 'leaving' | 'left';
}
export interface LiveRunBagDto {
  readonly actorId: string;
  readonly items: readonly { readonly item: string; readonly qty: number }[];
  readonly gold: number;
  readonly uniques?: readonly { readonly itemId: string; readonly definition: string; readonly slot: string | null; readonly rolls: LiveJson }[];
}
export interface LiveDeathContentsDto {
  readonly stacks: readonly { readonly item: string; readonly qty: number }[];
  readonly gold: number;
  readonly uniques: readonly { readonly itemId: string; readonly definition: string; readonly slot: string | null; readonly rolls: LiveJson }[];
}
export interface LiveDeathSummaryDto {
  readonly deathId: string; readonly occurredAt: number; readonly areaId: string; readonly locationId: string;
  readonly xpBefore: { readonly level: number; readonly xpIntoLevel: number; readonly totalXp: number };
  readonly xpLost: number;
  readonly xpAfter: { readonly level: number; readonly xpIntoLevel: number; readonly totalXp: number };
  readonly causes: readonly { readonly sourceId: string; readonly label: string; readonly damage: number }[];
  readonly corpse: { readonly id: string; readonly status: 'active' | 'recovered' | 'expired' | 'invalidated'; readonly expiresAt: number; readonly contents: LiveDeathContentsDto };
}
export interface LiveDeathResponseDto { readonly death: LiveDeathSummaryDto | null }
export interface LiveAreaOptionDto { readonly id: string; readonly label: string; readonly startLocationId: string }
export interface LiveSupplyOptionDto { readonly item: string; readonly label: string; readonly availableQty: number }
export interface LiveOptionsDto { readonly actorId: string; readonly areas: readonly LiveAreaOptionDto[]; readonly supplies: readonly LiveSupplyOptionDto[] }
export interface LiveStartRequestDto {
  readonly commandId: string;
  readonly actorId: string;
  readonly areaId: string;
  readonly supplies: readonly { readonly item: string; readonly qty: number }[];
}
export interface LiveStartResponseDto { readonly instanceId: string }
export interface LiveCurrentDto {
  readonly instanceId: string;
  readonly actorId: string;
  readonly view: LiveViewDto;
  readonly participants: readonly LiveParticipantDto[];
}
export interface LiveCurrentResponseDto { readonly current: LiveCurrentDto | null }
export interface LiveSkillDto {
  readonly id: string;
  readonly labelKey?: string;
  readonly slot: number;
  readonly cooldownTicks: number;
  readonly cooldownRemainingTicks: number;
  readonly windupTicks: number;
}
export interface LiveHeroDto {
  readonly actorId: string;
  readonly level?: number;
  /** Total XP of the hero in this adventure (server authoritative, already persisted per victory). */
  readonly xp?: number;
  /** XP inside the current level, and the XP the level requires (`null` at the level cap). */
  readonly xpIntoLevel?: number;
  readonly xpToNext?: number | null;
  readonly hp: number | null;
  readonly maxHp: number;
  readonly present: boolean;
  readonly consumables: readonly { readonly item: string; readonly labelKey?: string; readonly qty: number }[];
  readonly skills?: readonly LiveSkillDto[];
  readonly automationEnabled?: boolean;
}
export interface LiveActiveEffectDto {
  readonly id: number;
  readonly origin: string;
  readonly originLabelKey?: string;
  readonly sourceId: string;
  readonly remaining: number;
  readonly unit: 'ticks' | 'actions' | 'attacks';
  readonly type: string;
  readonly amount?: number;
  readonly school?: string;
  readonly stat?: string;
}
export type LiveQueuedActionDto =
  | { readonly kind: 'useSkill'; readonly skill: string; readonly labelKey?: string; readonly target: string | null }
  | { readonly kind: 'useConsumable'; readonly item: string; readonly labelKey?: string };
export interface LiveWindupDto { readonly skill: string; readonly labelKey?: string; readonly targetIds: readonly string[]; readonly startedTick: number; readonly resolveAtTick: number }
export interface LiveBossRiskDto {
  readonly locationId: string;
  readonly enemies: readonly { readonly enemy: string; readonly rank: string; readonly level: number }[];
  readonly heroes: readonly { readonly actorId: string; readonly hp: number; readonly maxHp: number; readonly healingConsumables: number }[];
  readonly retreatAllowed: false;
  readonly onDeath: readonly string[];
  readonly deathConsequences: readonly { readonly actorId: string; readonly xpLost: number; readonly xpBeforeTotal: number;
    readonly runBag: { readonly items: readonly { readonly item: string; readonly qty: number }[]; readonly gold: number;
      readonly uniques: readonly { readonly itemId: string; readonly definition: string; readonly slot: string | null; readonly rolls: LiveJson }[] } }[];
}
export interface LiveCombatActorDto {
  readonly id: string;
  readonly side: 'hero' | 'enemy';
  readonly hp: number;
  readonly maxHp?: number;
  readonly alive: boolean;
  readonly labelKey?: string;
  readonly auto?: boolean;
  readonly queued?: LiveQueuedActionDto | null;
  readonly windup?: LiveWindupDto | null;
  readonly cooldowns?: readonly { readonly skill: string; readonly readyAtTick: number; readonly remainingTicks: number }[];
  readonly effects?: readonly LiveActiveEffectDto[];
}
/** Client-safe projection of the current game view. Game-specific view fields remain JSON data. */
export interface LiveViewDto {
  readonly phase?: string;
  readonly heroes?: readonly LiveHeroDto[];
  readonly combat?: { readonly tick: number; readonly groupId: string | null; readonly actors: readonly LiveCombatActorDto[] } | null;
  readonly runBag?: readonly LiveRunBagDto[];
  readonly [key: string]: unknown;
}
export type LiveServerFrame =
  | { readonly type: 'authenticated'; readonly accountId: string }
  | { readonly type: 'live.attached'; readonly instanceId: string; readonly mode: 'snapshot' | 'resume' }
  | { readonly type: 'live.ack'; readonly instanceId: string; readonly commandId: string; readonly status: 'applied' | 'rejected'; readonly duplicate: boolean; readonly reason?: string }
  | { readonly type: 'live.error'; readonly error: string }
  | { readonly type: 'live.snapshot'; readonly instanceId: string; readonly epoch: number; readonly seq: number; readonly view: LiveViewDto; readonly participants: readonly LiveParticipantDto[] }
  | { readonly type: 'live.event'; readonly instanceId: string; readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson }
  | { readonly type: 'live.closed'; readonly instanceId: string; readonly outcome: string; readonly result: LiveJson }
  | { readonly type: 'live.evicted'; readonly instanceId: string; readonly reason: string };

export const LIVE_JSON_MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_KEYS = new Set(['checkpoint', 'state', 'stateAfter', 'seed', 'content', 'contentHash', 'contentBundle', 'compiledContent',
  'rngState', 'rng', 'commandsLog', 'setup', 'pending', 'rawContent']);
const GAME_EVENT_TYPES = new Set(['traveled', 'discovered', 'combatStarted', 'combat', 'combatEnded', 'combatRewards', 'retreated', 'bossRoomWarning',
  'hotspotInteracted', 'gathered', 'consumableUsed', 'returned', 'heroLeft', 'heroDied', 'corpseRecovered', 'participant']);
const COMBAT_EVENT_TYPES = new Set(['CombatStarted', 'ActionStarted', 'TelegraphStarted', 'ActionInterrupted', 'ActionSkipped', 'DamageDealt',
  'Healed', 'EffectApplied', 'EffectExpired', 'Cleansed', 'EffectNegated', 'ConsumableUsed', 'ActorDied', 'PhaseChanged', 'AutoToggled',
  'InputRejected', 'CombatEnded']);
const boundedText = z.string().min(1).max(512);
const uuidSchema = z.string().regex(UUID).transform((value) => value.toLowerCase());
const counterSchema = z.number().int().safe().nonnegative();
const positiveCounterSchema = counterSchema.refine((value) => value > 0);
const jsonSchema = z.unknown().transform((value) => safeJson(value));
const resumeSchema = z.strictObject({ epoch: counterSchema, seq: counterSchema });
const clientRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('live.attach'), instanceId: uuidSchema, actorId: uuidSchema, resume: resumeSchema.optional() }),
  z.strictObject({ op: z.literal('live.command'), instanceId: uuidSchema, actorId: uuidSchema, commandId: uuidSchema, command: jsonSchema }),
]);
const participantSchema = z.strictObject({ actorId: uuidSchema, status: z.enum(['connected', 'disconnected', 'leaving', 'left']) });
const areaOptionSchema = z.strictObject({ id: boundedText, label: boundedText, startLocationId: boundedText });
const supplyOptionSchema = z.strictObject({ item: boundedText, label: boundedText, availableQty: counterSchema });
const liveOptionsSchema = z.strictObject({ actorId: uuidSchema, areas: z.array(areaOptionSchema).max(64),
  supplies: z.array(supplyOptionSchema).max(512) });
const liveStartSchema = z.strictObject({ commandId: uuidSchema, actorId: uuidSchema, areaId: boundedText,
  supplies: z.array(z.strictObject({ item: boundedText, qty: positiveCounterSchema })).max(256) }).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.supplies.forEach((supply, index) => {
    if (seen.has(supply.item)) ctx.addIssue({ code: 'custom', path: ['supplies', index, 'item'], message: 'duplicate supply item' });
    seen.add(supply.item);
  });
});
const runBagSchema = z.strictObject({ actorId: uuidSchema, items: z.array(z.strictObject({ item: z.string().min(1).max(128), qty: z.number().int().min(1).max(1_000_000) })).max(256),
  gold: z.number().int().safe().nonnegative(), uniques: z.array(z.strictObject({ itemId: uuidSchema, definition: z.string().min(1).max(128),
    slot: z.string().max(64).nullable(), rolls: jsonSchema })).max(256).optional() });
const deathContentsSchema = z.strictObject({ stacks: z.array(z.strictObject({ item: z.string().min(1).max(128), qty: z.number().int().min(1).max(1_000_000) })).max(512),
  gold: z.number().int().safe().nonnegative(), uniques: z.array(z.strictObject({ itemId: uuidSchema, definition: z.string().min(1).max(128),
    slot: z.string().max(64).nullable(), rolls: jsonSchema })).max(512) });
const deathSummarySchema = z.strictObject({ deathId: uuidSchema, occurredAt: counterSchema, areaId: boundedText, locationId: boundedText,
  xpBefore: z.strictObject({ level: positiveCounterSchema, xpIntoLevel: counterSchema, totalXp: counterSchema }), xpLost: counterSchema,
  xpAfter: z.strictObject({ level: positiveCounterSchema, xpIntoLevel: counterSchema, totalXp: counterSchema }),
  causes: z.array(z.strictObject({ sourceId: boundedText, label: boundedText, damage: counterSchema })).max(3),
  corpse: z.strictObject({ id: uuidSchema, status: z.enum(['active', 'recovered', 'expired', 'invalidated']), expiresAt: counterSchema, contents: deathContentsSchema }) });
const bossRiskSchema = z.strictObject({ locationId: boundedText,
  enemies: z.array(z.strictObject({ enemy: boundedText, rank: boundedText, level: counterSchema })).max(128),
  heroes: z.array(z.strictObject({ actorId: uuidSchema, hp: counterSchema, maxHp: counterSchema, healingConsumables: counterSchema })).max(64),
  retreatAllowed: z.literal(false), onDeath: z.array(boundedText).max(16),
  deathConsequences: z.array(z.strictObject({ actorId: uuidSchema, xpLost: counterSchema, xpBeforeTotal: counterSchema,
    runBag: z.strictObject({ items: z.array(z.strictObject({ item: boundedText, qty: positiveCounterSchema })).max(512), gold: counterSchema,
      uniques: z.array(z.strictObject({ itemId: uuidSchema, definition: boundedText, slot: z.string().max(64).nullable(), rolls: jsonSchema })).max(512) }) })).max(64) });
const liveViewSchema = z.strictObject({
  phase: z.enum(['exploring', 'combat', 'dead', 'closing']).optional(), area: boundedText.optional(), location: boundedText.optional(),
  heroes: z.array(z.strictObject({ actorId: uuidSchema, level: z.number().int().nonnegative().optional(), xp: z.number().int().nonnegative().optional(),
    xpIntoLevel: z.number().int().nonnegative().optional(), xpToNext: z.number().int().positive().nullable().optional(),
    hp: z.number().int().nonnegative().nullable(), maxHp: z.number().int().nonnegative(),
    present: z.boolean(), consumables: z.array(z.strictObject({ item: z.string().min(1).max(128), labelKey: boundedText.optional(), qty: z.number().int().nonnegative() })).max(256),
    skills: z.array(z.strictObject({ id: boundedText, labelKey: boundedText.optional(), slot: positiveCounterSchema,
      cooldownTicks: counterSchema, cooldownRemainingTicks: counterSchema, windupTicks: counterSchema })).max(8).optional(),
    automationEnabled: z.boolean().optional() })).max(64).optional(),
  groups: z.array(z.strictObject({ id: boundedText, enemies: z.array(boundedText).max(128), boss: z.boolean(), defeated: z.boolean() })).max(128).optional(),
  exits: z.array(z.strictObject({ id: boundedText, to: boundedText, open: z.boolean(), reasons: z.array(boundedText).max(32), bossRoom: z.boolean(), visited: z.boolean() })).max(128).optional(),
  hotspots: z.array(z.strictObject({ id: boundedText, type: boundedText, textKey: boundedText, done: z.boolean() })).max(128).optional(),
  resources: z.array(z.strictObject({ nodeId: boundedText, resource: boundedText, gathered: z.boolean() })).max(128).optional(),
  flags: z.array(boundedText).max(1024).optional(), canReturn: z.boolean().optional(),
  combat: z.strictObject({ tick: counterSchema, groupId: boundedText.nullable(),
    actors: z.array(z.strictObject({ id: boundedText, side: z.enum(['hero', 'enemy']), hp: counterSchema, maxHp: counterSchema.optional(),
      alive: z.boolean(), labelKey: boundedText.optional(), auto: z.boolean().optional(),
      queued: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('useSkill'), skill: boundedText, labelKey: boundedText.optional(), target: boundedText.nullable() }),
        z.strictObject({ kind: z.literal('useConsumable'), item: boundedText, labelKey: boundedText.optional() })]).nullable().optional(),
      windup: z.strictObject({ skill: boundedText, labelKey: boundedText.optional(), targetIds: z.array(boundedText).max(128),
        startedTick: counterSchema, resolveAtTick: counterSchema }).nullable().optional(),
      cooldowns: z.array(z.strictObject({ skill: boundedText, readyAtTick: counterSchema, remainingTicks: counterSchema })).max(64).optional(),
      effects: z.array(z.strictObject({ id: counterSchema, origin: boundedText, originLabelKey: boundedText.optional(), sourceId: boundedText,
        remaining: counterSchema, unit: z.enum(['ticks', 'actions', 'attacks']), type: boundedText,
        amount: counterSchema.optional(), school: boundedText.optional(), stat: boundedText.optional() })).max(256).optional() })).max(128) }).nullable().optional(),
  runBag: z.array(runBagSchema).max(64).optional(),
});
const serverFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('authenticated'), accountId: uuidSchema }),
  z.strictObject({ type: z.literal('live.attached'), instanceId: uuidSchema, mode: z.enum(['snapshot', 'resume']) }),
  z.strictObject({ type: z.literal('live.ack'), instanceId: uuidSchema, commandId: uuidSchema, status: z.enum(['applied', 'rejected']),
    duplicate: z.boolean(), reason: z.string().min(1).max(128).optional() }).superRefine((ack, ctx) => {
      if ((ack.status === 'rejected') !== (ack.reason !== undefined)) ctx.addIssue({ code: 'custom', message: 'invalid live acknowledgement' });
    }),
  z.strictObject({ type: z.literal('live.error'), error: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal('live.snapshot'), instanceId: uuidSchema, epoch: positiveCounterSchema, seq: counterSchema,
    view: jsonSchema.transform((value) => parseView(value)), participants: z.array(participantSchema).max(64) }),
  z.strictObject({ type: z.literal('live.event'), instanceId: uuidSchema, epoch: positiveCounterSchema, seq: positiveCounterSchema,
    source: z.enum(['game', 'host']), event: jsonSchema.transform((value) => parsePublicEvent(value)) }),
  z.strictObject({ type: z.literal('live.closed'), instanceId: uuidSchema, outcome: z.string().min(1).max(128), result: jsonSchema }),
  z.strictObject({ type: z.literal('live.evicted'), instanceId: uuidSchema, reason: z.string().min(1).max(128) }),
]);

/** Exact-key validator for attach and command requests shared by browser and server composition code. */
export function parseLiveClientRequest(input: unknown): LiveClientRequest {
  return clientRequestSchema.parse(input) as LiveClientRequest;
}

/** Parses a server frame without exposing unvalidated JSON to application listeners. */
export function parseLiveServerFrame(input: unknown): LiveServerFrame {
  return serverFrameSchema.parse(input) as LiveServerFrame;
}

/** XP a hero gained from one `combatRewards` event. Level fields are absent in events from older servers. */
export interface LiveXpGainDto {
  readonly xp: number;
  readonly levelBefore?: number;
  readonly levelAfter?: number;
  readonly xpIntoLevel?: number;
  /** `null` at the level cap. */
  readonly xpToNext?: number | null;
  readonly leveledUp: boolean;
}

/**
 * Reads the server-authoritative XP gain of `actorId` out of a validated live event (`combatRewards`, or the
 * `combatEnded` event that carries the same `rewards`). The server persisted the XP before sending the event.
 */
export function liveXpGainFromEvent(event: LiveJson, actorId: string): LiveXpGainDto | null {
  const body = jsonObject(event);
  if (body?.['type'] !== 'combatRewards') return null;
  const rewards = body['rewards'];
  if (!Array.isArray(rewards)) return null;
  for (const entry of rewards as readonly LiveJson[]) {
    const row = jsonObject(entry);
    if (row?.['actorId'] !== actorId) continue;
    const xp = row['xp'];
    if (typeof xp !== 'number' || !Number.isSafeInteger(xp) || xp <= 0) return null;
    const level = (key: string): number | undefined => {
      const value = row[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    };
    const levelBefore = level('levelBefore'); const levelAfter = level('levelAfter');
    const into = row['xpIntoLevel']; const next = row['xpToNext'];
    return { xp, ...(levelBefore === undefined ? {} : { levelBefore }), ...(levelAfter === undefined ? {} : { levelAfter }),
      ...(typeof into === 'number' && Number.isSafeInteger(into) && into >= 0 ? { xpIntoLevel: into } : {}),
      ...(next === null ? { xpToNext: null } : typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? { xpToNext: next } : {}),
      leveledUp: levelBefore !== undefined && levelAfter !== undefined && levelAfter > levelBefore };
  }
  return null;
}

function jsonObject(value: LiveJson | undefined): { readonly [key: string]: LiveJson } | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value as { readonly [key: string]: LiveJson } : null;
}

/** Shared authenticated character endpoint contract for latest durable live death summary. */
export function parseLiveDeathResponse(input: unknown): LiveDeathResponseDto {
  return z.strictObject({ death: deathSummarySchema.nullable() }).parse(input) as LiveDeathResponseDto;
}

export function parseLiveOptions(input: unknown): LiveOptionsDto {
  return liveOptionsSchema.parse(input) as LiveOptionsDto;
}

export function parseLiveStartRequest(input: unknown): LiveStartRequestDto {
  return liveStartSchema.parse(input) as LiveStartRequestDto;
}

export function parseLiveStartResponse(input: unknown): LiveStartResponseDto {
  return z.strictObject({ instanceId: uuidSchema }).parse(input) as LiveStartResponseDto;
}

export function parseLiveCurrent(input: unknown): LiveCurrentResponseDto {
  const schema = z.strictObject({ current: z.strictObject({ instanceId: uuidSchema, actorId: uuidSchema,
    view: jsonSchema.transform((value) => parseView(value)), participants: z.array(participantSchema).max(64) }).nullable() });
  return schema.parse(input) as LiveCurrentResponseDto;
}

function parseView(input: unknown): LiveViewDto {
  const view = safeJson(input);
  if (view === null || Array.isArray(view) || typeof view !== 'object') throw new TypeError('invalid live view');
  return liveViewSchema.parse(view) as LiveViewDto;
}

function parsePublicEvent(input: LiveJson): LiveJson {
  if (input === null || Array.isArray(input) || typeof input !== 'object') throw new TypeError('invalid live event');
  const event = input as { readonly [key: string]: LiveJson };
  const type = event['type'];
  if (typeof type !== 'string' || !(GAME_EVENT_TYPES.has(type) || (type === 'combat' && isCombatEvent(event['event'])))) {
    throw new TypeError('unknown live event');
  }
  const keys: Readonly<Record<string, readonly string[]>> = {
    traveled: ['type', 'exitId', 'from', 'to'], discovered: ['type', 'locationId', 'actorIds'],
    combatStarted: ['type', 'groupId', 'boss'], combat: ['type', 'event'],
    combatEnded: ['type', 'outcome', 'groupId', 'rewards'], combatRewards: ['type', 'groupId', 'rewards'],
    retreated: ['type', 'from', 'to', 'hpCost'],
    bossRoomWarning: ['type', 'exitId', 'risk'], hotspotInteracted: ['type', 'hotspotId', 'hotspotType', 'textKey', 'repeat', 'flagsSet', 'revealedExits'],
    gathered: ['type', 'nodeId', 'resource', 'lootTable', 'drops', 'gold'], consumableUsed: ['type', 'actorId', 'itemId', 'hpBefore', 'hp'],
    returned: ['type', 'locationId'], heroLeft: ['type', 'actorId'], heroDied: ['type', 'actorId', 'causes', 'xpLost', 'levelBefore', 'levelAfter'],
    corpseRecovered: ['type', 'actorId', 'repeat'], participant: ['type', 'actorId', 'status'],
  };
  const allowed = new Set(keys[type] ?? []);
  if (Object.keys(event).some((key) => !allowed.has(key))) throw new TypeError('unknown live event field');
  if (type === 'bossRoomWarning') bossRiskSchema.parse(event['risk']);
  return input;
}

function isCombatEvent(input: LiveJson | undefined): boolean {
  if (input === undefined || input === null || Array.isArray(input) || typeof input !== 'object') return false;
  const event = input as { readonly [key: string]: LiveJson };
  return typeof event['type'] === 'string' && COMBAT_EVENT_TYPES.has(event['type']);
}

function safeJson(input: unknown): LiveJson {
  let bytes = 0; let nodes = 0; const ancestors = new Set<object>(); const encoder = new TextEncoder();
  function clone(value: unknown, depth: number): LiveJson {
    if (++nodes > 30_000 || depth > 40) throw new TypeError('live JSON is too complex');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      bytes += encoder.encode(JSON.stringify(value)).byteLength;
      if (bytes > LIVE_JSON_MAX_BYTES) throw new TypeError('live JSON is too large');
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid live JSON');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid live JSON object');
    ancestors.add(value); const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0) || keys.some((key) => !('value' in (descriptors[key] ?? {})))) throw new TypeError('invalid live JSON property');
    let result: LiveJson;
    if (Array.isArray(value)) {
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError('invalid live JSON array');
      result = keys.map((key) => clone(descriptors[key]?.value, depth + 1));
    } else {
      for (const key of keys) {
        if (PRIVATE_KEYS.has(key)) throw new TypeError('private live field');
        bytes += encoder.encode(JSON.stringify(key)).byteLength;
        if (bytes > LIVE_JSON_MAX_BYTES) throw new TypeError('live JSON is too large');
      }
      result = Object.fromEntries(keys.map((key) => [key, clone(descriptors[key]?.value, depth + 1)]));
    }
    ancestors.delete(value); return Object.freeze(result);
  }
  return clone(input, 0);
}

