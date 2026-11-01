import { mulBp } from '@engine/sim-core';
import { describe, expect, it } from 'vitest';

import { createCombat, runToEnd } from '../index.ts';
import type { CombatEvent, CombatInput, CombatSetup, EnemySetup, HeroSetup } from '../index.ts';
import { CONTENT, advance, bossSetup, bruiser, manualGuardPolicy, ofType, striker } from './testing/fixtures.ts';

const ALL_SKILLS = Object.keys(CONTENT.skills).filter((s) => s !== 'skill:heavy_strike' && s !== 'skill:bite' && s !== 'skill:venom');

/** Manual-mode heroes with every test skill equipped (they idle unless given inputs). */
function setup(enemies: EnemySetup[], heroes: Partial<HeroSetup>[] = [{}]): CombatSetup {
  return {
    heroes: heroes.map((h, i) =>
      (i === 0 ? bruiser : striker)({ auto: false, skills: ALL_SKILLS, ...(i > 1 ? { id: `hero:${i}` } : {}), ...h }),
    ),
    enemies,
    content: CONTENT,
  };
}

const dummy = (enemy = 'enemy:dummy'): EnemySetup[] => [{ id: 'enemy:d', enemy }];
const use = (actorId: string, skill: string, target?: string): CombatInput =>
  target === undefined ? { actorId, kind: 'useSkill', skill } : { actorId, kind: 'useSkill', skill, target };

function run(s: CombatSetup, ticks: number, inputs: Record<number, CombatInput[]>): CombatEvent[] {
  return advance(createCombat(s, 1), ticks, (t) => inputs[t] ?? []).events;
}

function damageOf(events: CombatEvent[], targetId: string, origin?: string) {
  return ofType(events, 'DamageDealt').filter((e) => e.targetId === targetId && (origin === undefined || e.origin === origin));
}

describe('taunt (attacks unit)', () => {
  for (const enemy of ['enemy:dummy', 'enemy:fast_dummy']) {
    it(`a 3-attack taunt expires after exactly 3 eligible attacks (${enemy})`, () => {
      // hero:b has the lowest HP share, so the enemy attacks it unless taunted.
      const s = setup(dummy(enemy), [{}, { hp: 50 }]);
      const events = run(s, 40, { 1: [use('hero:a', 'skill:shield_bash')] });
      const applied = ofType(events, 'EffectApplied').find((e) => e.effect === 'taunt');
      expect(applied).toMatchObject({ sourceId: 'hero:a', targetId: 'enemy:d', duration: { value: 3, unit: 'attacks' } });
      const expired = ofType(events, 'EffectExpired').find((e) => e.effectUid === applied?.effectUid);
      expect(expired?.reason).toBe('duration');
      const attacksAfter = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'enemy:d' && e.seq > (applied?.seq ?? 0));
      expect(attacksAfter.slice(0, 3).map((e) => e.targetIds)).toEqual([['hero:a'], ['hero:a'], ['hero:a']]);
      expect(attacksAfter[3]?.targetIds).toEqual(['hero:b']);
      // Expiry happens during the 3rd attack's tick, before the 4th attack.
      expect(expired?.tick).toBe(attacksAfter[2]?.tick);
      expect((expired?.seq ?? 0) < (attacksAfter[3]?.seq ?? 0)).toBe(true);
    });
  }

  it('expires at different ticks for different attack rates (not a tick duration)', () => {
    const expiryTick = (enemy: string): number => {
      const events = run(setup(dummy(enemy), [{}, { hp: 50 }]), 40, { 1: [use('hero:a', 'skill:shield_bash')] });
      return ofType(events, 'EffectExpired').find((e) => e.effect === 'taunt')?.tick ?? -1;
    };
    expect(expiryTick('enemy:dummy')).toBe(13); // attacks at 1, 7, 13
    expect(expiryTick('enemy:fast_dummy')).toBe(7); // attacks at 3, 5, 7 (taunt applied after its tick-1 attack)
  });

  it('a taunt whose source dies expires with reason sourceDied', () => {
    const s: CombatSetup = { ...setup([{ id: 'enemy:w', enemy: 'enemy:wolf' }], [{ hp: 1 }, {}]) };
    const events = run(s, 10, { 1: [use('hero:a', 'skill:shield_bash')] });
    expect(ofType(events, 'ActorDied')[0]).toMatchObject({ actorId: 'hero:a' });
    expect(ofType(events, 'EffectExpired').find((e) => e.effect === 'taunt')).toMatchObject({ reason: 'sourceDied' });
  });
});

