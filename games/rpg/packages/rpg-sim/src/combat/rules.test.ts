import { EnemySchema } from '@rpg/rpg-schema';
import { describe, expect, it } from 'vitest';

import { createCombat, runToEnd } from '../index.ts';
import type { CombatEvent, CombatPolicy, CombatSetup, EnemySetup, HeroSetup } from '../index.ts';
import {
  CONTENT,
  ENEMIES,
  GUARD_RULES,
  NAIVE_RULES,
  advance,
  bossSetup,
  bruiser,
  manualGuardPolicy,
  ofType,
  rules,
  striker,
} from './testing/fixtures.ts';

function solo(hero: Partial<HeroSetup>, enemies: EnemySetup[]): CombatSetup {
  return {
    heroes: [bruiser({ skills: ['skill:strike', 'skill:cleave', 'skill:guard'], ...hero })],
    enemies,
    content: CONTENT,
  };
}

const dummies = (...hps: number[]): EnemySetup[] => hps.map((hp, i) => ({ id: `enemy:${i + 1}`, enemy: 'enemy:dummy', hp }));

function heroActions(events: CombatEvent[]) {
  return ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:a');
}

function actionName(e: { action: { kind: 'skill'; skill: string } | { kind: 'consumable'; item: string } }): string {
  return e.action.kind === 'skill' ? e.action.skill : e.action.item;
}

describe('automation rules', () => {
  it('first matching rule fires; consumables decrement the in-combat counter; an empty stack skips the rule', () => {
    const s = solo(
      {
        hp: 10,
        consumables: [{ item: 'item:minor_healing_potion', qty: 1 }],
        rules: rules([
          { when: { selfHpBelowBp: 3500, hasConsumable: 'item:minor_healing_potion' }, do: { useConsumable: 'item:minor_healing_potion' } },
          { when: { selfHpBelowBp: 3500 }, do: { useConsumable: 'item:minor_healing_potion' } },
          { when: {}, do: { useSkill: 'skill:strike' } },
        ]),
      },
      dummies(5000),
    );
    const { events, state } = advance(createCombat(s, 1), 8);
    expect(heroActions(events).map(actionName)).toEqual(['item:minor_healing_potion', 'skill:strike']);
    expect(ofType(events, 'ConsumableUsed')).toMatchObject([{ tick: 1, actorId: 'hero:a', item: 'item:minor_healing_potion', remaining: 0 }]);
    // 30% of max HP (260) = 78.
    expect(ofType(events, 'Healed')[0]).toMatchObject({ amount: 78, origin: 'item:minor_healing_potion' });
    expect(state.actors.find((a) => a.id === 'hero:a')?.consumables).toEqual([{ item: 'item:minor_healing_potion', qty: 0 }]);
  });

  it('enemiesAtLeast + skillReady: cleave hits every enemy; a single enemy falls through to strike', () => {
    const r = rules([
      { when: { skillReady: 'skill:cleave', enemiesAtLeast: 2 }, do: { useSkill: 'skill:cleave' } },
      { when: {}, do: { useSkill: 'skill:strike' } },
    ]);
    const two = advance(createCombat(solo({ rules: r }), 1), 8).events;
    const acts = heroActions(two);
    expect(acts.map(actionName)).toEqual(['skill:cleave', 'skill:cleave']); // cooldown 4 < interval 6: ready again at 7
    expect(acts[0]?.targetIds).toEqual(['enemy:1', 'enemy:2']);
    const one = advance(createCombat(solo({ rules: r }, dummies(5000)), 1), 2).events;
    expect(heroActions(one).map(actionName)).toEqual(['skill:strike']);

    function solo(hero: Partial<HeroSetup>, enemies: EnemySetup[] = dummies(5000, 5000)): CombatSetup {
      return { heroes: [bruiser({ skills: ['skill:strike', 'skill:cleave'], ...hero })], enemies, content: CONTENT };
    }
  });

  it('a rule whose skill is on cooldown is skipped even without a skillReady condition', () => {
    const r = rules([
      { when: {}, do: { useSkill: 'skill:guard' } },
      { when: {}, do: { useSkill: 'skill:strike' } },
    ]);
    const { events } = advance(createCombat(solo({ rules: r }, dummies(5000)), 1), 13);
    expect(heroActions(events).map(actionName)).toEqual(['skill:guard', 'skill:strike', 'skill:guard']);
  });

  it('target selectors: lowest/highest HP share, telegraphingEnemy (skipped when nobody telegraphs), mismatches skip', () => {
    const pick = (target: string) =>
      heroActions(
        advance(
          createCombat(
            solo(
              {
                rules: rules([
                  { when: {}, do: { useSkill: 'skill:strike', target } },
                  { when: {}, do: { useSkill: 'skill:strike', target: 'highestHpEnemy' } },
                ]),
              },
              dummies(100, 5000, 2000),
            ),
            1,
          ),
          1,
        ).events,
      )[0]?.targetIds;
    expect(pick('lowestHpEnemy')).toEqual(['enemy:1']);
    expect(pick('highestHpEnemy')).toEqual(['enemy:2']);
    expect(pick('telegraphingEnemy')).toEqual(['enemy:2']); // no telegraph → next rule
    expect(pick('lowestHpAlly')).toEqual(['enemy:2']); // selector does not fit an enemy skill → next rule
  });

  it('enemyTelegraphing + telegraphingEnemy target the winding boss', () => {
    const r = rules([
      { when: { enemyTelegraphing: true }, do: { useSkill: 'skill:strike', target: 'telegraphingEnemy' } },
      { when: {}, do: { useSkill: 'skill:guard' } },
    ]);
    const s: CombatSetup = {
      heroes: [bruiser({ rules: r })],
      enemies: [
        { id: 'enemy:a', enemy: 'enemy:dummy' },
        { id: 'enemy:boss', enemy: 'enemy:golem' },
      ],
      content: CONTENT,
    };
    const { events } = advance(createCombat(s, 1), 30);
    const strikes = heroActions(events).filter((e) => actionName(e) === 'skill:strike');
    expect(strikes.length).toBeGreaterThan(0);
    for (const e of strikes) expect(e.targetIds).toEqual(['enemy:boss']);
  });

  it('live auto, disconnected participants and idle share one evaluator', () => {
    const autoRun = runToEnd(bossSetup(GUARD_RULES), 5);
    const reconnect: CombatPolicy = (state) => (state.tick === 0 ? [{ actorId: 'hero:a', kind: 'setAuto', auto: true }] : []);
    const liveRun = runToEnd({ ...bossSetup(GUARD_RULES), heroes: [bruiser({ rules: GUARD_RULES, auto: false })] }, 5, reconnect);
    const strip = (events: CombatEvent[]) =>
      events.filter((e) => e.type !== 'AutoToggled').map((e) => JSON.stringify({ ...e, seq: 0 }));
    expect(strip(liveRun.events)).toEqual(strip(autoRun.events));
  });
});

