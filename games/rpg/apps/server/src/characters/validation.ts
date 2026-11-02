import type { LoadedContent } from '@engine/server-kit';
import { ATTRIBUTES, AutomationRulesSchema, ItemSchema, SkillIdSchema, SkillSchema } from '@rpg/rpg-schema';
import type { AutomationRules, Skill, SkillId } from '@rpg/rpg-schema';
import { z } from 'zod';

/** PROVISIONAL: paper-design Bulwark level-1 allocation, not a final character/build-system decision. */
export const PROVISIONAL_STARTER_ATTRIBUTES = { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 } as const;
export const PROVISIONAL_STARTER_SKILLS: readonly SkillId[] = ['skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'];
export const PROVISIONAL_ACTIVE_SKILL_SLOTS = 4;
export const BASIC_ATTACK: SkillId = 'skill:basic_attack';
const points = z.int().min(0).max(2_147_483_647);
export const CharacterAttributesSchema = z.strictObject({ STR: points, AGI: points, INT: points, VIT: points, SPI: points });
export type CharacterAttributes = z.output<typeof CharacterAttributesSchema>;
export const CharacterNameSchema = z.string().trim().min(1).max(32).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'name must not contain control characters');
export const CreateCharacterSchema = z.strictObject({ name: CharacterNameSchema });
export const ConfigureCharacterSchema = z.strictObject({
  name: CharacterNameSchema.optional(),
  /** Spend earned points; this is an additive allocation, never a full client-supplied attribute replacement. */
  allocate: CharacterAttributesSchema.partial().optional(),
  skillLoadout: z.array(SkillIdSchema).max(PROVISIONAL_ACTIVE_SKILL_SLOTS).optional(),
  automationRules: AutomationRulesSchema.optional(),
}).refine(value => Object.keys(value).length > 0, 'configuration update must not be empty');
export type ConfigureCharacter = z.output<typeof ConfigureCharacterSchema>;
export class CharacterError extends Error {
  readonly code: 'invalid_configuration' | 'character_exists';
  readonly statusCode: 400 | 409;
  constructor(code: 'invalid_configuration' | 'character_exists', statusCode: 400 | 409, message: string = code) {
    super(message); this.code = code; this.statusCode = statusCode; this.name = 'CharacterError';
  }
}
function invalid(message: string): never { throw new CharacterError('invalid_configuration', 400, message); }
export function allocateAttributes(current: CharacterAttributes, unspentPoints: number, additions: Partial<Record<keyof CharacterAttributes, number | undefined>>): { attributes: CharacterAttributes; unspentPoints: number } {
  CharacterAttributesSchema.parse(current);
  points.parse(unspentPoints);
  const parsed = CharacterAttributesSchema.partial().parse(additions);
  const spent = ATTRIBUTES.reduce((sum, key) => sum + (parsed[key] ?? 0), 0);
  if (spent > unspentPoints) invalid('allocation exceeds earned unspent points');
  const attributes = { ...current };
  for (const key of ATTRIBUTES) attributes[key] += parsed[key] ?? 0;
  CharacterAttributesSchema.parse(attributes);
  return { attributes, unspentPoints: unspentPoints - spent };
}
export function characterContent(content: LoadedContent): { skills: Map<SkillId, Skill>; consumables: Set<string> } {
  const skills = new Map((content.collections['skills'] ?? []).map(value => {
    const skill = SkillSchema.parse(value); return [skill.id, skill] as const;
  }));
  const consumables = new Set((content.collections['items'] ?? []).map(value => ItemSchema.parse(value))
    .filter(item => item.kind === 'consumable').map(item => item.id));
  return { skills, consumables };
}
/** Only the explicitly provisioned starter kit is unlocked; merely adding a future skill to content grants nothing. */
export function validateCharacterConfiguration(content: LoadedContent, loadout: readonly SkillId[], rules: AutomationRules): void {
  const parsedLoadout = z.array(SkillIdSchema).max(PROVISIONAL_ACTIVE_SKILL_SLOTS).parse(loadout);
  AutomationRulesSchema.parse(rules);
  const { skills, consumables } = characterContent(content);
  if (!skills.has(BASIC_ATTACK)) invalid('basic attack is absent from content');
  if (new Set(parsedLoadout).size !== parsedLoadout.length) invalid('duplicate equipped skill');
  for (const id of parsedLoadout) {
    if (!skills.has(id) || !PROVISIONAL_STARTER_SKILLS.includes(id)) invalid('skill is unknown or not unlocked');
  }
  const equipped = new Set<SkillId>([BASIC_ATTACK, ...parsedLoadout]);
  for (const rule of rules) {
    if (rule.when.skillReady && !equipped.has(rule.when.skillReady)) invalid('rule condition names an unequipped skill');
    if (rule.when.hasConsumable && !consumables.has(rule.when.hasConsumable)) invalid('rule condition names an unknown consumable');
    if ('useConsumable' in rule.do) {
      if (!consumables.has(rule.do.useConsumable)) invalid('rule action names an unknown consumable');
      continue;
    }
    if (!equipped.has(rule.do.useSkill)) invalid('rule action names an unequipped skill');
    const skill = skills.get(rule.do.useSkill);
    if (!skill) invalid('rule action names an unknown skill');
    const selector = rule.do.target;
    if (selector === 'self' && skill.targeting !== 'self' && skill.targeting !== 'ally') invalid('self selector is incompatible with skill');
    if (selector === 'lowestHpAlly' && skill.targeting !== 'ally') invalid('ally selector is incompatible with skill');
    if (selector && ['lowestHpEnemy', 'highestHpEnemy', 'telegraphingEnemy'].includes(selector) && skill.targeting !== 'enemy') invalid('enemy selector is incompatible with skill');
  }
}
export const PROVISIONAL_STARTER_RULES: AutomationRules = [
  { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
  { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
  { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
  { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
  { when: {}, do: { useSkill: BASIC_ATTACK, target: 'lowestHpEnemy' } },
];
