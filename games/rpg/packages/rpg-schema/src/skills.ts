/**
 * Skill definitions (docs/spec/content-format.md §3 `skill.json`, data-model §1 `SkillDef`).
 */
import { TagSchema } from '@engine/world';
import { z } from 'zod';

import { EffectSchema } from './effects.ts';
import { SkillIdSchema, TextKeySchema } from './ids.ts';
import { SkillTargetingSchema } from './rules.ts';

/**
 * Skill resource cost. **Placeholder**: no resource system is specified yet (docs/open-decisions.md #13, final skill
 * and build system); `energy` is the only accepted resource until that decision is recorded.
 */
export const SkillCostSchema = z.strictObject({
  resource: z.enum(['energy']),
  amount: z.int().positive(),
});
export type SkillCost = z.output<typeof SkillCostSchema>;

export const SkillSchema = z.strictObject({
  id: SkillIdSchema,
  nameKey: TextKeySchema.optional(),
  cooldownTicks: z.int().min(0),
  /** Ticks between `TelegraphStarted` and resolution; > 0 makes the skill telegraphed. */
  windupTicks: z.int().min(0),
  targeting: SkillTargetingSchema,
  cost: SkillCostSchema.optional(),
  effects: z.array(EffectSchema).min(1),
  tags: z.array(TagSchema).default([]),
  deprecated: z.boolean().optional(),
});
export type Skill = z.output<typeof SkillSchema>;
export type SkillInput = z.input<typeof SkillSchema>;
