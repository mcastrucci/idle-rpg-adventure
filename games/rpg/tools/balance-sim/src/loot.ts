/**
 * Loot rolls for the hourly reports. The real reward pipeline (idle settlement, M6) does not exist yet, so this follows
 * the `LootTable` schema semantics directly: `rolls` independent weighted rolls over `entries` + `nothingWeight`,
 * `guaranteed` drops always, gold uniform in `[min, max]`. Items are valued at their content `value` (sell value).
 */
import type { Rng } from '@engine/sim-core';
import type { Item, LootTable } from '@rpg/rpg-schema';

export interface LootRoll {
  readonly gold: number;
  /** Sum of `qty × item.value` of the dropped items. */
  readonly vendorValue: number;
}

export function rollLoot(table: LootTable, items: Readonly<Record<string, Item>>, rng: Rng): LootRoll {
  let vendorValue = 0;
  const add = (item: string, qty: number): void => {
    vendorValue += qty * (items[item]?.value ?? 0);
  };
  for (let r = 0; r < table.rolls; r++) {
    const options: { value: number; weight: number }[] = table.entries.map((e, i) => ({ value: i, weight: e.weight }));
    if (table.nothingWeight > 0) options.push({ value: -1, weight: table.nothingWeight });
    const picked = rng.pickWeighted(options);
    const entry = picked >= 0 ? table.entries[picked] : undefined;
    if (entry !== undefined) add(entry.item, rng.int(entry.qty.min, entry.qty.max));
  }
  for (const g of table.guaranteed) add(g.item, rng.int(g.qty.min, g.qty.max));
  const gold = table.gold === undefined ? 0 : rng.int(table.gold.min, table.gold.max);
  return { gold, vendorValue };
}
