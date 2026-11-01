/**
 * Attribute + equipment + modifiers → derived combat stats (combat-engine §3). Pure, integer-only, deterministic.
 *
 * Pipeline (fixed order, no reliance on object iteration order for results):
 *   1. Effective attributes = base + Σ gear attribute bonuses + Σ flat attribute modifiers, then
 *      `× (10000 + Σ deltaBp) / 10000` (floored), clamped to ≥ 0.
 *   2. Raw derived stats from the formula table and effective attributes, plus Σ gear bonuses of that stat.
 *   3. Derived modifiers: Σ flat, then `× (10000 + Σ deltaBp) / 10000` (floored, multiplier clamped to ≥ 0).
 *      Modifiers on `power` apply to every school.
 *   4. Clamps: `maxHp ≥ 1`, `critBp ∈ [0, capBp]`, everything else `≥ 0`; the action interval is derived from the
 *      final haste and clamped to `[minActionIntervalTicks, baseActionIntervalTicks]`.
 */
import { ATTRIBUTES, DAMAGE_SCHOOLS } from '@rpg/rpg-schema';
import type { DamageSchool, Stat, StatMap } from '@rpg/rpg-schema';

import type { StatFormulaTable } from './formulas.ts';
import { validateStatFormulaTable } from './formulas.ts';
import { BP_SCALE, assertInt, divCeil, mulBp, mulDivFloor } from './int-math.ts';

export type Attribute = (typeof ATTRIBUTES)[number];
export type AttributeMap = Readonly<Record<Attribute, number>>;

/** Anything carrying a gear stat map — an `EquipmentItem` from `@rpg/rpg-schema` fits. */
export interface EquipmentStatSource {
  readonly stats: StatMap;
}

/**
 * A temporary stat change (buff/debuff); same shape as the `stat_mod` effect in `@rpg/rpg-schema`.
 * Exactly one of `flat` / `deltaBp` should be set; if both are, both apply.
 */
export interface StatModifier {
  readonly stat: Stat;
  readonly flat?: number;
  readonly deltaBp?: number;
}

export interface DeriveStatsInput {
  /** Character level, integer ≥ 1. */
  readonly level: number;
  /** Base (allocated) attributes, non-negative integers. */
  readonly attributes: AttributeMap;
  readonly equipment: readonly EquipmentStatSource[];
  readonly modifiers?: readonly StatModifier[];
}

export interface DerivedStats {
  readonly level: number;
  /** Effective attributes after gear and modifiers. */
  readonly attributes: AttributeMap;
  readonly maxHp: number;
  /** Power per damage school: physical from STR, magic from INT; gear/modifier `power` applies to both. */
  readonly powerBySchool: Readonly<Record<DamageSchool, number>>;
  /** Headline power = max over schools (the "max(STR, INT)-based" display value of combat-engine §3). */
  readonly power: number;
  readonly armor: number;
  readonly resist: number;
  /** Crit chance in basis points, clamped to the table cap. */
  readonly critBp: number;
  /** Haste rating. */
  readonly haste: number;
  /** Ticks between actions, derived from `haste`; never below 2. */
  readonly actionIntervalTicks: number;
  readonly healPower: number;
}

/** Derived stats a gear piece or modifier can target directly (attributes are handled separately). */
type DerivedStatKey = Exclude<Stat, Attribute>;

interface Accumulator {
  flat: number;
  deltaBp: number;
}

