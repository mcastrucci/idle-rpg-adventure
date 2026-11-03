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
/** Client-safe projection of the current game view. Game-specific view fields remain JSON data. */
export interface LiveViewDto {
  readonly phase?: string;
  readonly runBag?: readonly LiveRunBagDto[];
  readonly [key: string]: LiveJson | readonly LiveRunBagDto[] | undefined;
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
const liveViewSchema = z.strictObject({
  phase: z.enum(['exploring', 'combat', 'dead', 'closing']).optional(), area: boundedText.optional(), location: boundedText.optional(),
  heroes: z.array(z.strictObject({ actorId: uuidSchema, level: z.number().int().nonnegative().optional(), xp: z.number().int().nonnegative().optional(),
    hp: z.number().int().nonnegative().nullable(), maxHp: z.number().int().nonnegative(),
    present: z.boolean(), consumables: z.array(z.strictObject({ item: z.string().min(1).max(128), qty: z.number().int().nonnegative() })).max(256) })).max(64).optional(),
  groups: z.array(z.strictObject({ id: boundedText, enemies: z.array(boundedText).max(128), boss: z.boolean(), defeated: z.boolean() })).max(128).optional(),
  exits: z.array(z.strictObject({ id: boundedText, to: boundedText, open: z.boolean(), reasons: z.array(boundedText).max(32), bossRoom: z.boolean(), visited: z.boolean() })).max(128).optional(),
  hotspots: z.array(z.strictObject({ id: boundedText, type: boundedText, textKey: boundedText, done: z.boolean() })).max(128).optional(),
  resources: z.array(z.strictObject({ nodeId: boundedText, resource: boundedText, gathered: z.boolean() })).max(128).optional(),
  flags: z.array(boundedText).max(1024).optional(), canReturn: z.boolean().optional(),
  combat: z.strictObject({ tick: z.number().int().nonnegative(), groupId: boundedText.nullable(),
    actors: z.array(z.strictObject({ id: boundedText, side: z.enum(['hero', 'enemy']), hp: z.number().int().nonnegative(), alive: z.boolean() })).max(128) }).nullable().optional(),
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

/** Shared authenticated character endpoint contract for latest durable live death summary. */
export function parseLiveDeathResponse(input: unknown): LiveDeathResponseDto {
  return z.strictObject({ death: deathSummarySchema.nullable() }).parse(input) as LiveDeathResponseDto;
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
    returned: ['type', 'locationId'], heroLeft: ['type', 'actorId'], heroDied: ['type', 'actorId', 'causes'],
    corpseRecovered: ['type', 'actorId', 'repeat'], participant: ['type', 'actorId', 'status'],
  };
  const allowed = new Set(keys[type] ?? []);
  if (Object.keys(event).some((key) => !allowed.has(key))) throw new TypeError('unknown live event field');
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

