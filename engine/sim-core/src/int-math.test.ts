import { describe, expect, it } from 'vitest';

import { BP_SCALE, assertInt, clampInt, divFloor, mulBp, mulDivFloor } from './index.ts';

describe('divFloor', () => {
  it('floors toward negative infinity', () => {
    expect(divFloor(7, 2)).toBe(3);
    expect(divFloor(-7, 2)).toBe(-4);
    expect(divFloor(7, -2)).toBe(-4);
    expect(divFloor(-7, -2)).toBe(3);
    expect(divFloor(-8, 2)).toBe(-4);
    expect(Object.is(divFloor(0, -5), 0)).toBe(true);
  });

  it('is exact near the safe-integer limit', () => {
    const max = Number.MAX_SAFE_INTEGER; // 9007199254740991
    expect(divFloor(max, 10_000)).toBe(900_719_925_474);
    expect(divFloor(-max, 10_000)).toBe(-900_719_925_475);
    expect(divFloor(max - 1, 2)).toBe(4_503_599_627_370_495);
  });

  it('validates input', () => {
    expect(() => divFloor(1, 0)).toThrow(RangeError);
    expect(() => divFloor(1.5, 1)).toThrow(RangeError);
    expect(() => divFloor(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('mulBp', () => {
  it('computes floor(value * bp / 10000)', () => {
    expect(BP_SCALE).toBe(10_000);
    expect(mulBp(1000, 2500)).toBe(250);
    expect(mulBp(999, 3333)).toBe(332); // 332.9667
    expect(mulBp(-999, 3333)).toBe(-333);
    expect(mulBp(5, 1)).toBe(0);
    expect(mulBp(123, 10_000)).toBe(123);
    expect(mulBp(100, 15_000)).toBe(150);
  });

  it('is exact for large values (product above 2^53)', () => {
    const v = 900_719_925_474_099; // value * 9999 overflows 2^53
    // Expected computed with BigInt: (v * 9999n) / 10000n = 900629853481551.6...
    expect(mulBp(v, 9_999)).toBe(Number((BigInt(v) * 9_999n) / 10_000n));
    expect(mulBp(v, 9_999)).toBe(900_629_853_481_551);
    expect(mulBp(-v, 9_999)).toBe(-900_629_853_481_552);
    expect(mulBp(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(mulBp(Number.MAX_SAFE_INTEGER, 1)).toBe(900_719_925_474);
  });

  it('throws when the result is not a safe integer', () => {
    expect(() => mulBp(Number.MAX_SAFE_INTEGER, 20_000)).toThrow(RangeError);
    expect(() => mulBp(1, 0.5)).toThrow(RangeError);
  });

  it('mulDivFloor validates the divisor', () => {
    expect(mulDivFloor(10, 3, 4)).toBe(7);
    expect(() => mulDivFloor(1, 1, 0)).toThrow(RangeError);
  });
});

describe('clampInt / assertInt', () => {
  it('clamps', () => {
    expect(clampInt(5, 0, 10)).toBe(5);
    expect(clampInt(-5, 0, 10)).toBe(0);
    expect(clampInt(15, 0, 10)).toBe(10);
    expect(() => clampInt(1, 2, 1)).toThrow(RangeError);
    expect(() => clampInt(0.1, 0, 1)).toThrow(RangeError);
  });

  it('assertInt accepts safe integers only', () => {
    expect(() => assertInt(0)).not.toThrow();
    expect(() => assertInt(-Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => assertInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => assertInt(0.5, 'hp')).toThrow(/hp must be a safe integer/);
    expect(() => assertInt(Number.NaN)).toThrow(RangeError);
  });
});
