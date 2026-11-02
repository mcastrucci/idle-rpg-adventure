import { inArray } from 'drizzle-orm';
import type { InstanceHost } from '@engine/live-kernel';
import { createLiveHostModule } from '@engine/server-kit';
import type { Database, LiveHostHandle, LiveHostModuleOptions } from '@engine/server-kit';

import { characters } from '../characters/schema.ts';
import { BASIC_ATTACK } from '../characters/validation.ts';
import { createRpgLiveGame } from './game.ts';
import type { RpgLiveGroup, RpgLiveHeroSetup, RpgLiveSetup, RpgLiveState } from './game.ts';

export * from './game.ts';

export type RpgLiveHost = LiveHostHandle<RpgLiveState>;

/** RPG composition of the engine live host (role `live`). */
export function createRpgLiveHost(options: Omit<LiveHostModuleOptions<RpgLiveState>, 'game'> = {}): RpgLiveHost {
  return createLiveHostModule({ ...options, game: (context) => createRpgLiveGame(context.content) });
}

/**
 * Starts a live instance for the given characters (spike: a stub location with authored enemy groups). Snapshots the
 * heroes' builds, then the host CASes every participant `none → live` in one transaction with the instance insert.
 * Party formation/invites (phase 2) and real area entry are out of scope.
 */
export async function startRpgLiveInstance(host: InstanceHost<RpgLiveState>, database: Database,
  input: { readonly actorIds: readonly string[]; readonly location: string; readonly groups: readonly RpgLiveGroup[] }): Promise<string> {
  const ids = [...new Set(input.actorIds.map((id) => id.toLowerCase()))].sort();
  const rows = await database.db.select().from(characters).where(inArray(characters.actorId, ids));
  if (rows.length !== ids.length) throw new RangeError('unknown character');
  const heroes: RpgLiveHeroSetup[] = rows.map((row) => ({ actorId: row.actorId,
    build: { level: row.level, attributes: row.attributes, equipment: [] },
    skills: [BASIC_ATTACK, ...row.skillLoadout], rules: row.automationRules }));
  const setup: RpgLiveSetup = { location: input.location, groups: input.groups, heroes };
  return host.create({ participants: rows.map((row) => ({ actorId: row.actorId, accountId: row.accountId })),
    setup: JSON.parse(JSON.stringify(setup)) });
}
