import { inArray } from 'drizzle-orm';
import type { InstanceHost } from '@engine/live-kernel';
import { createLiveHostModule } from '@engine/server-kit';
import type { Database, LiveHostHandle, LiveHostModuleOptions } from '@engine/server-kit';
import type { ConsumableStack } from '@rpg/rpg-sim';

import { characters } from '../characters/schema.ts';
import { BASIC_ATTACK } from '../characters/validation.ts';
import { readRpgEvalContext } from '../expeditions/progress.ts';
import { rpgLiveStoreHooks } from './effects.ts';
import { createRpgLiveGame } from './game.ts';
import type { RpgLiveGroup, RpgLiveHeroSetup, RpgLiveSetup, RpgLiveState } from './game.ts';

export * from './game.ts';
export * from './effects.ts';

export type RpgLiveHost = LiveHostHandle<RpgLiveState>;

/**
 * RPG composition of the engine live host (role `live`). The store's `onEffects` hook records the plugin's durable
 * effects (discoveries) in the checkpoint transaction; `options.hooks` are composed after it.
 */
export function createRpgLiveHost(options: Omit<LiveHostModuleOptions<RpgLiveState>, 'game'> = {}): RpgLiveHost {
  return createLiveHostModule({ ...options, hooks: rpgLiveStoreHooks(options.hooks),
    game: (context) => createRpgLiveGame(context.content) });
}

export interface StartRpgLiveInput {
  readonly actorIds: readonly string[];
  /** Explorable area to enter at its start location (default: the area of `location`). */
  readonly area?: string;
  /** Starting location (default: the area's start location). */
  readonly location?: string;
  /** Fixed groups replacing the encounter roll of the starting location (trusted callers: tests, scripted events). */
  readonly groups?: readonly RpgLiveGroup[];
  /** Consumable loadout snapshot per actor. Moving it out of the inventory (escrow) is #28/#42. */
  readonly consumables?: Readonly<Record<string, readonly ConsumableStack[]>>;
}

/**
 * Starts a live instance for the given characters: snapshots builds and server-recorded world progress (discoveries,
 * objectives, completed areas through `readRpgEvalContext`), then the host CASes every participant `none → live` in one
 * transaction with the instance insert. Party formation/invites (phase 2) and the Sanctuary portal flow are out of scope.
 */
export async function startRpgLiveInstance(host: InstanceHost<RpgLiveState>, database: Database, input: StartRpgLiveInput): Promise<string> {
  const ids = [...new Set(input.actorIds.map((id) => id.toLowerCase()))].sort();
  const rows = await database.db.select().from(characters).where(inArray(characters.actorId, ids));
  if (rows.length !== ids.length) throw new RangeError('unknown character');
  const heroes: RpgLiveHeroSetup[] = await database.db.transaction(async (tx) => Promise.all(rows.map(async (row) => {
    const context = await readRpgEvalContext(tx, row.actorId, row.level);
    return { actorId: row.actorId,
      build: { level: row.level, attributes: row.attributes, equipment: [] },
      skills: [BASIC_ATTACK, ...row.skillLoadout], rules: row.automationRules,
      consumables: [...(input.consumables?.[row.actorId] ?? [])],
      world: { discovered: [...context.actor.discovered.values()].flatMap((set) => [...set]).sort(),
        objectives: [...context.actor.objectives].sort(), completedAreas: [...context.actor.completedAreas].sort() } };
  })));
  const setup: RpgLiveSetup = { ...(input.area === undefined ? {} : { area: input.area }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.groups === undefined ? {} : { groups: input.groups }), heroes };
  return host.create({ participants: rows.map((row) => ({ actorId: row.actorId, accountId: row.accountId })),
    setup: JSON.parse(JSON.stringify(setup)) });
}
