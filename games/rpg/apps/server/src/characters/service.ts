import { and, eq, sql } from 'drizzle-orm';
import {
  ActorError, actors, requireOwnedActor, requireSanctuaryMutation,
} from '@engine/server-kit';
import type { ActorTransaction, LoadedContent } from '@engine/server-kit';

import { characters } from './schema.ts';
import {
  allocateAttributes, CharacterError, ConfigureCharacterSchema, CreateCharacterSchema,
  PROVISIONAL_STARTER_ATTRIBUTES, PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS,
  validateCharacterConfiguration,
} from './validation.ts';

export const RPG_GAME_ID = 'rpg';
/** One service per surrounding transaction; no nested commit separates activity locks from game state changes. */
export function createCharacterService(tx: ActorTransaction, content: LoadedContent) {
  return {
    async create(accountId: string, input: unknown) {
      const parsed = CreateCharacterSchema.parse(input);
      validateCharacterConfiguration(content, PROVISIONAL_STARTER_SKILLS, PROVISIONAL_STARTER_RULES);
      const [actor] = await tx.insert(actors).values({ accountId, gameId: RPG_GAME_ID }).returning();
      if (!actor) throw new Error('actor insert returned no identity');
      const [character] = await tx.insert(characters).values({ actorId: actor.actorId, accountId,
        gameId: RPG_GAME_ID, name: parsed.name, level: 1, xp: 0,
        attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES }, unspentPoints: 0,
        skillLoadout: [...PROVISIONAL_STARTER_SKILLS], automationRules: structuredClone(PROVISIONAL_STARTER_RULES) })
        .onConflictDoNothing({ target: [characters.accountId, characters.gameId] }).returning();
      // Caller must let this error roll back the transaction so a duplicate create cannot leave an orphan actor.
      if (!character) throw new CharacterError('character_exists', 409);
      return { ...character, activityState: actor.activityState, activityId: actor.activityId, version: actor.version };
    },
    async read(accountId: string, actorId: string) {
      const actor = await requireOwnedActor(tx, actorId, accountId, RPG_GAME_ID);
      const [character] = await tx.select().from(characters).where(eq(characters.actorId, actorId));
      if (!character) throw new ActorError('not_found', 404);
      return { ...character, activityState: actor.activityState, activityId: actor.activityId, version: actor.version };
    },
    async list(accountId: string) {
      // Single statement returns a consistent actor/character projection; reads require no mutation lock.
      const result = await tx.select({ character: characters, activityState: actors.activityState,
        activityId: actors.activityId, version: actors.version }).from(characters).innerJoin(actors, eq(actors.actorId, characters.actorId))
        .where(and(eq(actors.accountId, accountId), eq(actors.gameId, RPG_GAME_ID)));
      return result.map(row => ({ ...row.character, activityState: row.activityState, activityId: row.activityId, version: row.version }));
    },
    async configure(accountId: string, actorId: string, input: unknown) {
      const parsed = ConfigureCharacterSchema.parse(input);
      const actor = await requireSanctuaryMutation(tx, actorId, accountId, RPG_GAME_ID);
      const [current] = await tx.select().from(characters).where(eq(characters.actorId, actorId));
      if (!current) throw new ActorError('not_found', 404);
      const loadout = parsed.skillLoadout ?? current.skillLoadout;
      const rules = parsed.automationRules ?? current.automationRules;
      validateCharacterConfiguration(content, loadout, rules);
      const allocation = allocateAttributes(current.attributes, current.unspentPoints, parsed.allocate ?? {});
      const [updated] = await tx.update(characters).set({ name: parsed.name ?? current.name,
        ...allocation, skillLoadout: loadout, automationRules: rules }).where(eq(characters.actorId, actorId)).returning();
      if (!updated) throw new ActorError('not_found', 404);
      const [versioned] = await tx.update(actors).set({ version: sql`${actors.version} + 1` }).where(eq(actors.actorId, actorId)).returning();
      if (!versioned) throw new ActorError('not_found', 404);
      return { ...updated, activityState: actor.activityState, activityId: actor.activityId, version: versioned.version };
    },
  };
}
