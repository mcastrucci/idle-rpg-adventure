/**
 * Content lookup of the idle simulators: combat content plus encounter/loot tables and idle activities. Built from a
 * compiled content bundle (`rpgIdleContentFromBundle`) or assembled directly in tests. No I/O.
 */
import {
  EncounterTableSchema,
  EnemySchema,
  IdleActivitySchema,
  ItemSchema,
  LootTableSchema,
  SkillSchema,
} from '@rpg/rpg-schema';
import type { ConsumableItem, EncounterTable, Enemy, IdleActivity, Item, LootTable, Skill } from '@rpg/rpg-schema';
import type { StatFormulaTable } from '@rpg/rpg-stats';

import type { CombatContent } from '../combat/types.ts';

export interface RpgIdleContent {
  readonly combat: CombatContent;
  readonly encounterTables: Readonly<Record<string, EncounterTable>>;
  readonly lootTables: Readonly<Record<string, LootTable>>;
  readonly idleActivities: Readonly<Record<string, IdleActivity>>;
  /** Stat formula table (default `DEFAULT_STAT_FORMULAS`). */
  readonly formulas?: StatFormulaTable;
}

/** Structural subset of `@engine/content-compiler`'s `ContentBundle` (no compiler dependency at runtime). */
export interface ContentBundleLike {
  readonly collections: Readonly<Record<string, readonly unknown[]>>;
}

function byId<T extends { id: string }>(list: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

/** Parses the collections the idle simulators need from a compiled bundle (throws on invalid entities). */
export function rpgIdleContentFromBundle(bundle: ContentBundleLike, formulas?: StatFormulaTable): RpgIdleContent {
  const c = bundle.collections;
  const all = <T>(name: string, parse: (x: unknown) => T): T[] => (c[name] ?? []).map(parse);
  return {
    combat: {
      skills: byId<Skill>(all('skills', (x) => SkillSchema.parse(x))),
      items: byId<Item>(all('items', (x) => ItemSchema.parse(x))),
      enemies: byId<Enemy>(all('enemies', (x) => EnemySchema.parse(x))),
    },
    encounterTables: byId(all('encounterTables', (x) => EncounterTableSchema.parse(x))),
    lootTables: byId(all('lootTables', (x) => LootTableSchema.parse(x))),
    idleActivities: byId(all('idleActivities', (x) => IdleActivitySchema.parse(x))),
    ...(formulas === undefined ? {} : { formulas }),
  };
}

export function consumableOf(content: RpgIdleContent, item: string): ConsumableItem | undefined {
  const it = content.combat.items[item];
  return it?.kind === 'consumable' ? it : undefined;
}

/** A consumable that restores HP (its `use` heals or applies a heal-over-time). Drives the retreat policy. */
export function isHealingConsumable(content: RpgIdleContent, item: string): boolean {
  return consumableOf(content, item)?.use.some((e) => e.type === 'heal' || e.type === 'hot') ?? false;
}
