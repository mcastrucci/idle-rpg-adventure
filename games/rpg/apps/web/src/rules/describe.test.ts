import type { AutomationRule } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import type { ContentLabels } from '../content/labels.ts';
import { CONDITION_KEYS, SCHEMA_CONDITION_KEYS } from './catalog.ts';
import { conditionChips, describeRule, formatBp } from './describe.ts';

const NAMES: Record<string, string> = {
  'skill:guard': 'Guard', 'skill:mend': 'Mend', 'skill:basic_attack': 'Basic Attack', 'item:minor_healing_potion': 'Minor Healing Potion',
};
const labels: ContentLabels = { skill: (id) => NAMES[id] ?? id, item: (id) => NAMES[id] ?? id };
const attack = { useSkill: 'skill:basic_attack' } as const;

describe('describeRule', () => {
  it('covers the whole closed condition set of the schema', () => {
    expect([...CONDITION_KEYS].sort()).toEqual([...SCHEMA_CONDITION_KEYS].sort());
  });

  it('describes the issue example', () => {
    const rule: AutomationRule = { when: { selfHpBelowBp: 3500 }, do: { useConsumable: 'item:minor_healing_potion' } };
    expect(describeRule(rule, labels)).toBe('If my HP is below 35%, use Minor Healing Potion.');
  });

  it.each<[string, AutomationRule['when'], string]>([
    ['selfHpBelowBp', { selfHpBelowBp: 3550 }, 'If my HP is below 35.5%, use Basic Attack.'],
    ['allyHpBelowBp', { allyHpBelowBp: 5000 }, "If an ally's HP is below 50%, use Basic Attack."],
    ['selfHasHarmfulEffect', { selfHasHarmfulEffect: true }, 'If I have a harmful effect, use Basic Attack.'],
    ['enemyTelegraphing', { enemyTelegraphing: true }, 'If an enemy is winding up an attack, use Basic Attack.'],
    ['skillReady', { skillReady: 'skill:guard' }, 'If Guard is ready, use Basic Attack.'],
    ['enemiesAtLeast (1)', { enemiesAtLeast: 1 }, 'If there is at least 1 enemy, use Basic Attack.'],
    ['enemiesAtLeast (3)', { enemiesAtLeast: 3 }, 'If there are at least 3 enemies, use Basic Attack.'],
    ['hasConsumable', { hasConsumable: 'item:minor_healing_potion' }, 'If I carry Minor Healing Potion, use Basic Attack.'],
  ])('describes %s', (_name, when, expected) => {
    expect(describeRule({ when, do: attack }, labels)).toBe(expected);
  });

  it('describes an empty condition set as always', () => {
    expect(describeRule({ when: {}, do: attack }, labels)).toBe('Always use Basic Attack.');
  });

  it('joins ANDed conditions in a fixed order', () => {
    const rule: AutomationRule = {
      when: { skillReady: 'skill:mend', allyHpBelowBp: 5000, enemiesAtLeast: 2 },
      do: { useSkill: 'skill:mend', target: 'lowestHpAlly' },
    };
    expect(describeRule(rule, labels)).toBe(
      "If an ally's HP is below 50%, Mend is ready and there are at least 2 enemies, use Mend on the ally with the lowest HP.",
    );
  });

  it.each([
    ['self', 'use Mend on myself'],
    ['lowestHpAlly', 'use Mend on the ally with the lowest HP'],
    ['lowestHpEnemy', 'use Mend on the enemy with the lowest HP'],
    ['highestHpEnemy', 'use Mend on the enemy with the highest HP'],
    ['telegraphingEnemy', 'use Mend on the enemy winding up an attack'],
  ] as const)('describes target %s', (target, expected) => {
    expect(describeRule({ when: {}, do: { useSkill: 'skill:mend', target } }, labels)).toBe(`Always ${expected}.`);
  });

  it('derives labels from IDs by default', () => {
    expect(describeRule({ when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash' } })).toBe(
      'If Shield Bash is ready, use Shield Bash.',
    );
  });

  it('builds short chips', () => {
    expect(conditionChips({ selfHpBelowBp: 4000, hasConsumable: 'item:minor_healing_potion', enemiesAtLeast: 2 }, labels).map((c) => c.label))
      .toEqual(['My HP < 40%', '2+ enemies', 'Carrying Minor Healing Potion']);
  });

  it('formats basis points', () => {
    expect([formatBp(0), formatBp(500), formatBp(3505), formatBp(10000)]).toEqual(['0%', '5%', '35.05%', '100%']);
  });
});
