import { describe, expect, it } from 'vitest';

import type { DerivedStats, StatFormulaTable } from './index.ts';
import {
  DEFAULT_STAT_FORMULAS,
  RPG_STATS_PACKAGE,
  STAT_DELTA_KEYS,
  actionIntervalTicks,
  changedStats,
  deriveStats,
  flattenStats,
  statDelta,
  validateStatFormulaTable,
} from './index.ts';
import { divCeil, divFloor, mulBp, mulDivFloor } from './int-math.ts';
import type { ReferenceBuild } from './testing/builds.ts';
import { BRUISER, STRIKER, attributesAt } from './testing/builds.ts';

const T = DEFAULT_STAT_FORMULAS;
const derive = (build: ReferenceBuild, level: number, extra: Partial<Parameters<typeof deriveStats>[0]> = {}) =>
  deriveStats({ level, attributes: attributesAt(build, level), equipment: build.gear, ...extra }, T);

describe('@rpg/rpg-stats', () => {
  it('exports its package name', () => {
    expect(RPG_STATS_PACKAGE).toBe('@rpg/rpg-stats');
  });
});

describe('reference builds (DEFAULT_STAT_FORMULAS)', () => {
  // Hand-computed from the formulas in formulas.ts; see README "Formulas".
  type Row = [
    build: ReferenceBuild,
    level: number,
    attrs: [STR: number, AGI: number, INT: number, VIT: number, SPI: number],
    maxHp: number,
    physical: number,
    magic: number,
    power: number,
    armor: number,
    resist: number,
    critBp: number,
    haste: number,
    interval: number,
    healPower: number,
  ];
  const rows: Row[] = [
    [BRUISER, 1, [8, 3, 1, 12, 3], 156, 16, 5, 16, 16, 1, 560, 1, 6, 4],
    [BRUISER, 5, [12, 3, 1, 20, 3], 260, 26, 9, 26, 20, 1, 560, 1, 6, 8],
    [BRUISER, 10, [17, 3, 1, 30, 3], 390, 38, 14, 38, 25, 1, 560, 1, 6, 13],
    [STRIKER, 1, [2, 9, 9, 4, 7], 82, 6, 16, 16, 2, 3, 780, 10, 6, 14],
    [STRIKER, 5, [2, 13, 13, 4, 11], 122, 10, 26, 26, 2, 5, 860, 12, 6, 24],
    [STRIKER, 10, [2, 18, 18, 4, 16], 172, 15, 39, 39, 2, 8, 960, 15, 6, 37],
  ];

  it.each(rows)(
    '%#: level %i',
    (build, level, [STR, AGI, INT, VIT, SPI], maxHp, physical, magic, power, armor, resist, critBp, haste, interval, healPower) => {
      expect(derive(build, level)).toEqual<DerivedStats>({
        level,
        attributes: { STR, AGI, INT, VIT, SPI },
        maxHp,
        powerBySchool: { physical, magic },
        power,
        armor,
        resist,
        critBp,
        haste,
        actionIntervalTicks: interval,
        healPower,
      });
    },
  );

  it('the bruiser is tankier and the striker hits/heals harder at every level', () => {
    for (const level of [1, 5, 10]) {
      const b = derive(BRUISER, level);
      const s = derive(STRIKER, level);
      expect(b.maxHp).toBeGreaterThan(s.maxHp);
      expect(b.armor).toBeGreaterThan(s.armor);
      expect(s.powerBySchool.magic).toBeGreaterThan(b.powerBySchool.magic);
      expect(s.healPower).toBeGreaterThan(b.healPower);
      expect(s.critBp).toBeGreaterThan(b.critBp);
    }
  });
});

describe('equipment stacking', () => {
  const naked = { level: 1, attributes: BRUISER.base, equipment: [] };

  it('sums the same stat across pieces', () => {
    const one = deriveStats({ ...naked, equipment: [{ stats: { armor: 3 } }] }, T);
    const two = deriveStats({ ...naked, equipment: [{ stats: { armor: 3 } }, { stats: { armor: 4 } }] }, T);
    expect(two.armor - one.armor).toBe(4);
  });

  it('gear attributes feed the formulas (scaled), gear power applies to both schools', () => {
    const base = deriveStats(naked, T);
    const geared = deriveStats({ ...naked, equipment: [{ stats: { STR: 2, power: 1 } }] }, T);
    expect(geared.attributes.STR).toBe(10);
    expect(geared.powerBySchool.physical - base.powerBySchool.physical).toBe(3 + 1); // ⌊10×1.5⌋ − ⌊8×1.5⌋ + 1
    expect(geared.powerBySchool.magic - base.powerBySchool.magic).toBe(1);
  });

  it('is independent of equipment order', () => {
    const reversed = [...STRIKER.gear].reverse();
    expect(derive(STRIKER, 5, { equipment: reversed })).toEqual(derive(STRIKER, 5));
  });
});

