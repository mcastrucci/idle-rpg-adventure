import type { getHoldings } from '@engine/server-kit';
import type { LoadedContent } from '@engine/server-kit';
import type { StatSummaryDto } from '@rpg/protocol';
import { EQUIPMENT_SLOTS } from '@rpg/rpg-schema';
import type { StatMap } from '@rpg/rpg-schema';
import { rpgIdleContentFromBundle } from '@rpg/rpg-sim';
import { DEFAULT_STAT_FORMULAS, deriveStats, flattenStats } from '@rpg/rpg-stats';
import type { AttributeMap, DerivedStats } from '@rpg/rpg-stats';

type Holdings = Awaited<ReturnType<typeof getHoldings>>;

export interface EquippedGear {
  readonly itemId: string;
  readonly definition: string;
  readonly slot: string;
  readonly stats: StatMap;
}
export type EquippedGearResult =
  | { readonly ok: true; readonly gear: readonly EquippedGear[] }
  | { readonly ok: false; readonly code: 'invalid_equipped_item' | 'unsupported_equipment_rolls' };

/**
 * The equipped gear the combat build is made of. Single source for the expedition snapshot and the stat summary, so
 * both read the same holdings and authored item stats.
 */
export function equippedGear(holdings: Holdings, content: LoadedContent): EquippedGearResult {
  const items = rpgIdleContentFromBundle(content).combat.items;
  const gear: EquippedGear[] = [];
  for (const holding of holdings) {
    if (holding.container !== 'equipped' || holding.asset.kind !== 'unique') continue;
    const definition = typeof holding.definition === 'string' ? items[holding.definition] : undefined;
    if (definition?.kind !== 'equipment') return { ok: false, code: 'invalid_equipped_item' };
    // RPG gear-roll semantics are not authored yet; do not silently simulate with incomplete derived stats.
    if (holding.rolls !== undefined && JSON.stringify(holding.rolls) !== '{}') return { ok: false, code: 'unsupported_equipment_rolls' };
    gear.push({ itemId: holding.asset.itemId, definition: holding.definition as string, slot: String(holding.slot ?? definition.slot), stats: definition.stats });
  }
  return { ok: true, gear };
}

const KEYS = ['STR', 'AGI', 'INT', 'VIT', 'SPI', 'maxHp', 'physicalPower', 'magicPower', 'armor', 'resist', 'critBp', 'haste',
  'actionIntervalTicks', 'healPower'] as const;

/** Read-only base/equipment/total breakdown computed with the same `deriveStats` call the combat build uses. */
export function buildStatSummary(level: number, attributes: AttributeMap, holdings: Holdings, content: LoadedContent): StatSummaryDto | undefined {
  const result = equippedGear(holdings, content);
  if (!result.ok) return undefined;
  const table = rpgIdleContentFromBundle(content).formulas ?? DEFAULT_STAT_FORMULAS;
  const slotOrder = (slot: string) => (EQUIPMENT_SLOTS as readonly string[]).indexOf(slot);
  const ordered = [...result.gear].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || a.itemId.localeCompare(b.itemId));
  const derive = (count: number): DerivedStats => deriveStats({ level, attributes, equipment: ordered.slice(0, count) }, table);
  // Marginal contributions in a fixed order: every item's share is what adding it changes, so shares sum to the total.
  const base = flattenStats(derive(0));
  const steps = ordered.map((_, index) => flattenStats(derive(index + 1)));
  const total = steps[steps.length - 1] ?? base;
  const names = new Map((content.collections['items'] ?? []).map(row => [(row as { id: string }).id, (row as { nameKey?: string }).nameKey]));
  return {
    level,
    items: ordered.map(gear => {
      const nameKey = names.get(gear.definition);
      return { itemId: gear.itemId, definition: gear.definition, slot: gear.slot, ...(nameKey === undefined ? {} : { nameKey }) };
    }),
    rows: KEYS.map(key => ({
      key, base: base[key], equipment: total[key] - base[key], total: total[key],
      contributions: ordered.flatMap((gear, index) => {
        const previous = index === 0 ? base : (steps[index - 1] ?? base);
        const value = (steps[index] ?? base)[key] - previous[key];
        return value === 0 ? [] : [{ itemId: gear.itemId, value }];
      }),
    })),
  };
}