describe('stun', () => {
  it('actions unit: skips exactly N of the holder’s actions', () => {
    const events = run(setup(dummy()), 20, { 1: [use('hero:a', 'skill:concuss')] });
    expect(ofType(events, 'ActionSkipped').map((e) => e.tick)).toEqual([1, 7]);
    expect(ofType(events, 'EffectExpired').find((e) => e.effect === 'stun')).toMatchObject({ tick: 7, reason: 'duration' });
    expect(ofType(events, 'ActionStarted').filter((e) => e.actorId === 'enemy:d')[0]?.tick).toBe(13);
  });

  it('ticks unit: active for ticks t+1…t+N; a readiness inside the window costs a full interval', () => {
    // Applied at tick 1 by the bruiser (who acts before the dummy): the dummy's tick-1 action is skipped.
    const events = run(setup(dummy()), 10, { 1: [use('hero:a', 'skill:daze')] });
    expect(ofType(events, 'EffectExpired').find((e) => e.effect === 'stun')?.tick).toBe(4);
    expect(ofType(events, 'ActionSkipped').map((e) => e.tick)).toEqual([1]);
    expect(ofType(events, 'ActionStarted').filter((e) => e.actorId === 'enemy:d').map((e) => e.tick)).toEqual([7]);
  });
});

describe('stat_mod', () => {
  it('actions unit debuff: halves enemy power for its next 2 actions, then reverts', () => {
    const events = run(setup(dummy()), 20, { 1: [use('hero:a', 'skill:hex')] });
    // Dummy power 6 vs bruiser armor 20: ⌊6 × 10000 / 12000⌋ = 5; hexed power 3 → 2.
    expect(damageOf(events, 'hero:a').map((e) => e.amount)).toEqual([2, 2, 5, 5]);
    expect(ofType(events, 'EffectExpired').find((e) => e.effect === 'stat_mod')).toMatchObject({ tick: 7, reason: 'duration' });
  });

  it('attribute buffs on heroes flow through deriveStats (STR → physical power)', () => {
    const state = createCombat(setup(dummy()), 1);
    const base = state.actors.find((a) => a.id === 'hero:a')?.stats.powerBySchool.physical ?? 0;
    const strike = { 7: [use('hero:a', 'skill:strike')], 13: [use('hero:a', 'skill:strike')], 19: [use('hero:a', 'skill:strike')] };
    const events = run(setup(dummy()), 20, { 1: [use('hero:a', 'skill:rally')], ...strike });
    const hits = damageOf(events, 'enemy:d', 'skill:strike');
    const buffed = base + mulBp(20, 15_000); // +20 STR × 1.5
    const expected = [buffed, buffed, base].map((v, i) => (hits[i]?.crit ? mulBp(v, 15_000) : v));
    expect(hits.map((e) => e.amount)).toEqual(expected);
  });

  it('same source + origin + stat replaces; the old instance expires with reason replaced', () => {
    const events = run(setup(dummy()), 8, { 1: [use('hero:a', 'skill:hex')], 7: [use('hero:a', 'skill:hex')] });
    expect(ofType(events, 'EffectExpired').map((e) => e.reason)).toContain('replaced');
  });
});