describe('enemy AI and boss phases', () => {
  it('AI priority list: the spider opens with venom when below 90% HP, otherwise bites', () => {
    const acts = (hp: number) =>
      ofType(advance(createCombat(solo({ auto: false }, [{ id: 'enemy:s', enemy: 'enemy:spider', hp }]), 1), 1).events, 'ActionStarted')
        .filter((e) => e.actorId === 'enemy:s')
        .map(actionName);
    expect(acts(60)).toEqual(['skill:venom']);
    expect(acts(70)).toEqual(['skill:bite']);
  });

  it('boss: phase-0 rotation, PhaseChanged at the HP threshold, phase-1 rotation with AI fallback while on cooldown', () => {
    const { events } = runToEnd(bossSetup(GUARD_RULES), 1);
    const phase = ofType(events, 'PhaseChanged');
    expect(phase).toMatchObject([{ actorId: 'enemy:boss', phase: 1, fromHpBp: 5000 }]);
    const trigger = events[(phase[0]?.seq ?? 0) - 1];
    expect(trigger).toMatchObject({ type: 'DamageDealt', targetId: 'enemy:boss' });
    expect(trigger?.type === 'DamageDealt' && trigger.hpAfter * 10_000 <= ENEMIES.golem.stats.maxHp * 5000).toBe(true);

    const bossActs = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'enemy:boss');
    const before = bossActs.filter((e) => e.seq < (phase[0]?.seq ?? 0)).map(actionName);
    const rotation0 = ['skill:bite', 'skill:bite', 'skill:heavy_strike'];
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect(before).toEqual(before.map((_, i) => rotation0[i % 3]));

    // Phase 1 rotation is [heavy_strike, bite]; heavy_strike (cooldown 12) never fires twice within 12 ticks and every
    // telegraph comes from the rotation skill.
    const after = bossActs.filter((e) => e.seq > (phase[0]?.seq ?? 0));
    const heavies = after.filter((e) => actionName(e) === 'skill:heavy_strike').map((e) => e.tick);
    expect(heavies.length).toBeGreaterThan(0);
    for (let i = 1; i < heavies.length; i++) expect((heavies[i] ?? 0) - (heavies[i - 1] ?? 0)).toBeGreaterThanOrEqual(12);
    expect(ofType(events, 'TelegraphStarted').every((e) => e.skill === 'skill:heavy_strike')).toBe(true);
  });
});

