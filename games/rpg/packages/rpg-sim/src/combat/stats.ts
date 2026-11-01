/**
 * Effective combat stats. Heroes are re-derived through `@rpg/rpg-stats` `deriveStats` with the active `stat_mod`s as
 * modifiers (so attribute buffs flow through the formulas). Enemies have no attribute formulas: `stat_mod`s apply to
 * their derived stats directly with the same rule (`(base + Σflat) × max(0, 10000 + ΣdeltaBp) / 10000`, floored);
 * attribute mods on enemies have no effect.
 */
import { BP_SCALE, mulDivFloor } from '@engine/sim-core';
import type { EnemyStats, Stat } from '@rpg/rpg-schema';
import { actionIntervalTicks, deriveStats } from '@rpg/rpg-stats';
import type { DeriveStatsInput, StatFormulaTable, StatModifier } from '@rpg/rpg-stats';

import type { ActorState, CombatState, CombatStats } from './types.ts';

export function heroStats(build: DeriveStatsInput, mods: readonly StatModifier[], table: StatFormulaTable): CombatStats {
  const d = deriveStats({ ...build, modifiers: [...(build.modifiers ?? []), ...mods] }, table);
  return {
    maxHp: d.maxHp,
    powerBySchool: { physical: d.powerBySchool.physical, magic: d.powerBySchool.magic },
    armor: d.armor,
    resist: d.resist,
    critBp: d.critBp,
    haste: d.haste,
    healPower: d.healPower,
    actionIntervalTicks: d.actionIntervalTicks,
  };
}

export function enemyStats(base: EnemyStats, mods: readonly StatModifier[], table: StatFormulaTable): CombatStats {
  const sums = new Map<Stat, { flat: number; deltaBp: number }>();
  for (const m of mods) {
    const acc = sums.get(m.stat) ?? { flat: 0, deltaBp: 0 };
    acc.flat += m.flat ?? 0;
    acc.deltaBp += m.deltaBp ?? 0;
    sums.set(m.stat, acc);
  }
  const mod = (stat: Stat, value: number): number => {
    const acc = sums.get(stat);
    if (acc === undefined) return value;
    return mulDivFloor(value + acc.flat, Math.max(0, BP_SCALE + acc.deltaBp), BP_SCALE);
  };
  const power = Math.max(0, mod('power', base.power ?? 0));
  const haste = Math.max(0, mod('haste', base.haste ?? 0));
  const critBp = mod('critBp', base.critBp ?? 0);
  return {
    maxHp: Math.max(1, mod('maxHp', base.maxHp)),
    powerBySchool: { physical: power, magic: power },
    armor: Math.max(0, mod('armor', base.armor ?? 0)),
    resist: Math.max(0, mod('resist', base.resist ?? 0)),
    critBp: critBp < 0 ? 0 : critBp > BP_SCALE ? BP_SCALE : critBp,
    haste,
    healPower: Math.max(0, mod('healPower', base.healPower ?? 0)),
    actionIntervalTicks: actionIntervalTicks(haste, table),
  };
}

/** Active stat modifiers of `actor`, in application order. */
function activeMods(state: CombatState, actor: ActorState): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const e of state.effects) {
    if (e.holderId === actor.id && e.type === 'stat_mod') mods.push({ stat: e.stat, flat: e.flat, deltaBp: e.deltaBp });
  }
  return mods;
}

/** Recomputes `actor.stats` from its base and active modifiers; HP is clamped to the new max HP (never healed). */
export function recomputeStats(state: CombatState, actor: ActorState): void {
  const mods = activeMods(state, actor);
  actor.stats =
    actor.build !== null
      ? heroStats(actor.build, mods, state.formulas)
      : enemyStats(actor.baseStats as EnemyStats, mods, state.formulas);
  if (actor.hp > actor.stats.maxHp) actor.hp = actor.stats.maxHp;
}

/** HP share in basis points, floored. */
export function hpBp(actor: ActorState): number {
  return mulDivFloor(actor.hp, BP_SCALE, actor.stats.maxHp);
}
