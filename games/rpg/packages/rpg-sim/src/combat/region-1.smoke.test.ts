/**
 * Smoke test only: builds combats from the compiled Region 1 content (provisional balance, #73) to prove the engine
 * accepts real compiled data. Not a balance assertion; the engine's behaviour is pinned by the in-test content suites.
 */
import { fileURLToPath } from 'node:url';

import { compileContent, loadContentFiles } from '@engine/content-compiler';
import plugin from '@rpg/content-plugin';
import { EnemySchema, ItemSchema, SkillSchema } from '@rpg/rpg-schema';
import type { Enemy, Item, Skill } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { runToEnd } from '../index.ts';
import type { CombatContent } from '../index.ts';
import { BRUISER_L5, ofType, rules } from './testing/fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../../content/', import.meta.url));

function loadRegion1(): CombatContent {
  const result = compileContent(loadContentFiles(ROOT), plugin, { contentRoot: ROOT });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  const { collections } = result.bundle;
  const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));
  return {
    skills: byId<Skill>((collections['skills'] ?? []).map((s) => SkillSchema.parse(s))),
    items: byId<Item>((collections['items'] ?? []).map((i) => ItemSchema.parse(i))),
    enemies: byId<Enemy>((collections['enemies'] ?? []).map((e) => EnemySchema.parse(e))),
  };
}

describe('Region 1 compiled content (smoke)', () => {
  const content = loadRegion1();
  const region1 = Object.values(content.enemies).filter((e) => e.tags.includes('region_1'));

  it('runs a deterministic combat against every Region 1 enemy, including the telegraphing mini-boss', () => {
    expect(region1.length).toBeGreaterThanOrEqual(6);
    for (const enemy of region1) {
      const setup = {
        heroes: [
          {
            id: 'hero:a',
            build: BRUISER_L5,
            skills: ['skill:basic_attack', 'skill:guard', 'skill:shield_bash'],
            rules: rules([
              { when: { selfHpBelowBp: 3500 }, do: { useConsumable: 'item:minor_healing_potion' } },
              { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
              { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash' } },
              { when: {}, do: { useSkill: 'skill:basic_attack' } },
            ]),
            consumables: [{ item: 'item:minor_healing_potion', qty: 3 }],
          },
        ],
        enemies: [{ id: 'enemy:x', enemy: enemy.id }],
        content,
      };
      const a = runToEnd(setup, 7, undefined, 3000);
      const b = runToEnd(setup, 7, undefined, 3000);
      expect(b.events).toEqual(a.events);
      expect(a.events[0]?.type).toBe('CombatStarted');
      if (enemy.rank === 'boss') expect(ofType(a.events, 'TelegraphStarted').length).toBeGreaterThan(0);
    }
  });

  it('guard negates the Hollow Matriarch crushing-blow stun; unguarded blows stun (#71, Q-B6)', () => {
    const fight = (heroRules: Parameters<typeof rules>[0]) =>
      runToEnd(
        {
          heroes: [{ id: 'hero:a', build: BRUISER_L5, skills: ['skill:basic_attack', 'skill:guard'], rules: rules(heroRules) }],
          enemies: [{ id: 'enemy:boss', enemy: 'enemy:hollow_matriarch' }],
          content,
        },
        11,
        undefined,
        3000,
      ).events;
    const blowStuns = (events: ReturnType<typeof fight>) =>
      ofType(events, 'EffectApplied').filter((e) => e.origin === 'skill:crushing_blow' && e.effect === 'stun');
    const naive = fight([{ when: {}, do: { useSkill: 'skill:basic_attack' } }]);
    const guarded = fight([
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: {}, do: { useSkill: 'skill:basic_attack' } },
    ]);
    expect(blowStuns(naive).length).toBeGreaterThan(0);
    expect(ofType(naive, 'EffectNegated')).toEqual([]);
    const negated = ofType(guarded, 'EffectNegated');
    expect(negated.length).toBeGreaterThan(0);
    expect(negated.every((e) => e.origin === 'skill:crushing_blow' && e.effect === 'stun')).toBe(true);
  });
});
