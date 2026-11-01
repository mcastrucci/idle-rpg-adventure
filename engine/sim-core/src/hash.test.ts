import { describe, expect, it } from 'vitest';

import { deriveSeed, fmix32, hashSeed } from './index.ts';

/** Independent reference of the documented encoding, using TextEncoder for UTF-8. */
function referenceHash(...parts: readonly (string | number)[]): number {
  let h = 0x811c9dc5;
  const feed = (b: number): void => {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (const part of parts) {
    const bytes = new TextEncoder().encode(String(part));
    feed(typeof part === 'number' ? 1 : 2);
    for (let i = 0; i < 4; i++) feed((bytes.length >>> (8 * i)) & 0xff);
    for (const b of bytes) feed(b);
  }
  return fmix32(h);
}

describe('hashSeed / deriveSeed', () => {
  it('known answers are frozen', () => {
    // Produced once by this implementation and frozen; changing them changes every derived seed and replay.
    expect(hashSeed()).toBe(2872998923);
    expect(hashSeed('combat')).toBe(1804955797);
    expect(hashSeed(42, 'combat')).toBe(2171824754);
    expect(deriveSeed(42, 'loot')).toBe(3949804101);
    expect(deriveSeed(42, 'encounters')).toBe(2743356658);
    expect(deriveSeed(42, 'ai')).toBe(2949961387);
    expect(hashSeed(1, 'revision', 3)).toBe(736580067);
    expect(hashSeed('é🎲')).toBe(2933976686);
  });

  it('matches an independent implementation of the documented encoding', () => {
    for (const parts of [[], ['combat'], [42, 'combat'], [1, 'revision', 3], ['é🎲', -7], ['日本語', 0]] as const) {
      expect(hashSeed(...parts)).toBe(referenceHash(...parts));
    }
  });

  it('deriveSeed(root, ...labels) equals hashSeed(root, ...labels)', () => {
    expect(deriveSeed(123, 'mc', 5)).toBe(hashSeed(123, 'mc', 5));
  });

  it('different labels, types and splits give different seeds', () => {
    const seeds = [
      deriveSeed(42, 'combat'),
      deriveSeed(42, 'loot'),
      deriveSeed(43, 'combat'),
      deriveSeed(42, 'combat', 0),
      deriveSeed(42, 'combat', 1),
      hashSeed('ab', 'c'),
      hashSeed('a', 'bc'),
      hashSeed(1),
      hashSeed('1'),
    ];
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('returns uint32 and validates input', () => {
    for (let i = 0; i < 100; i++) {
      const s = deriveSeed(i, 'x');
      expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
    }
    expect(() => hashSeed(1.5)).toThrow(RangeError);
    expect(() => hashSeed(Number.NaN)).toThrow(RangeError);
    expect(() => deriveSeed(-1, 'x')).toThrow(RangeError);
    expect(() => deriveSeed(0x1_0000_0000, 'x')).toThrow(RangeError);
  });
});
