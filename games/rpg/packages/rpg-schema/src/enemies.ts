/**
 * Enemy and boss definitions (data-model §1 `EnemyDef`/`BossDef`, combat-engine §7). Discriminated by `rank`.
 *
 * Intra-entity checks done here: every skill referenced by AI rules, phase rotations and telegraphs is listed in
 * `skills`; boss phases start at full HP with strictly decreasing thresholds; a boss telegraphs at least once (§7: a
 * mechanic that rewards a manual response). Cross-entity checks (the skill exists, telegraphs have `windupTicks > 0`)
 * belong to the content compiler.
 */
import { TagSchema } from '@engine/world';
import { z } from 'zod';

import { EnemyIdSchema, LootTableIdSchema, SkillIdSchema, TextKeySchema } from './ids.ts';
import { AiRulesSchema } from './rules.ts';
import { BP, BpSchema, EnemyStatsSchema } from './stats.ts';

export const BossPhaseSchema = z.strictObject({
  /** The phase starts when HP drops to or below this share of max HP. The first phase uses 10000. */
  fromHpBp: BpSchema,
  /** Skills used in order, cycling, while the phase is active. */
  rotation: z.array(SkillIdSchema).min(1),
  /** Rotation skills announced with `TelegraphStarted` (counterable by a manual response such as `guard`). */
  telegraphs: z.array(SkillIdSchema).default([]),
});
export type BossPhase = z.output<typeof BossPhaseSchema>;

const common = {
  id: EnemyIdSchema,
  nameKey: TextKeySchema.optional(),
  level: z.int().positive(),
  stats: EnemyStatsSchema,
  skills: z.array(SkillIdSchema).min(1),
  /** Priority list (like automation rules); for bosses it applies when the current phase has no ready rotation skill. */
  ai: AiRulesSchema,
  xp: z.int().min(0),
  lootTable: LootTableIdSchema.optional(),
  tags: z.array(TagSchema).default([]),
  deprecated: z.boolean().optional(),
};

type SkillRefs = { skills: readonly string[]; ai: readonly { do: { useSkill: string } }[] };

function checkSkillRefs(enemy: SkillRefs, ctx: z.core.$RefinementCtx<unknown>): void {
  const known = new Set(enemy.skills);
  enemy.ai.forEach((rule, i) => {
    if (!known.has(rule.do.useSkill)) {
      ctx.addIssue({ code: 'custom', path: ['ai', i, 'do', 'useSkill'], message: `"${rule.do.useSkill}" is not in "skills"` });
    }
  });
}

export const NormalEnemySchema = z
  .strictObject({ ...common, rank: z.literal('normal') })
  .superRefine((enemy, ctx) => checkSkillRefs(enemy, ctx));

export const BossSchema = z
  .strictObject({
    ...common,
    rank: z.literal('boss'),
    phases: z.array(BossPhaseSchema).min(1),
  })
  .superRefine((boss, ctx) => {
    checkSkillRefs(boss, ctx);
    const known = new Set<string>(boss.skills);
    boss.phases.forEach((phase, i) => {
      if (i === 0 && phase.fromHpBp !== BP) {
        ctx.addIssue({ code: 'custom', path: ['phases', 0, 'fromHpBp'], message: `first phase must start at ${BP}` });
      }
      const previous = boss.phases[i - 1];
      if (previous && phase.fromHpBp >= previous.fromHpBp) {
        ctx.addIssue({ code: 'custom', path: ['phases', i, 'fromHpBp'], message: 'phase thresholds must strictly decrease' });
      }
      phase.rotation.forEach((skill, j) => {
        if (!known.has(skill)) ctx.addIssue({ code: 'custom', path: ['phases', i, 'rotation', j], message: `"${skill}" is not in "skills"` });
      });
      const rotation = new Set<string>(phase.rotation);
      phase.telegraphs.forEach((skill, j) => {
        if (!rotation.has(skill)) {
          ctx.addIssue({ code: 'custom', path: ['phases', i, 'telegraphs', j], message: `"${skill}" is not in this phase's rotation` });
        }
      });
    });
    if (boss.phases.every((phase) => phase.telegraphs.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['phases'], message: 'a boss needs at least one telegraphed skill' });
    }
  });

export const EnemySchema = z.discriminatedUnion('rank', [NormalEnemySchema, BossSchema]);
export type Enemy = z.output<typeof EnemySchema>;
export type EnemyInput = z.input<typeof EnemySchema>;
export type NormalEnemy = z.output<typeof NormalEnemySchema>;
export type Boss = z.output<typeof BossSchema>;

export function isBoss(enemy: Enemy): enemy is Boss {
  return enemy.rank === 'boss';
}