describe('periodic effects', () => {
  it('dot: applies every periodTicks for its tick duration', () => {
    const events = run(setup(dummy(), [{}, {}]), 12, { 1: [use('hero:b', 'skill:firebolt')] });
    const state = createCombat(setup(dummy(), [{}, {}]), 1);
    const magic = state.actors.find((a) => a.id === 'hero:b')?.stats.powerBySchool.magic ?? 0;
    const periodic = damageOf(events, 'enemy:d').filter((e) => e.periodic);
    expect(periodic.map((e) => e.tick)).toEqual([3, 5, 7]);
    expect(periodic.every((e) => e.amount === Math.max(1, mulBp(magic, 2000)) && !e.crit)).toBe(true);
    expect(ofType(events, 'EffectExpired').find((e) => e.effect === 'dot')?.tick).toBe(7);
  });

  it('dots from different sources stack', () => {
    const events = run(setup(dummy(), [{}, {}, {}]), 2, {
      1: [use('hero:b', 'skill:firebolt'), use('hero:2', 'skill:firebolt')],
    });
    expect(ofType(events, 'EffectApplied').filter((e) => e.effect === 'dot')).toHaveLength(2);
    expect(ofType(events, 'EffectExpired')).toHaveLength(0);
  });

  it('hot: heals every tick for 4 ticks', () => {
    const events = run(setup(dummy(), [{ hp: 100 }]), 8, { 1: [use('hero:a', 'skill:regrowth', 'self')] });
    const healPower = createCombat(setup(dummy()), 1).actors.find((a) => a.id === 'hero:a')?.stats.healPower ?? 0;
    const heals = ofType(events, 'Healed').filter((e) => e.periodic);
    expect(heals.map((e) => e.tick)).toEqual([2, 3, 4, 5]);
    expect(heals.every((e) => e.amount === mulBp(healPower, 5000))).toBe(true);
  });
});

describe('heal, shield, cleanse', () => {
  it('heal restores healPower × coeff, capped at max HP', () => {
    const events = run(setup(dummy(), [{ hp: 100 }, {}]), 1, { 1: [use('hero:b', 'skill:mend', 'hero:a')] });
    const healPower = createCombat(setup(dummy(), [{}, {}]), 1).actors.find((a) => a.id === 'hero:b')?.stats.healPower ?? 0;
    expect(ofType(events, 'Healed')[0]).toMatchObject({ targetId: 'hero:a', amount: mulBp(healPower, 20_000), periodic: false });
    const full = run(setup(dummy(), [{}, {}]), 1, { 1: [use('hero:b', 'skill:mend', 'hero:a')] });
    expect(ofType(full, 'Healed')[0]?.amount).toBe(0);
  });

  it('shields absorb before HP and a 1-attack shield is consumed by the next received attack', () => {
    const events = run(setup(dummy()), 8, { 1: [use('hero:a', 'skill:guard')] });
    const first = damageOf(events, 'hero:a')[0];
    expect(first).toMatchObject({ tick: 1, amount: 0 });
    expect(first?.absorbed).toBeGreaterThan(0);
    const shield = ofType(events, 'EffectApplied').find((e) => e.effect === 'shield');
    expect(ofType(events, 'EffectExpired').find((e) => e.effectUid === shield?.effectUid)).toMatchObject({ tick: 1, reason: 'duration' });
    expect(damageOf(events, 'hero:a')[1]?.absorbed).toBe(0);
  });

  it('a big hit depletes the shield (reason depleted) and the rest goes to HP', () => {
    const { events } = runToEnd(bossSetup(), 3, manualGuardPolicy);
    const hit = damageOf(events, 'hero:a', 'skill:heavy_strike').find((e) => e.absorbed > 0);
    expect(hit?.amount).toBeGreaterThan(0);
    const next = events[(hit?.seq ?? 0) + 1];
    expect(next).toMatchObject({ type: 'EffectExpired', effect: 'shield', reason: 'depleted' });
  });

  it('cleanse removes dots, stuns and negative stat mods but keeps buffs', () => {
    // The spider (hp below 90%) opens with venom (dot + armor debuff) on the highest-HP hero (tie → hero:a).
    const s = setup([{ id: 'enemy:s', enemy: 'enemy:spider', hp: 60 }], [{}, {}]);
    const events = run(s, 2, { 1: [use('hero:a', 'skill:guard')], 2: [use('hero:b', 'skill:purify', 'hero:a')] });
    const venom = ofType(events, 'EffectApplied').filter((e) => e.origin === 'skill:venom').map((e) => e.effectUid);
    expect(venom).toHaveLength(2);
    expect(ofType(events, 'Cleansed')).toMatchObject([{ tick: 2, sourceId: 'hero:b', targetId: 'hero:a', removed: 2 }]);
    const cleansed = ofType(events, 'EffectExpired').filter((e) => e.reason === 'cleansed').map((e) => e.effectUid);
    expect(cleansed.sort()).toEqual(venom.sort());
    const guardUids = ofType(events, 'EffectApplied').filter((e) => e.origin === 'skill:guard').map((e) => e.effectUid);
    expect(ofType(events, 'EffectExpired').some((e) => guardUids.includes(e.effectUid) && e.reason === 'cleansed')).toBe(false);
  });
});
