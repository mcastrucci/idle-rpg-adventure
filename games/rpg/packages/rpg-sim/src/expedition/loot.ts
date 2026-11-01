/**
 * Loot-table rolls (data-model §1 `LootTable` semantics): `rolls` independent weighted rolls over `entries` plus
 * `nothingWeight`, then every `guaranteed` drop, then gold uniform in `[gold.min, gold.max]`. Same semantics as the
 * balance-sim model (#24), re-implemented here: tools are never imported by simulators.
 */
import type { Rng } from '@engine/sim-core';
import type { LootTable } from '@rpg/rpg-schema';

export interface LootDrop {
  readonly item: string;
  readonly qty: number;
}

export interface LootRoll {
  /** Drops in roll order (entries first, then guaranteed). */
  readonly items: readonly LootDrop[];
  readonly gold: number;
}

export function rollLoot(table: LootTable, rng: Rng): LootRoll {
  const items: LootDrop[] = [];
  if (table.rolls > 0) {
    const options: { value: number; weight: number }[] = table.entries.map((e, i) => ({ value: i, weight: e.weight }));
    if (table.nothingWeight > 0) options.push({ value: -1, weight: table.nothingWeight });
    for (let r = 0; r < table.rolls; r++) {
      const picked = rng.pickWeighted(options);
      const entry = picked >= 0 ? table.entries[picked] : undefined;
      if (entry !== undefined) items.push({ item: entry.item, qty: rng.int(entry.qty.min, entry.qty.max) });
    }
  }
  for (const g of table.guaranteed) items.push({ item: g.item, qty: rng.int(g.qty.min, g.qty.max) });
  const gold = table.gold === undefined ? 0 : rng.int(table.gold.min, table.gold.max);
  return { items, gold };
}
