import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createLiveHostModule, getHoldings, itemInstances, actors, lockActors } from '@engine/server-kit';
import type { ActorTransaction, Database, LiveHostHandle, LiveHostModuleOptions, LoadedContent } from '@engine/server-kit';
import type { CreateInstanceInput } from '@engine/live-kernel';
import type { ConsumableStack } from '@rpg/rpg-sim';
import { InstanceHost } from '@engine/live-kernel';
import { ItemSchema } from '@rpg/rpg-schema';
import type { Item } from '@rpg/rpg-schema';

import { characters } from '../characters/schema.ts';
import { BASIC_ATTACK } from '../characters/validation.ts';
import { readRpgEvalContext } from '../expeditions/progress.ts';
import { rpgLiveStoreHooks } from './effects.ts';
import { createRpgLiveGame } from './game.ts';
import type { RpgLiveGroup, RpgLiveHeroSetup, RpgLiveSetup, RpgLiveState } from './game.ts';

export * from './game.ts';
export * from './effects.ts';

export type RpgLiveHost = LiveHostHandle<RpgLiveState> & { content(): LoadedContent };
const hostContent = new WeakMap<object, LoadedContent>();

/**
 * RPG composition of the engine live host (role `live`). The store's `onEffects` hook records the plugin's durable
 * effects (discoveries) in the checkpoint transaction; `options.hooks` are composed after it.
 */
export function createRpgLiveHost(options: Omit<LiveHostModuleOptions<RpgLiveState>, 'game'> = {}): RpgLiveHost {
  let content: LoadedContent | undefined;
  const live = createLiveHostModule({ ...options, hooks: rpgLiveStoreHooks(options.hooks, validateRpgLiveCreate),
    game: (context) => { content = context.content; return createRpgLiveGame(context.content); } });
  const getHost = live.host.bind(live);
  return Object.assign(live, { content: () => {
    if (!content) throw new Error('live host module has not been registered');
    return content;
  }, host: () => {
    const instanceHost = getHost();
    if (content) hostContent.set(instanceHost, content);
    return instanceHost;
  } });
}

export interface StartRpgLiveInput {
  readonly actorIds: readonly string[];
  /** Explorable area to enter at its start location (default: the area of `location`). */
  readonly area?: string;
  /** Starting location (default: the area's start location). */
  readonly location?: string;
  /** Fixed groups replacing the encounter roll of the starting location (trusted callers: tests, scripted events). */
  readonly groups?: readonly RpgLiveGroup[];
  /** Consumable loadout per actor; quantities are validated against inventory while start is committed. */
  readonly consumables?: Readonly<Record<string, readonly ConsumableStack[]>>;
}

/**
 * Starts a live instance for the given characters: snapshots builds and server-recorded world progress (discoveries,
 * objectives, completed areas through `readRpgEvalContext`), then the host CASes every participant `none → live` in one
 * transaction with the instance insert. Party formation/invites (phase 2) and the Sanctuary portal flow are out of scope.
 */
export async function startRpgLiveInstance(host: RpgLiveHost | InstanceHost<RpgLiveState>, database: Database, input: StartRpgLiveInput): Promise<string> {
  const ids = [...new Set(input.actorIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length !== input.actorIds.length || ids.length === 0) throw new RangeError('live participants must be unique');
  const instanceHost = host instanceof InstanceHost ? host : host.host();
  const content = host instanceof InstanceHost ? hostContent.get(host) : host.content();
  if (!content) throw new Error('live host content unavailable; get the host from createRpgLiveHost after registration');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await database.db.transaction(async (tx) => {
      await lockActors(tx, ids);
      const rows = await tx.select().from(characters).where(inArray(characters.actorId, ids));
      if (rows.length !== ids.length) throw new RangeError('unknown character');
      const heroes = await Promise.all(rows.map((row) => readHeroSetup(tx, row.actorId, input.consumables?.[row.actorId] ?? [], content)));
      return { rows, heroes };
    });
    const setup: RpgLiveSetup = { ...(input.area === undefined ? {} : { area: input.area }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.groups === undefined ? {} : { groups: input.groups }), heroes: prepared.heroes };
    try {
      return await instanceHost.create({ participants: prepared.rows.map((row) => ({ actorId: row.actorId, accountId: row.accountId })),
        setup: JSON.parse(JSON.stringify(setup)) });
    } catch (error) {
      if (!(error instanceof StaleRpgLiveStartError) || attempt === 1) throw error;
    }
  }
  throw new Error('live start retry exhausted');
}

class StaleRpgLiveStartError extends Error { readonly code = 'stale_start_snapshot'; }

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

