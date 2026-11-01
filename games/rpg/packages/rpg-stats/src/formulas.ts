/**
 * Stat formula constants as data (combat-engine §3), so balance can tune them without code changes.
 *
 * PROVISIONAL: every number in {@link DEFAULT_STAT_FORMULAS} is a placeholder pending open decision #2
 * ("XP, damage, defense and progression formulas", docs/open-decisions.md). Changing a value changes simulation
 * behaviour: the simulator must bump its engine version / content hash accordingly.
 *
 * Units: `*Bp` fields are basis points (10000 = 100%); a `per<Attr>Bp` of 15000 means "+1.5 per attribute point",
 * floored once per derived stat. Other fields are plain integers.
 */
import { assertInt } from './int-math.ts';

/** Spec floor for the action interval (combat-engine §3: "floor 2 ticks"). Tables may raise it, never lower it. */
export const MIN_ACTION_INTERVAL_TICKS = 2;

export interface StatFormulaTable {
  readonly maxHp: {
    /** HP at level 1 with 0 VIT. */
    readonly base: number;
    /** HP added per level above 1. */
    readonly perLevel: number;
    /** HP per VIT point (integer). */
    readonly perVit: number;
  };
  readonly power: {
    /** Physical power per STR point, bp. */
    readonly perStrBp: number;
    /** Magic power per INT point, bp. */
    readonly perIntBp: number;
    /** Power (both schools) per level above 1. */
    readonly perLevel: number;
  };
  readonly armor: { readonly perVitBp: number };
  readonly resist: { readonly perSpiBp: number };
  readonly crit: {
    /** Base crit chance, bp. */
    readonly baseBp: number;
    /** Crit chance per AGI point, bp (integer bp per point, not a bp multiplier). */
    readonly perAgiBp: number;
    /** Final crit chance cap, bp (≤ 10000). */
    readonly capBp: number;
  };
  readonly haste: {
    /** Haste rating per AGI point, bp. */
    readonly perAgiBp: number;
    /** Action interval with 0 haste, ticks. */
    readonly baseActionIntervalTicks: number;
    /** Lower bound of the action interval, ticks (≥ {@link MIN_ACTION_INTERVAL_TICKS}). */
    readonly minActionIntervalTicks: number;
    /**
     * Speed gained per haste point, bp: `interval = ⌈base × 10000 / (10000 + haste × speedPerHasteBp)⌉`, then clamped
     * to `[minActionIntervalTicks, base]`. Diminishing returns, same shape as armor mitigation (combat-engine §4).
     */
    readonly speedPerHasteBp: number;
  };
  readonly healPower: {
    /** Heal power per SPI point, bp. */
    readonly perSpiBp: number;
    /** Heal power per level above 1. */
    readonly perLevel: number;
  };
}

/** Provisional default table (open decision #2). Frozen; copy it to tune. */
export const DEFAULT_STAT_FORMULAS: StatFormulaTable = deepFreeze({
  maxHp: { base: 50, perLevel: 10, perVit: 8 },
  power: { perStrBp: 15_000, perIntBp: 15_000, perLevel: 1 },
  armor: { perVitBp: 5_000 },
  resist: { perSpiBp: 5_000 },
  crit: { baseBp: 500, perAgiBp: 20, capBp: 5_000 },
  haste: { perAgiBp: 5_000, baseActionIntervalTicks: 6, minActionIntervalTicks: 2, speedPerHasteBp: 100 },
  healPower: { perSpiBp: 15_000, perLevel: 1 },
});

/**
 * Throws a `RangeError` naming the first invalid field. Every field must be a non-negative safe integer;
 * `maxHp.base ≥ 1`, `crit.capBp ≤ 10000`, `2 ≤ minActionIntervalTicks ≤ baseActionIntervalTicks`.
 */
export function validateStatFormulaTable(table: StatFormulaTable): void {
  for (const [group, fields] of Object.entries(table) as [string, Record<string, number>][]) {
    for (const [field, value] of Object.entries(fields)) {
      const name = `${group}.${field}`;
      assertInt(value, name);
      if (value < 0) throw new RangeError(`${name} must be >= 0, got ${value}`);
    }
  }
  if (table.maxHp.base < 1) throw new RangeError('maxHp.base must be >= 1');
  if (table.crit.capBp > 10_000) throw new RangeError('crit.capBp must be <= 10000');
  const { minActionIntervalTicks: min, baseActionIntervalTicks: base } = table.haste;
  if (min < MIN_ACTION_INTERVAL_TICKS) {
    throw new RangeError(`haste.minActionIntervalTicks must be >= ${MIN_ACTION_INTERVAL_TICKS}`);
  }
  if (base < min) throw new RangeError('haste.baseActionIntervalTicks must be >= haste.minActionIntervalTicks');
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
