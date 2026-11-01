/**
 * Closed stat set (docs/spec/combat-engine.md §3, provisional) and integer stat maps.
 */
import { z } from 'zod';

/** Base attributes. */
export const ATTRIBUTES = ['STR', 'AGI', 'INT', 'VIT', 'SPI'] as const;
/** Derived combat stats. `critBp` is in basis points; `haste` reduces the action interval in ticks. */
export const DERIVED_STATS = ['maxHp', 'power', 'armor', 'resist', 'critBp', 'haste', 'healPower'] as const;
export const STATS = [...ATTRIBUTES, ...DERIVED_STATS] as const;

export const StatSchema = z.enum(STATS);
export type Stat = z.output<typeof StatSchema>;

/** Basis-point scale (10000 = 100%). */
export const BP = 10_000;

/** Integer basis points in `[0, 10000]`. */
export const BpSchema = z.int().min(0).max(BP);

/** Sparse map of stat → integer (gear bonuses, modifiers). Unknown stats are rejected. */
export const StatMapSchema = z.partialRecord(StatSchema, z.int());
export type StatMap = z.output<typeof StatMapSchema>;

/**
 * Stats of an enemy: a stat map whose `maxHp` is mandatory and positive; every other stat is a non-negative integer.
 */
const optionalStat = z.int().min(0).optional();
export const EnemyStatsSchema = z.strictObject({
  STR: optionalStat,
  AGI: optionalStat,
  INT: optionalStat,
  VIT: optionalStat,
  SPI: optionalStat,
  maxHp: z.int().positive(),
  power: optionalStat,
  armor: optionalStat,
  resist: optionalStat,
  critBp: BpSchema.optional(),
  haste: optionalStat,
  healPower: optionalStat,
} satisfies Record<Stat, z.ZodType>);
export type EnemyStats = z.output<typeof EnemyStatsSchema>;
