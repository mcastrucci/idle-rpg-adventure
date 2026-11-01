/**
 * Scavenging tuning tables (content/scavenge.json): per-district find and threat tables, medkit and infection rules.
 * Validated once at load time with Zod; all numbers are integers (weights, ranges, basis points, condition points).
 */
import { z } from 'zod';

import scavengeContent from '../content/scavenge.json' with { type: 'json' };

const ItemIdSchema = z.string().regex(/^item:[a-z0-9_]+$/);
const ThreatIdSchema = z.string().regex(/^threat:[a-z0-9_]+$/);
const DistrictIdSchema = z.string().regex(/^area:[a-z0-9_.]+$/);

const FindEntrySchema = z.union([
  z.strictObject({ item: z.null(), weight: z.int().min(0) }),
  z
    .strictObject({ item: ItemIdSchema, weight: z.int().min(0), min: z.int().min(1), max: z.int().min(1) })
    .refine((e) => e.min <= e.max, 'min must be <= max'),
]);

const ThreatEntrySchema = z
  .strictObject({
    threat: ThreatIdSchema,
    weight: z.int().min(0),
    minDamage: z.int().min(0),
    maxDamage: z.int().min(0),
  })
  .refine((e) => e.minDamage <= e.maxDamage, 'minDamage must be <= maxDamage');

const positiveTotal = <T extends { weight: number }>(entries: readonly T[]): boolean =>
  entries.reduce((sum, e) => sum + e.weight, 0) > 0;

const DistrictTableSchema = z.strictObject({
  searchesPerMember: z.int().min(0).max(10),
  finds: z.array(FindEntrySchema).min(1).refine(positiveTotal, 'total find weight must be > 0'),
  threatChanceBp: z.int().min(0).max(10_000),
  threats: z.array(ThreatEntrySchema).min(1).refine(positiveTotal, 'total threat weight must be > 0'),
});

export const ScavengeTablesSchema = z.strictObject({
  medkit: z.strictObject({ useBelowCondition: z.int().min(1).max(100), heal: z.int().min(1).max(100) }),
  infection: z.strictObject({ damagePerHour: z.int().min(0).max(100) }),
  districts: z.record(DistrictIdSchema, DistrictTableSchema),
});

export type ScavengeTables = z.output<typeof ScavengeTablesSchema>;
export type DistrictTable = z.output<typeof DistrictTableSchema>;

/** The threat id whose hit leaves an ongoing infection (cured by a medkit). */
export const INFECTION_THREAT = 'threat:infection';

export const SCAVENGE_TABLES: ScavengeTables = ScavengeTablesSchema.parse(scavengeContent);
