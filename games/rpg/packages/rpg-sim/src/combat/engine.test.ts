import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, createCombat, hashEvents, isFinished, runToEnd, step } from '../index.ts';
import type { CombatEvent, CombatInput, CombatState } from '../index.ts';
import {
  CONTENT,
  SKILLS,
  advance,
  bossSetup,
  bruiser,
  manualGuardPolicy,
  STRIKER_L5,
  ofType,
  partySetup,
  stalemateSetup,
  striker,
} from './testing/fixtures.ts';

const dummySetup = (heroOverrides = {}) => ({
  heroes: [bruiser(heroOverrides)],
  enemies: [{ id: 'enemy:d', enemy: 'enemy:dummy' }],
  content: CONTENT,
});

describe('createCombat', () => {
  it('builds a JSON-serializable state with actors sorted by id and derived stats', () => {
    const state = createCombat(partySetup(), 1);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.engineVersion).toBe(ENGINE_VERSION);
    expect(state.actors.map((a) => a.id)).toEqual(['enemy:1', 'enemy:2', 'hero:a', 'hero:b']);
    const hero = state.actors.find((a) => a.id === 'hero:a');
    // BRUISER L5: 50 + 4×10 + 8×20 VIT + 10 gear.
    expect(hero?.stats.maxHp).toBe(260);
    expect(hero?.hp).toBe(260);
    expect(Object.keys(state.content.skills)).toContain('skill:shield_bash');
    expect(Object.keys(state.content.items)).toEqual(['item:minor_healing_potion']);
  });

  it('rejects invalid setups (server data, so it throws)', () => {
    expect(() => createCombat({ ...partySetup(), enemies: [] }, 1)).toThrow();
    expect(() => createCombat({ ...dummySetup(), enemies: [{ id: 'hero:a', enemy: 'enemy:dummy' }] }, 1)).toThrow(/duplicate/);
    expect(() => createCombat({ ...dummySetup(), enemies: [{ id: 'e', enemy: 'enemy:nope' }] }, 1)).toThrow(/unknown enemy/);
    expect(() => createCombat(dummySetup({ skills: ['skill:nope'] }), 1)).toThrow(/unknown skill/);
    expect(() => createCombat(dummySetup(), -1)).toThrow();
  });

  it('honours starting hp (carried between encounters)', () => {
    const state = createCombat(dummySetup({ hp: 40 }), 1);
    expect(state.actors.find((a) => a.id === 'hero:a')?.hp).toBe(40);
  });
});