describe('modifiers', () => {
  it('applies flat then percent to derived stats, power modifiers to every school', () => {
    const s = derive(BRUISER, 1, { modifiers: [{ stat: 'power', deltaBp: 5_000 }] });
    expect(s.powerBySchool).toEqual({ physical: 24, magic: 7 }); // 16×1.5, ⌊5×1.5⌋
    expect(s.power).toBe(24);
    const f = derive(BRUISER, 1, { modifiers: [{ stat: 'armor', flat: 4 }, { stat: 'armor', deltaBp: -5_000 }] });
    expect(f.armor).toBe(10); // (16 + 4) × 0.5
  });

  it('applies attribute modifiers before derivation', () => {
    const s = derive(BRUISER, 1, { modifiers: [{ stat: 'VIT', flat: 3 }] });
    expect(s.attributes.VIT).toBe(15);
    expect(s.maxHp).toBe(156 + 3 * T.maxHp.perVit);
  });

  it('is independent of modifier order', () => {
    const mods = [
      { stat: 'haste', flat: 30 },
      { stat: 'haste', deltaBp: 2_500 },
      { stat: 'AGI', deltaBp: -1_000 },
    ] as const;
    expect(derive(STRIKER, 5, { modifiers: [...mods].reverse() })).toEqual(derive(STRIKER, 5, { modifiers: mods }));
  });
});

describe('floors and clamps', () => {
  const zero = { STR: 0, AGI: 0, INT: 0, VIT: 0, SPI: 0 };

  it('derives the table base for an empty level-1 character', () => {
    expect(deriveStats({ level: 1, attributes: zero, equipment: [] }, T)).toMatchObject({
      maxHp: T.maxHp.base,
      power: 0,
      armor: 0,
      resist: 0,
      critBp: T.crit.baseBp,
      haste: 0,
      actionIntervalTicks: T.haste.baseActionIntervalTicks,
      healPower: 0,
    });
  });

  it('keeps maxHp >= 1 and other stats >= 0 under negative gear / debuffs', () => {
    const s = deriveStats(
      {
        level: 1,
        attributes: zero,
        equipment: [{ stats: { maxHp: -1_000, armor: -5, power: -3, STR: -4 } }],
        modifiers: [{ stat: 'resist', deltaBp: -20_000 }, { stat: 'critBp', flat: -9_999 }],
      },
      T,
    );
    expect(s).toMatchObject({ maxHp: 1, armor: 0, power: 0, resist: 0, critBp: 0 });
    expect(s.attributes.STR).toBe(0);
  });

  it('caps critBp', () => {
    expect(derive(STRIKER, 10, { equipment: [{ stats: { critBp: 20_000 } }] }).critBp).toBe(T.crit.capBp);
  });

  it.each([
    [0, 6],
    [19, 6],
    [20, 5],
    [49, 5],
    [50, 4],
    [99, 4],
    [100, 3],
    [199, 3],
    [200, 2],
    [1_000_000, 2],
  ])('haste %i → %i ticks (rounded up, floor 2)', (haste, ticks) => {
    expect(actionIntervalTicks(haste, T)).toBe(ticks);
  });

  it('never goes below 2 ticks even with absurd haste gear', () => {
    expect(derive(STRIKER, 10, { equipment: [{ stats: { haste: 1_000_000_000 } }] }).actionIntervalTicks).toBe(2);
  });

  it('rejects invalid tables and inputs', () => {
    const bad = (patch: (t: StatFormulaTable) => StatFormulaTable) => () => validateStatFormulaTable(patch(T));
    expect(bad((t) => ({ ...t, haste: { ...t.haste, minActionIntervalTicks: 1 } }))).toThrow(/minActionIntervalTicks/);
    expect(bad((t) => ({ ...t, crit: { ...t.crit, capBp: 10_001 } }))).toThrow(/capBp/);
    expect(bad((t) => ({ ...t, armor: { perVitBp: 0.5 } }))).toThrow(/armor\.perVitBp/);
    expect(bad((t) => ({ ...t, maxHp: { ...t.maxHp, perVit: -1 } }))).toThrow(/maxHp\.perVit/);
    expect(() => validateStatFormulaTable(T)).not.toThrow();
    expect(() => deriveStats({ level: 0, attributes: zero, equipment: [] }, T)).toThrow(/level/);
    expect(() => deriveStats({ level: 1, attributes: { ...zero, STR: 1.5 }, equipment: [] }, T)).toThrow(/STR/);
    expect(() => deriveStats({ level: 1, attributes: zero, equipment: [{ stats: { armor: 0.1 } }] }, T)).toThrow(
      /equipment\[0\]\.stats\.armor/,
    );
  });

  it('DEFAULT_STAT_FORMULAS is frozen', () => {
    expect(Object.isFrozen(T)).toBe(true);
    expect(Object.isFrozen(T.haste)).toBe(true);
  });
});