async function authoritativeStartSnapshot(tx: ActorTransaction, actorId: string) {
  const [actor] = await tx.select({ version: actors.version }).from(actors).where(eq(actors.actorId, actorId));
  const [character] = await tx.select().from(characters).where(eq(characters.actorId, actorId));
  if (!actor || !character) throw new RangeError('unknown character');
  const holdings = await getHoldings(tx, actorId);
  const equipmentRows = await tx.select().from(itemInstances).where(and(eq(itemInstances.actorId, actorId), eq(itemInstances.container, 'equipped')));
  const progress = await readRpgEvalContext(tx, actorId, character.level, holdings);
  const world = { discovered: [...progress.actor.discovered.values()].flatMap((set) => [...set]).sort(),
    objectives: [...progress.actor.objectives].sort(), completedAreas: [...progress.actor.completedAreas].sort() };
  const fingerprint = createHash('sha256').update(stable({ version: actor.version, character: {
    level: character.level, xp: character.xp, attributes: character.attributes, skillLoadout: character.skillLoadout,
    automationRules: character.automationRules,
  }, holdings: holdings.map((holding) => ({ asset: holding.asset, container: holding.container, qty: holding.qty,
    itemId: holding.itemId, definition: holding.definition, slot: holding.slot, rolls: holding.rolls }))
    .sort((a, b) => stable(a).localeCompare(stable(b))),
  equipmentRows: equipmentRows.map((row) => ({ id: row.id, definition: row.definition, slot: row.slot, rolls: row.rolls })).sort((a, b) => a.id.localeCompare(b.id)),
  world })).digest('hex');
  return { character, holdings, equipmentRows, world, fingerprint };
}

async function readHeroSetup(tx: ActorTransaction, actorId: string, requested: readonly ConsumableStack[], content: LoadedContent): Promise<RpgLiveHeroSetup> {
  const snapshot = await authoritativeStartSnapshot(tx, actorId);
  const character = snapshot.character;
  const definitions = new Map<string, Item>((content.collections['items'] ?? []).map((raw) => {
    const item = ItemSchema.parse(raw);
    return [item.id, item] as const;
  }));
  const equipment = snapshot.equipmentRows.map((row) => {
    const definition = definitions.get(row.definition);
    if (!definition || definition.kind !== 'equipment' || definition.slot !== row.slot || (definition.levelRequired ?? 1) > character.level) {
      throw new RangeError(`invalid equipped item ${row.id}`);
    }
    if (row.rolls === null || typeof row.rolls !== 'object' || Array.isArray(row.rolls) || Object.keys(row.rolls).length !== 0) {
      throw new RangeError('unsupported_equipment_rolls');
    }
    return { stats: definition.stats };
  });
  const equippedSlots = snapshot.equipmentRows.map((row) => row.slot);
  if (new Set(equippedSlots).size !== equippedSlots.length) throw new RangeError('duplicate equipped slot');
  const available = new Map(snapshot.holdings.filter((holding) => holding.container === 'inventory' && holding.asset.kind === 'stack')
    .map((holding) => [holding.asset.kind === 'stack' ? holding.asset.item : '', holding.qty]));
  const seen = new Set<string>();
  const carried = requested.map((stack) => {
    const item = definitions.get(stack.item);
    if (seen.has(stack.item) || !item || item.kind !== 'consumable' || !Number.isSafeInteger(stack.qty) || stack.qty <= 0 ||
        (available.get(stack.item) ?? 0) < stack.qty) throw new RangeError(`insufficient consumable ${stack.item}`);
    seen.add(stack.item);
    available.set(stack.item, (available.get(stack.item) ?? 0) - stack.qty);
    return { item: stack.item, qty: stack.qty };
  });
  return { actorId, build: { level: character.level, attributes: character.attributes, equipment }, skills: [BASIC_ATTACK, ...character.skillLoadout],
    rules: character.automationRules, consumables: carried, world: snapshot.world, snapshotHash: snapshot.fingerprint, xp: character.xp };
}

async function validateRpgLiveCreate(tx: ActorTransaction, input: CreateInstanceInput): Promise<void> {
  const payload = input.checkpoint as { state?: unknown } | null;
  const checkpoint = payload?.state as { heroes?: readonly RpgLiveHeroSetup[] } | undefined;
  const heroes = checkpoint?.heroes;
  if (!Array.isArray(heroes) || heroes.length !== input.participants.length) throw new StaleRpgLiveStartError('stale_start_snapshot');
  for (const hero of heroes) {
    if (!hero || typeof hero.actorId !== 'string' || typeof hero.snapshotHash !== 'string') throw new StaleRpgLiveStartError('stale_start_snapshot');
    const current = await authoritativeStartSnapshot(tx, hero.actorId);
    if (current.fingerprint !== hero.snapshotHash) throw new StaleRpgLiveStartError('stale_start_snapshot');
    const available = new Map(current.holdings.filter((holding) => holding.container === 'inventory' && holding.asset.kind === 'stack')
      .map((holding) => [holding.asset.kind === 'stack' ? holding.asset.item : '', holding.qty]));
    for (const carried of hero.consumables ?? []) {
      if ((available.get(carried.item) ?? 0) < carried.qty) throw new StaleRpgLiveStartError('stale_start_snapshot');
      available.set(carried.item, (available.get(carried.item) ?? 0) - carried.qty);
    }
  }
}