describe('step', () => {
  it('is pure at the boundary and emits CombatStarted on the first tick', () => {
    const s0 = createCombat(partySetup(), 3);
    const snapshot = JSON.stringify(s0);
    const { state, events } = step(s0, []);
    expect(JSON.stringify(s0)).toBe(snapshot);
    expect(state.tick).toBe(1);
    expect(events[0]).toMatchObject({ seq: 0, tick: 1, type: 'CombatStarted', engineVersion: ENGINE_VERSION });
  });

  it('orders ready actors by initiative (haste) desc, then actor id asc', () => {
    const setup = {
      ...partySetup(),
      enemies: [
        { id: 'enemy:2', enemy: 'enemy:wolf' },
        { id: 'enemy:1', enemy: 'enemy:wolf' },
      ],
    };
    const { events } = step(createCombat(setup, 1), []);
    // striker haste 12 > bruiser haste 1 > wolves haste 0 (tie → id asc).
    expect(ofType(events, 'ActionStarted').map((e) => e.actorId)).toEqual(['hero:b', 'hero:a', 'enemy:1', 'enemy:2']);
  });

  it('applies action intervals from haste and skill cooldowns', () => {
    const setup = { ...partySetup(), enemies: [{ id: 'enemy:d', enemy: 'enemy:dummy' }] };
    const { events } = advance(createCombat(setup, 1), 20);
    const heroA = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:a');
    // Bruiser interval 6: acts at 1, 7, 13, 19; shield_bash (cooldown 8) at 1 and 13 (ready at 9, next action 13).
    expect(heroA.map((e) => e.tick)).toEqual([1, 7, 13, 19]);
    expect(heroA.map((e) => (e.action.kind === 'skill' ? e.action.skill : ''))).toEqual([
      'skill:shield_bash',
      'skill:strike',
      'skill:shield_bash',
      'skill:strike',
    ]);
    const heroB = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:b');
    // Faster striker (haste 30 via the stats table): its second action comes one derived interval later.
    const fast = { ...setup, heroes: [bruiser(), striker({ build: { ...STRIKER_L5, equipment: [{ stats: { haste: 30 } }] } })] };
    const interval = createCombat(fast, 1).actors.find((a) => a.id === 'hero:b')?.stats.actionIntervalTicks ?? 0;
    expect(interval).toBe(5); // haste ⌊12 AGI × 0.5⌋ + 30 = 36 → ⌈6 × 10000 / 13600⌉ = 5
    const fastB = ofType(advance(createCombat(fast, 1), 12).events, 'ActionStarted').filter((e) => e.actorId === 'hero:b');
    expect(fastB.map((e) => e.tick).slice(0, 3)).toEqual([1, 1 + interval, 1 + 2 * interval]);
    expect(heroB.map((e) => e.tick).slice(0, 2)).toEqual([1, 7]);
  });

  it('queued manual inputs resolve at the next ready action', () => {
    // Auto on: hero acts at tick 1, next ready at 7. A guard queued at tick 3 resolves at tick 7.
    const s = createCombat(dummySetup(), 1);
    const { events } = advance(s, 7, (t) => (t === 3 ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:guard' }] : []));
    const heroActions = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:a');
    expect(heroActions.map((e) => [e.tick, e.source])).toEqual([
      [1, 'auto'],
      [7, 'manual'],
    ]);
  });

  it('a manual-mode hero waits until an input arrives, then acts in that tick', () => {
    const s = createCombat(dummySetup({ auto: false }), 1);
    const { events } = advance(s, 5, (t) => (t === 4 ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:strike' }] : []));
    const heroActions = ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:a');
    expect(heroActions.map((e) => [e.tick, e.source])).toEqual([[4, 'manual']]);
  });

  it('setAuto toggles automation (disconnected participants keep fighting on rules)', () => {
    const s = createCombat(dummySetup({ auto: false }), 1);
    const { events } = advance(s, 2, (t) => (t === 2 ? [{ actorId: 'hero:a', kind: 'setAuto', auto: true }] : []));
    expect(ofType(events, 'AutoToggled')).toMatchObject([{ tick: 2, actorId: 'hero:a', auto: true }]);
    expect(ofType(events, 'ActionStarted').filter((e) => e.actorId === 'hero:a')).toMatchObject([{ tick: 2, source: 'auto' }]);
  });

  it('rejects invalid inputs with InputRejected and never throws', () => {
    const s = createCombat({ ...partySetup() }, 1);
    const bad: unknown[] = [
      null,
      42,
      { kind: 'useSkill' },
      { actorId: 'hero:zz', kind: 'useSkill', skill: 'skill:strike' },
      { actorId: 'enemy:1', kind: 'useSkill', skill: 'skill:bite' },
      { actorId: 'hero:a', kind: 'dance' },
      { actorId: 'hero:a', kind: 'useSkill', skill: 'skill:firebolt' },
      { actorId: 'hero:a', kind: 'useSkill', skill: 'skill:strike', target: 'nobody' },
      { actorId: 'hero:a', kind: 'useConsumable', item: 'item:elixir' },
      { actorId: 'hero:a', kind: 'setAuto', auto: 'yes' },
    ];
    const { events } = step(s, bad as CombatInput[]);
    expect(ofType(events, 'InputRejected').map((e) => e.reason)).toEqual([
      'malformed',
      'malformed',
      'malformed',
      'unknownActor',
      'notControllable',
      'unknownKind',
      'skillNotEquipped',
      'invalidTarget',
      'noConsumable',
      'malformed',
    ]);
  });

  it('rejects a queued skill that is still on cooldown when the actor becomes ready', () => {
    const s = createCombat(dummySetup({ auto: false }), 1);
    const { events } = advance(s, 8, (t) =>
      t === 1 || t === 7 ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:guard' }] : [],
    );
    expect(ofType(events, 'InputRejected')).toMatchObject([{ tick: 7, reason: 'onCooldown' }]);
  });

  it('accepts an explicit target actor id', () => {
    const s = createCombat(partySetup(), 1);
    const { events } = step(s, [{ actorId: 'hero:b', kind: 'useSkill', skill: 'skill:firebolt', target: 'enemy:2' }]);
    expect(ofType(events, 'ActionStarted').find((e) => e.actorId === 'hero:b')).toMatchObject({ targetIds: ['enemy:2'], source: 'manual' });
  });
});

describe('telegraphs and windups', () => {
  it('a windup emits TelegraphStarted and resolves exactly windupTicks later', () => {
    const { events } = runToEnd(bossSetup(), 1);
    const telegraph = ofType(events, 'TelegraphStarted')[0];
    expect(telegraph).toMatchObject({ actorId: 'enemy:boss', skill: 'skill:heavy_strike', resolveAtTick: (telegraph?.tick ?? 0) + SKILLS.heavyStrike.windupTicks });
    const hit = ofType(events, 'DamageDealt').find((e) => e.origin === 'skill:heavy_strike');
    expect(hit?.tick).toBe(telegraph?.resolveAtTick);
  });

  it('a stun interrupts a windup (cooldown stays spent)', () => {
    const setup = { ...bossSetup(), heroes: [bruiser({ auto: false, skills: ['skill:strike', 'skill:daze'] })] };
    let s = createCombat(setup, 1);
    let all: CombatEvent[] = [];
    // The manual-mode hero idles (stays ready) until the boss telegraphs, then dazes it in the next tick.
    for (let i = 0; i < 40 && s.outcome === null; i++) {
      const winding = s.actors.some((a) => a.id === 'enemy:boss' && a.windup !== null);
      const r = step(s, winding ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:daze' }] : []);
      s = r.state;
      all = all.concat(r.events);
      if (ofType(r.events, 'ActionInterrupted').length > 0) break;
    }
    const interrupted = ofType(all, 'ActionInterrupted');
    expect(interrupted).toMatchObject([{ actorId: 'enemy:boss', skill: 'skill:heavy_strike', reason: 'stunned' }]);
    expect(ofType(all, 'DamageDealt').some((e) => e.origin === 'skill:heavy_strike')).toBe(false);
    expect(s.actors.find((a) => a.id === 'enemy:boss')?.windup).toBeNull();
  });
});

describe('determinism and checkpoints', () => {
  it('same (setup, seed, inputs) ⇒ identical event hash; different seeds diverge', () => {
    const a = runToEnd(bossSetup(), 99, manualGuardPolicy);
    const b = runToEnd(bossSetup(), 99, manualGuardPolicy);
    expect(hashEvents(a.events)).toBe(hashEvents(b.events));
    expect(a.events).toEqual(b.events);
    const hashes = new Set([1, 2, 3, 4, 5].map((seed) => hashEvents(runToEnd(partySetup(), seed).events)));
    expect(hashes.size).toBeGreaterThan(1);
  });

  it('runToEnd and repeated step() produce the same events', () => {
    const run = runToEnd(partySetup(), 5);
    const stepped = advance(createCombat(partySetup(), 5), 10_000);
    expect(stepped.events).toEqual(run.events);
    expect(stepped.state).toEqual(run.state);
  });

  it('a JSON round-trip of the state mid-combat continues identically', () => {
    const inputsAt = (t: number): CombatInput[] => (t % 9 === 0 ? [{ actorId: 'hero:a', kind: 'useSkill', skill: 'skill:guard' }] : []);
    const mid = advance(createCombat(bossSetup(), 77), 25, inputsAt);
    const restored = JSON.parse(JSON.stringify(mid.state)) as CombatState;
    const a = advance(mid.state, 10_000, inputsAt);
    const b = advance(restored, 10_000, inputsAt);
    expect(b.events).toEqual(a.events);
    expect(hashEvents(b.events)).toBe(hashEvents(a.events));
    expect(a.state.outcome).not.toBeNull();
  });
});

describe('properties', () => {
  const scenarios = [
    { name: 'party', setup: partySetup, policy: undefined },
    { name: 'boss naive', setup: bossSetup, policy: undefined },
    { name: 'boss manual', setup: bossSetup, policy: manualGuardPolicy },
  ];

  for (const { name, setup, policy } of scenarios) {
    it(`${name}: HP never negative, events append-only, finished stays finished`, () => {
      for (let seed = 0; seed < 30; seed++) {
        let s = createCombat(setup(), seed);
        let expectedSeq = 0;
        let lastTick = 0;
        while (s.outcome === null && s.tick < 2000) {
          const r = step(s, policy ? policy(s) : []);
          for (const e of r.events) {
            expect(e.seq).toBe(expectedSeq++);
            expect(e.tick).toBeGreaterThanOrEqual(lastTick);
            lastTick = e.tick;
            if (e.type === 'DamageDealt' || e.type === 'Healed') expect(e.hpAfter).toBeGreaterThanOrEqual(0);
          }
          for (const a of r.state.actors) {
            expect(a.hp).toBeGreaterThanOrEqual(0);
            expect(a.hp).toBeLessThanOrEqual(a.stats.maxHp);
            expect(a.alive).toBe(a.hp > 0);
          }
          s = r.state;
        }
        const outcome = isFinished(s);
        expect(outcome).not.toBeNull();
        const after = step(s, [{ actorId: 'hero:a', kind: 'setAuto', auto: false }]);
        expect(after.events).toEqual([]);
        expect(after.state).toEqual(s);
        expect(isFinished(after.state)).toBe(outcome);
      }
    });
  }

  it('the party beats the wolf and the spider', () => {
    const results = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => runToEnd(partySetup(), seed));
    for (const r of results) {
      expect(r.outcome).toBe('victory');
      expect(ofType(r.events, 'CombatEnded')).toMatchObject([{ outcome: 'victory' }]);
      expect(r.events.at(-1)?.type).toBe('CombatEnded');
    }
  });

  it('runToEnd stops at maxTicks with a timeout', () => {
    const r = runToEnd(stalemateSetup(), 1, undefined, 500);
    expect(r.outcome).toBe('timeout');
    expect(r.ticks).toBe(500);
    expect(r.state.outcome).toBeNull();
  });

  it('a party of N heroes vs M enemies is supported', () => {
    const r = runToEnd(
      {
        heroes: [bruiser(), striker(), striker({ id: 'hero:c' })],
        enemies: [1, 2, 3, 4].map((i) => ({ id: `enemy:${i}`, enemy: 'enemy:wolf' })),
        content: CONTENT,
      },
      11,
    );
    expect(r.outcome).toBe('victory');
    expect(ofType(r.events, 'ActorDied').filter((e) => e.actorId.startsWith('enemy:'))).toHaveLength(4);
  });
});
