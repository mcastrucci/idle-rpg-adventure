/**
 * Closed effect set (docs/spec/combat-engine.md §5, data-model §1 `EffectDef`). Every number is an integer; percentages
 * and coefficients are basis points (`coeffBp: 8000` = 80% of power).
 */
import { z } from 'zod';

import { StatSchema } from './stats.ts';

/** What consumes a duration: the global tick counter, the owner's actions, or eligible attacks (e.g. taunt). */
export const DURATION_UNITS = ['ticks', 'actions', 'attacks'] as const;
export const DurationUnitSchema = z.enum(DURATION_UNITS);
export type DurationUnit = z.output<typeof DurationUnitSchema>;

export const DurationSchema = z.strictObject({
  value: z.int().positive(),
  unit: DurationUnitSchema,
});
export type Duration = z.output<typeof DurationSchema>;

/** Damage schools; `power` is derived per school (combat-engine §3). Provisional. */
export const DAMAGE_SCHOOLS = ['physical', 'magic'] as const;
export const DamageSchoolSchema = z.enum(DAMAGE_SCHOOLS);
export type DamageSchool = z.output<typeof DamageSchoolSchema>;

/**
 * Who receives the effect: the skill's resolved target (default) or the caster. Lets one skill hit an enemy and
 * shield its user.
 */
export const EffectRecipientSchema = z.enum(['target', 'self']);
export type EffectRecipient = z.output<typeof EffectRecipientSchema>;

/** Positive coefficient in basis points (no upper bound: 15000 = 150%). */
const CoeffBpSchema = z.int().positive();
/** Interval between periodic (DoT/HoT) applications, in ticks. */
const PeriodTicksSchema = z.int().positive().default(1);
const to = EffectRecipientSchema.default('target');

export const DamageEffectSchema = z.strictObject({
  type: z.literal('damage'),
  coeffBp: CoeffBpSchema,
  school: DamageSchoolSchema,
  to,
});
export const HealEffectSchema = z.strictObject({ type: z.literal('heal'), coeffBp: CoeffBpSchema, to });
export const ShieldEffectSchema = z.strictObject({
  type: z.literal('shield'),
  coeffBp: CoeffBpSchema,
  duration: DurationSchema,
  to,
});
export const DotEffectSchema = z.strictObject({
  type: z.literal('dot'),
  /** Coefficient of each periodic application. */
  coeffBp: CoeffBpSchema,
  school: DamageSchoolSchema,
  periodTicks: PeriodTicksSchema,
  duration: DurationSchema,
  to,
});
export const HotEffectSchema = z.strictObject({
  type: z.literal('hot'),
  coeffBp: CoeffBpSchema,
  periodTicks: PeriodTicksSchema,
  duration: DurationSchema,
  to,
});
/** Exactly one of `deltaBp` (relative, basis points) or `flat` (absolute); negative values are debuffs. */
export const StatModEffectSchema = z
  .strictObject({
    type: z.literal('stat_mod'),
    stat: StatSchema,
    deltaBp: z.int().optional(),
    flat: z.int().optional(),
    duration: DurationSchema,
    to,
  })
  .refine((e) => (e.deltaBp === undefined) !== (e.flat === undefined), {
    message: 'stat_mod needs exactly one of "deltaBp" or "flat"',
    path: ['deltaBp'],
  })
  .refine((e) => e.deltaBp !== 0 && e.flat !== 0, { message: 'stat_mod delta must not be 0', path: ['deltaBp'] });
export const TauntEffectSchema = z.strictObject({ type: z.literal('taunt'), duration: DurationSchema, to });
export const StunEffectSchema = z.strictObject({ type: z.literal('stun'), duration: DurationSchema, to });
/** Removes harmful effects (DoTs, stuns, negative stat mods) from the recipient. */
export const CleanseEffectSchema = z.strictObject({ type: z.literal('cleanse'), to });

export const EffectSchema = z.discriminatedUnion('type', [
  DamageEffectSchema,
  HealEffectSchema,
  ShieldEffectSchema,
  DotEffectSchema,
  HotEffectSchema,
  StatModEffectSchema,
  TauntEffectSchema,
  StunEffectSchema,
  CleanseEffectSchema,
]);
export type Effect = z.output<typeof EffectSchema>;
export type EffectInput = z.input<typeof EffectSchema>;
export type EffectType = Effect['type'];
export const EFFECT_TYPES = EffectSchema.options.map((o) => o.shape.type.value) as readonly EffectType[];
