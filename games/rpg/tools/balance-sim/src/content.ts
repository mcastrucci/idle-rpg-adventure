/**
 * Loads the inputs of a balance run from a compiled content bundle: the combat lookup for `@rpg/rpg-sim` plus the
 * encounter/loot tables and idle activities. Content is compiled on the fly with the real compiler and RPG plugin, so
 * the `contentHash` in every report is the hash a published bundle of the same files would carry.
 */
import { fileURLToPath } from 'node:url';

import { compileContentDirectory, formatErrors } from '@engine/content-compiler';
import type { ContentBundle } from '@engine/content-compiler';
import rpgContentPlugin from '@rpg/content-plugin';
import {
  EncounterTableSchema,
  EnemySchema,
  IdleActivitySchema,
  ItemSchema,
  LootTableSchema,
  SkillSchema,
  XpCurveSchema,
} from '@rpg/rpg-schema';
import type { EncounterTable, Enemy, IdleActivity, Item, LootTable, Skill, XpCurve } from '@rpg/rpg-schema';
import type { CombatContent } from '@rpg/rpg-sim';

/** `games/rpg/content`, resolved from this file. */
export const DEFAULT_CONTENT_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));

export interface BalanceContent {
  readonly contentHash: string;
  readonly combat: CombatContent;
  readonly encounterTables: Readonly<Record<string, EncounterTable>>;
  readonly lootTables: Readonly<Record<string, LootTable>>;
  readonly idleActivities: Readonly<Record<string, IdleActivity>>;
  readonly progression?: XpCurve;
}

function byId<T extends { id: string }>(list: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

function parseAll<T>(entities: readonly unknown[] | undefined, parse: (x: unknown) => T): T[] {
  return (entities ?? []).map(parse);
}

/** Builds the balance inputs from an already compiled bundle. */
export function balanceContentFromBundle(bundle: ContentBundle): BalanceContent {
  const c = bundle.collections;
  const progression = c['progression']?.[0];
  return {
    contentHash: bundle.contentHash,
    combat: {
      skills: byId<Skill>(parseAll(c['skills'], (x) => SkillSchema.parse(x))),
      items: byId<Item>(parseAll(c['items'], (x) => ItemSchema.parse(x))),
      enemies: byId<Enemy>(parseAll(c['enemies'], (x) => EnemySchema.parse(x))),
    },
    encounterTables: byId(parseAll(c['encounterTables'], (x) => EncounterTableSchema.parse(x))),
    lootTables: byId(parseAll(c['lootTables'], (x) => LootTableSchema.parse(x))),
    idleActivities: byId(parseAll(c['idleActivities'], (x) => IdleActivitySchema.parse(x))),
    ...(progression === undefined ? {} : {
      progression: XpCurveSchema.parse({
        xpToNext: (progression as { readonly xpToNext?: unknown }).xpToNext,
        tailGrowthBp: (progression as { readonly tailGrowthBp?: unknown }).tailGrowthBp,
      }),
    }),
  };
}

/** Compiles a content root with the RPG plugin; throws with the compiler's error list on invalid content. */
export function loadBalanceContent(root: string = DEFAULT_CONTENT_ROOT): BalanceContent {
  const result = compileContentDirectory(root, rpgContentPlugin);
  if (!result.ok) throw new Error(`content at ${root} does not compile:\n${formatErrors(result.errors)}`);
  return balanceContentFromBundle(result.bundle);
}
