import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import plugin from '@rpg/content-plugin';
import { describe, expect, it } from 'vitest';

import {
  allocateAttributes, ConfigureCharacterSchema, CreateCharacterSchema, PROVISIONAL_STARTER_ATTRIBUTES,
  PROVISIONAL_STARTER_RULES, PROVISIONAL_STARTER_SKILLS, validateCharacterConfiguration,
} from './validation.ts';

const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const content = compiled.bundle;

describe('server-owned character configuration', () => {
  it('validates the provisional starter with actual compiled content/schema', () => {
    expect(() => validateCharacterConfiguration(content, PROVISIONAL_STARTER_SKILLS, PROVISIONAL_STARTER_RULES)).not.toThrow();
    expect(Object.values(PROVISIONAL_STARTER_ATTRIBUTES).reduce((sum, n) => sum + n, 0)).toBe(30);
    expect(CreateCharacterSchema.parse({ name: '  Ada  ' })).toEqual({ name: 'Ada' });
  });
  it('rejects client-authored progression, ownership and starter allocations', () => {
    for (const field of ['accountId', 'actorId', 'gameId', 'level', 'xp', 'attributes', 'unspentPoints', 'skillLoadout']) {
      expect(() => CreateCharacterSchema.parse({ name: 'Ada', [field]: 100 })).toThrow();
    }
    for (const field of ['accountId', 'actorId', 'gameId', 'level', 'xp', 'attributes', 'unspentPoints']) {
      expect(() => ConfigureCharacterSchema.parse({ name: 'Ada', [field]: 100 })).toThrow();
    }
    expect(() => ConfigureCharacterSchema.parse({})).toThrow();
    expect(() => CreateCharacterSchema.parse({ name: 'a\u0000b' })).toThrow();
  });
  it('spends only earned points, rejecting overspend/negative/fractional/unknown allocations', () => {
    expect(allocateAttributes(PROVISIONAL_STARTER_ATTRIBUTES, 3, { STR: 2, SPI: 1 })).toEqual({
      attributes: { ...PROVISIONAL_STARTER_ATTRIBUTES, STR: 11, SPI: 6 }, unspentPoints: 0,
    });
    expect(() => allocateAttributes(PROVISIONAL_STARTER_ATTRIBUTES, 0, { STR: 1 })).toThrow('allocation exceeds');
    expect(() => allocateAttributes(PROVISIONAL_STARTER_ATTRIBUTES, 1, { STR: -1 })).toThrow();
    expect(() => allocateAttributes(PROVISIONAL_STARTER_ATTRIBUTES, 1, { STR: 0.5 })).toThrow();
    expect(() => ConfigureCharacterSchema.parse({ allocate: { unknown: 5 } })).toThrow();
  });
  it('enforces known and explicitly unlocked skills, uniqueness, active slots, and the always-available basic', () => {
    expect(() => validateCharacterConfiguration(content, ['skill:unknown'], [])).toThrow();
    expect(() => validateCharacterConfiguration(content, ['skill:crushing_blow'], [])).toThrow();
    expect(() => validateCharacterConfiguration(content, ['skill:precise_strike'], [])).toThrow();
    expect(() => validateCharacterConfiguration(content, ['skill:guard', 'skill:guard'], [])).toThrow();
    expect(() => validateCharacterConfiguration(content, [...PROVISIONAL_STARTER_SKILLS, 'skill:basic_attack'], [])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: {}, do: { useSkill: 'skill:basic_attack' } }])).not.toThrow();
  });
  it('checks rule skills/conditions against equipped skills, consumables against item content and selectors', () => {
    expect(() => validateCharacterConfiguration(content, [], [{ when: {}, do: { useSkill: 'skill:guard' } }])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: { skillReady: 'skill:guard' }, do: { useSkill: 'skill:basic_attack' } }])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: { hasConsumable: 'item:glowcap' }, do: { useSkill: 'skill:basic_attack' } }])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: {}, do: { useConsumable: 'item:nonexistent' } }])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: {}, do: { useConsumable: 'item:minor_healing_potion' } }])).not.toThrow();
    expect(() => validateCharacterConfiguration(content, [], [{ when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpAlly' } }])).toThrow();
    expect(() => validateCharacterConfiguration(content, [], Array.from({ length: 7 }, () => ({ when: {}, do: { useSkill: 'skill:basic_attack' as const } })))).toThrow();
  });
});