describe('statDelta', () => {
  it('is zero for identical stats', () => {
    const s = derive(BRUISER, 5);
    expect(changedStats(statDelta(s, s))).toEqual([]);
  });

  it('previews swapping the weapon (compare-vs-equipped)', () => {
    const level = 5;
    const equipped = derive(STRIKER, level);
    const [, ...rest] = STRIKER.gear;
    const candidate = { stats: { power: 7, INT: 2, haste: -2 } };
    const preview = derive(STRIKER, level, { equipment: [candidate, ...rest] });
    const delta = statDelta(equipped, preview);
    expect(delta).toMatchObject({
      INT: 2,
      magicPower: 3 + 4, // ⌊15×1.5⌋ − ⌊13×1.5⌋ + (7 − 3)
      physicalPower: 4,
      power: 7,
      critBp: -100, // staff crit lost
      haste: -2,
      actionIntervalTicks: 0,
    });
    expect(changedStats(delta)).toEqual(['INT', 'power', 'physicalPower', 'magicPower', 'critBp', 'haste']);
    for (const key of STAT_DELTA_KEYS) {
      expect(flattenStats(equipped)[key] + delta[key]).toBe(flattenStats(preview)[key]);
    }
  });

  it('is antisymmetric', () => {
    const a = derive(BRUISER, 10);
    const b = derive(STRIKER, 10);
    const ab = statDelta(a, b);
    const ba = statDelta(b, a);
    for (const key of STAT_DELTA_KEYS) expect(ab[key] + ba[key]).toBe(0);
  });
});

describe('integer-only outputs (property-style)', () => {
  // Deterministic LCG; no Math.random.
  let seed = 0x2545f491;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed % n;
  };
  const signed = (n: number) => next(2 * n + 1) - n;

  it('every derived number is a safe integer and within its bounds', () => {
    const stats = ['STR', 'AGI', 'INT', 'VIT', 'SPI', 'maxHp', 'power', 'armor', 'resist', 'critBp', 'haste', 'healPower'] as const;
    for (let i = 0; i < 500; i++) {
      const pick = () => stats[next(stats.length)] ?? 'power';
      const input = {
        level: 1 + next(60),
        attributes: { STR: next(200), AGI: next(200), INT: next(200), VIT: next(200), SPI: next(200) },
        equipment: Array.from({ length: next(9) }, () => ({ stats: { [pick()]: signed(50), [pick()]: signed(500) } })),
        modifiers: Array.from({ length: next(4) }, () =>
          next(2) === 0 ? { stat: pick(), flat: signed(40) } : { stat: pick(), deltaBp: signed(15_000) },
        ),
      };
      const s = deriveStats(input, T);
      const flat = flattenStats(s);
      for (const key of STAT_DELTA_KEYS) expect(Number.isSafeInteger(flat[key]), key).toBe(true);
      for (const key of STAT_DELTA_KEYS) if (key !== 'maxHp') expect(flat[key], key).toBeGreaterThanOrEqual(0);
      expect(s.maxHp).toBeGreaterThanOrEqual(1);
      expect(s.critBp).toBeLessThanOrEqual(T.crit.capBp);
      expect(s.actionIntervalTicks).toBeGreaterThanOrEqual(2);
      expect(s.actionIntervalTicks).toBeLessThanOrEqual(T.haste.baseActionIntervalTicks);
      expect(s.power).toBe(Math.max(s.powerBySchool.physical, s.powerBySchool.magic));
      expect(deriveStats(input, T)).toEqual(s); // deterministic
    }
  });
});

describe('int-math (mirrors @engine/sim-core semantics)', () => {
  it('rounds explicitly', () => {
    expect(divFloor(-7, 2)).toBe(-4);
    expect(divFloor(7, 2)).toBe(3);
    expect(divCeil(7, 2)).toBe(4);
    expect(divCeil(-7, 2)).toBe(-3);
    expect(Object.is(divCeil(-1, 2), 0)).toBe(true);
    expect(mulBp(-15, 5_000)).toBe(-8);
    expect(mulDivFloor(Number.MAX_SAFE_INTEGER, 3, 4)).toBe(6_755_399_441_055_743);
    expect(() => divFloor(1, 0)).toThrow(/zero/);
    expect(() => mulBp(1.5, 1)).toThrow(/safe integer/);
  });
});