describe('telegraph balance (Monte Carlo over seeds)', () => {
  const N = 100;
  const tally = (setup: CombatSetup, policy?: CombatPolicy) => {
    let wins = 0;
    let hpLeft = 0;
    for (let seed = 0; seed < N; seed++) {
      const r = runToEnd(setup, seed, policy);
      if (r.outcome === 'victory') wins += 1;
      hpLeft += r.state.actors.find((a) => a.id === 'hero:a')?.hp ?? 0;
    }
    return { wins, hpLeft };
  };

  it('a manual guard response to the telegraphed heavy strike beats naive rules, and timing is what matters', () => {
    const naive = tally(bossSetup(NAIVE_RULES));
    const manual = tally(bossSetup(NAIVE_RULES), manualGuardPolicy);
    // Good automation answers the telegraph too (§7: survivable by good rules in idle).
    const auto = tally(bossSetup(GUARD_RULES));
    // Control: the same guard used whenever it is ready, ignoring telegraphs.
    const spam = tally(
      bossSetup(
        rules([
          { when: { skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
          { when: {}, do: { useSkill: 'skill:strike' } },
        ]),
      ),
    );
    // Integer comparisons on win counts out of N (at rpg-sim@1.0.0: naive 0, spam 78, guard rules 99, manual 99).
    expect(manual.wins).toBeGreaterThanOrEqual(naive.wins + N / 2);
    expect(auto.wins).toBeGreaterThanOrEqual(naive.wins + N / 2);
    expect(manual.wins).toBeGreaterThanOrEqual(spam.wins + N / 10);
    expect(manual.hpLeft).toBeGreaterThan(naive.hpLeft);
  });
});

describe('selfHasHarmfulEffect (cleanse automation)', () => {
  const CLEANSE_RULES = rules([
    { when: { selfHasHarmfulEffect: true, skillReady: 'skill:purify' }, do: { useSkill: 'skill:purify', target: 'self' } },
    { when: {}, do: { useSkill: 'skill:strike' } },
  ]);
  const hero = { skills: ['skill:strike', 'skill:purify'], rules: CLEANSE_RULES };

  it('fires on a DoT: the faster hexer opens with firebolt, the hero cleanses the DoT in the same tick', () => {
    const { events } = advance(createCombat(solo(hero, [{ id: 'enemy:h', enemy: 'enemy:hexer' }]), 1), 1);
    const dot = ofType(events, 'EffectApplied').find((e) => e.effect === 'dot' && e.targetId === 'hero:a');
    expect(dot).toMatchObject({ tick: 1, origin: 'skill:firebolt' });
    expect(heroActions(events).map(actionName)).toEqual(['skill:purify']);
    expect(ofType(events, 'Cleansed')).toMatchObject([{ tick: 1, sourceId: 'hero:a', targetId: 'hero:a', removed: 1 }]);
    expect(ofType(events, 'EffectExpired')).toMatchObject([{ effectUid: dot?.effectUid, reason: 'cleansed' }]);
  });

  it('does not fire without a harmful effect, nor on a taunt (cleanse does not remove taunts)', () => {
    const clean = advance(createCombat(solo(hero, dummies(5000)), 1), 1).events;
    expect(heroActions(clean).map(actionName)).toEqual(['skill:strike']);

    const taunted = advance(createCombat(solo(hero, [{ id: 'enemy:t', enemy: 'enemy:bully' }]), 1), 1).events;
    expect(ofType(taunted, 'EffectApplied').some((e) => e.effect === 'taunt' && e.targetId === 'hero:a')).toBe(true);
    expect(heroActions(taunted).map(actionName)).toEqual(['skill:strike']);
  });

  it('negative stat_mods count; buffs do not', () => {
    const buffed = advance(
      createCombat(solo({ ...hero, skills: [...hero.skills, 'skill:rally'], auto: false }, dummies(5000)), 1),
      2,
      (t) => (t === 1 ? [{ actorId: 'hero:a', kind: 'setAuto', auto: true }, { actorId: 'hero:a', kind: 'useSkill', skill: 'skill:rally' }] : []),
    ).events;
    expect(heroActions(buffed).map(actionName)).not.toContain('skill:purify');

    // The spider below 90% HP opens with venom (dot + armor debuff); its dot is cleansed along with the debuff.
    const { events } = advance(createCombat(solo(hero, [{ id: 'enemy:s', enemy: 'enemy:spider', hp: 60 }]), 1), 1);
    expect(heroActions(events).map(actionName)).toEqual(['skill:purify']);
    expect(ofType(events, 'Cleansed')[0]?.removed).toBe(2);
  });

  it('enemy AI can use it too (shared evaluator)', () => {
    const cleanser = EnemySchema.parse({
      id: 'enemy:cleanser',
      rank: 'normal',
      level: 1,
      stats: { maxHp: 5000, power: 6 },
      skills: ['skill:bite', 'skill:purify'],
      ai: [
        { when: { selfHasHarmfulEffect: true }, do: { useSkill: 'skill:purify', target: 'self' } },
        { when: {}, do: { useSkill: 'skill:bite' } },
      ],
      xp: 0,
    });
    const s: CombatSetup = {
      heroes: [striker({ rules: rules([{ when: {}, do: { useSkill: 'skill:firebolt' } }]) })],
      enemies: [{ id: 'enemy:c', enemy: cleanser.id }],
      content: { ...CONTENT, enemies: { ...CONTENT.enemies, [cleanser.id]: cleanser } },
    };
    const { events } = advance(createCombat(s, 1), 1);
    const enemyActs = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'enemy:c').map(actionName);
    expect(enemyActs).toEqual(['skill:purify']);
    expect(ofType(events, 'Cleansed')).toMatchObject([{ sourceId: 'enemy:c', targetId: 'enemy:c', removed: 1 }]);
  });
});