export function deriveStats(input: DeriveStatsInput, table: StatFormulaTable): DerivedStats {
  validateStatFormulaTable(table);
  const { level, equipment, modifiers = [] } = input;
  assertInt(level, 'level');
  if (level < 1) throw new RangeError(`level must be >= 1, got ${level}`);

  const gear = sumGear(equipment);
  const mods = sumModifiers(modifiers);

  // 1. Effective attributes.
  const attrs = {} as Record<Attribute, number>;
  for (const attr of ATTRIBUTES) {
    const base = input.attributes[attr];
    assertInt(base, `attributes.${attr}`);
    if (base < 0) throw new RangeError(`attributes.${attr} must be >= 0, got ${base}`);
    attrs[attr] = Math.max(0, applyModifier(base + (gear.get(attr) ?? 0), mods.get(attr)));
  }

  // 2. Raw derived stats (+ gear), 3. derived modifiers.
  const levelsAbove1 = level - 1;
  const finish = (stat: DerivedStatKey, raw: number): number =>
    applyModifier(raw + (gear.get(stat) ?? 0), mods.get(stat));

  const maxHp = finish('maxHp', table.maxHp.base + table.maxHp.perLevel * levelsAbove1 + table.maxHp.perVit * attrs.VIT);

  const schoolBase: Record<DamageSchool, number> = {
    physical: mulBp(attrs.STR, table.power.perStrBp),
    magic: mulBp(attrs.INT, table.power.perIntBp),
  };
  const powerBySchool = {} as Record<DamageSchool, number>;
  let power = 0;
  for (const school of DAMAGE_SCHOOLS) {
    const value = Math.max(0, finish('power', schoolBase[school] + table.power.perLevel * levelsAbove1));
    powerBySchool[school] = value;
    power = Math.max(power, value);
  }

  const armor = Math.max(0, finish('armor', mulBp(attrs.VIT, table.armor.perVitBp)));
  const resist = Math.max(0, finish('resist', mulBp(attrs.SPI, table.resist.perSpiBp)));
  const critBp = clamp(finish('critBp', table.crit.baseBp + table.crit.perAgiBp * attrs.AGI), 0, table.crit.capBp);
  const haste = Math.max(0, finish('haste', mulBp(attrs.AGI, table.haste.perAgiBp)));
  const healPower = Math.max(
    0,
    finish('healPower', mulBp(attrs.SPI, table.healPower.perSpiBp) + table.healPower.perLevel * levelsAbove1),
  );

  // 4. Clamps.
  return {
    level,
    attributes: attrs,
    maxHp: Math.max(1, maxHp),
    powerBySchool,
    power,
    armor,
    resist,
    critBp,
    haste,
    actionIntervalTicks: actionIntervalTicks(haste, table),
    healPower,
  };
}

/**
 * `⌈base × 10000 / (10000 + haste × speedPerHasteBp)⌉`, clamped to `[min, base]`. Rounds up so a tick is only saved
 * once the full tick is earned (flooring would make the first haste point always save a tick).
 */
export function actionIntervalTicks(haste: number, table: StatFormulaTable): number {
  assertInt(haste, 'haste');
  const { baseActionIntervalTicks: base, minActionIntervalTicks: min, speedPerHasteBp } = table.haste;
  const speedBp = BP_SCALE + Math.max(0, haste) * speedPerHasteBp;
  const ticks = divCeil(base * BP_SCALE, speedBp);
  return clamp(ticks, min, base);
}

function sumGear(equipment: readonly EquipmentStatSource[]): Map<Stat, number> {
  const totals = new Map<Stat, number>();
  equipment.forEach((piece, i) => {
    for (const [stat, value] of Object.entries(piece.stats) as [Stat, number | undefined][]) {
      if (value === undefined) continue;
      assertInt(value, `equipment[${i}].stats.${stat}`);
      totals.set(stat, (totals.get(stat) ?? 0) + value);
    }
  });
  return totals;
}

function sumModifiers(modifiers: readonly StatModifier[]): Map<Stat, Accumulator> {
  const totals = new Map<Stat, Accumulator>();
  modifiers.forEach((mod, i) => {
    const acc = totals.get(mod.stat) ?? { flat: 0, deltaBp: 0 };
    if (mod.flat !== undefined) {
      assertInt(mod.flat, `modifiers[${i}].flat`);
      acc.flat += mod.flat;
    }
    if (mod.deltaBp !== undefined) {
      assertInt(mod.deltaBp, `modifiers[${i}].deltaBp`);
      acc.deltaBp += mod.deltaBp;
    }
    totals.set(mod.stat, acc);
  });
  return totals;
}

/** `(value + flat) × max(0, 10000 + deltaBp) / 10000`, floored. Sums make the result order-independent. */
function applyModifier(value: number, acc: Accumulator | undefined): number {
  if (acc === undefined) return value;
  return mulDivFloor(value + acc.flat, Math.max(0, BP_SCALE + acc.deltaBp), BP_SCALE);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
