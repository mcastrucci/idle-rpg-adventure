/**
 * PCG32 (PCG-XSH-RR 64/32, O'Neill 2014) implemented with 32-bit integer arithmetic only: the 64-bit LCG state and
 * increment are held as two uint32 halves and multiplied with 16-bit limbs / `Math.imul`. No BigInt, no floats in the
 * output, no global state. Matches the reference `pcg32_srandom_r` / `pcg32_random_r` bit for bit (see tests).
 */

import { assertSeed, deriveSeed, fmix32 } from './hash.ts';
import type { Seed } from './hash.ts';
import { BP_SCALE, assertInt } from './int-math.ts';

/** A 64-bit unsigned integer as two uint32 halves. */
export interface U64 {
  readonly hi: number;
  readonly lo: number;
}

/**
 * Serializable PCG32 state (plain JSON data). `s0`/`s1` = high/low 32 bits of the 64-bit LCG state;
 * `i0`/`i1` = high/low 32 bits of the (odd) increment, i.e. the stream selector.
 */
export interface RngState {
  readonly s0: number;
  readonly s1: number;
  readonly i0: number;
  readonly i1: number;
}

/** 6364136223846793005, the PCG 64-bit LCG multiplier. */
const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d;

const TWO_POW_32 = 0x1_0000_0000;

function isU32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/** High 32 bits of the full 64-bit product of two uint32 (the low 32 bits are `Math.imul(a, b) >>> 0`). */
function mulHiU32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  return (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}

export class Rng {
  #hi: number;
  #lo: number;
  readonly #incHi: number;
  readonly #incLo: number;

  private constructor(hi: number, lo: number, incHi: number, incLo: number) {
    this.#hi = hi;
    this.#lo = lo;
    this.#incHi = incHi;
    this.#incLo = incLo;
  }

  /**
   * Reference PCG32 seeding (`pcg32_srandom_r(initState, initSeq)`). Exposed for known-answer tests and for callers
   * that need the full 64-bit seed space; game code normally uses {@link Rng.fromSeed}.
   */
  static fromPcg32(initState: U64, initSeq: U64): Rng {
    for (const [name, v] of [
      ['initState.hi', initState.hi],
      ['initState.lo', initState.lo],
      ['initSeq.hi', initSeq.hi],
      ['initSeq.lo', initSeq.lo],
    ] as const) {
      if (!isU32(v)) throw new RangeError(`${name} must be a uint32, got ${String(v)}`);
    }
    // inc = (initSeq << 1) | 1
    const incHi = ((initSeq.hi << 1) | (initSeq.lo >>> 31)) >>> 0;
    const incLo = ((initSeq.lo << 1) | 1) >>> 0;
    const rng = new Rng(0, 0, incHi, incLo);
    rng.#step();
    // state += initState
    const lo = rng.#lo + initState.lo;
    rng.#lo = lo >>> 0;
    rng.#hi = (rng.#hi + initState.hi + (lo >= TWO_POW_32 ? 1 : 0)) >>> 0;
    rng.#step();
    return rng;
  }

  /**
   * Generator for a 32-bit seed. The seed is expanded to PCG32's 64-bit state and 63-bit stream selector with the
   * murmur3 finalizer: `initState = (fmix32(seed ^ 0x9e3779b9), seed)`,
   * `initSeq = (fmix32(seed ^ 0x85ebca6b), fmix32(seed ^ 0xc2b2ae35))`.
   */
  static fromSeed(seed: Seed): Rng {
    assertSeed(seed);
    return Rng.fromPcg32(
      { hi: fmix32((seed ^ 0x9e3779b9) >>> 0), lo: seed },
      { hi: fmix32((seed ^ 0x85ebca6b) >>> 0), lo: fmix32((seed ^ 0xc2b2ae35) >>> 0) },
    );
  }

  /** Restores a generator from {@link Rng.state}; validates every field. */
  static fromState(state: RngState): Rng {
    if (typeof state !== 'object' || state === null) throw new TypeError('RngState must be an object');
    const { s0, s1, i0, i1 } = state;
    for (const [name, v] of [
      ['s0', s0],
      ['s1', s1],
      ['i0', i0],
      ['i1', i1],
    ] as const) {
      if (!isU32(v)) throw new RangeError(`RngState.${name} must be a uint32, got ${String(v)}`);
    }
    if ((i1 & 1) === 0) throw new RangeError('RngState.i1 must be odd (PCG increment)');
    return new Rng(s0, s1, i0, i1);
  }

  /** Plain-data snapshot; `Rng.fromState(JSON.parse(JSON.stringify(rng.state())))` continues identically. */
  state(): RngState {
    return { s0: this.#hi, s1: this.#lo, i0: this.#incHi, i1: this.#incLo };
  }

  /** state = state * MUL + inc (mod 2^64) */
  #step(): void {
    const hi = this.#hi;
    const lo = this.#lo;
    const prodLo = Math.imul(lo, MUL_LO) >>> 0;
    const prodHi = (mulHiU32(lo, MUL_LO) + Math.imul(hi, MUL_LO) + Math.imul(lo, MUL_HI)) >>> 0;
    const sumLo = prodLo + this.#incLo;
    this.#lo = sumLo >>> 0;
    this.#hi = (prodHi + this.#incHi + (sumLo >= TWO_POW_32 ? 1 : 0)) >>> 0;
  }

  /** Uniform integer in `[0, 2^32 - 1]` (PCG-XSH-RR output of the pre-step state). */
  nextU32(): number {
    const hi = this.#hi;
    const lo = this.#lo;
    this.#step();
    // xorshifted = ((old >> 18) ^ old) >> 27, truncated to 32 bits
    const xHi = hi ^ (hi >>> 18);
    const xLo = lo ^ ((lo >>> 18) | (hi << 14));
    const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;
    const rot = hi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  }

  /**
   * Uniform integer in `[minInclusive, maxInclusive]`, unbiased (rejection sampling as in PCG's `bounded_rand`).
   * Both bounds must be safe integers with `min <= max` and a span of at most 2^32 values. Consumes ≥ 1 draw.
   */
  int(minInclusive: number, maxInclusive: number): number {
    assertInt(minInclusive, 'minInclusive');
    assertInt(maxInclusive, 'maxInclusive');
    if (minInclusive > maxInclusive) {
      throw new RangeError(`int: minInclusive (${minInclusive}) > maxInclusive (${maxInclusive})`);
    }
    const range = maxInclusive - minInclusive + 1;
    if (!Number.isSafeInteger(range) || range > TWO_POW_32) {
      throw new RangeError(`int: range of ${String(range)} values exceeds 2^32`);
    }
    if (range === TWO_POW_32) return minInclusive + this.nextU32();
    // Reject the lowest (2^32 mod range) values so that the remaining count is a multiple of range.
    const threshold = TWO_POW_32 % range;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) return minInclusive + (r % range);
    }
  }

  /** Uniform integer in `[0, 9999]`. */
  bp(): number {
    return this.int(0, BP_SCALE - 1);
  }

  /**
   * `true` with probability `probabilityBp / 10000`. `probabilityBp` must be an integer in `[0, 10000]`. Always
   * consumes exactly one `bp()` draw (also for 0 and 10000) so the stream position does not depend on the odds.
   */
  chanceBp(probabilityBp: number): boolean {
    assertInt(probabilityBp, 'probabilityBp');
    if (probabilityBp < 0 || probabilityBp > BP_SCALE) {
      throw new RangeError(`chanceBp: probabilityBp must be in [0, ${BP_SCALE}], got ${probabilityBp}`);
    }
    return this.bp() < probabilityBp;
  }

  /**
   * Picks a value with probability `weight / Σweights`. Weights are non-negative safe integers (0 = never picked)
   * with a positive total of at most 2^32. Entries are scanned in the given order, so callers must pass a stable
   * order. Consumes one `int()` draw.
   */
  pickWeighted<T>(entries: readonly { readonly weight: number; readonly value: T }[]): T {
    if (entries.length === 0) throw new RangeError('pickWeighted: entries must not be empty');
    let total = 0;
    for (const e of entries) {
      assertInt(e.weight, 'weight');
      if (e.weight < 0) throw new RangeError(`pickWeighted: negative weight ${e.weight}`);
      total += e.weight;
    }
    if (total <= 0) throw new RangeError('pickWeighted: total weight must be > 0');
    if (total > TWO_POW_32) throw new RangeError('pickWeighted: total weight exceeds 2^32');
    let r = this.int(0, total - 1);
    for (const e of entries) {
      if (r < e.weight) return e.value;
      r -= e.weight;
    }
    /* c8 ignore next */
    throw new Error('pickWeighted: unreachable');
  }
}

/** Serializable state of {@link RngStreams}: the root seed plus each created stream, sorted by name. */
export interface RngStreamsState {
  readonly root: Seed;
  readonly streams: readonly { readonly name: string; readonly state: RngState }[];
}

/**
 * Named, independent sub-streams of one root seed. Stream `name` is seeded with `deriveSeed(root, name)`, so its
 * sequence depends only on `(root, name)` — never on which other streams exist, their creation order, or how much
 * they were consumed.
 */
export class RngStreams {
  readonly root: Seed;
  readonly #streams = new Map<string, Rng>();

  private constructor(root: Seed) {
    this.root = root;
  }

  static fromSeed(root: Seed): RngStreams {
    assertSeed(root, 'root');
    return new RngStreams(root);
  }

  static fromState(state: RngStreamsState): RngStreams {
    if (typeof state !== 'object' || state === null) throw new TypeError('RngStreamsState must be an object');
    assertSeed(state.root, 'root');
    if (!Array.isArray(state.streams)) throw new TypeError('RngStreamsState.streams must be an array');
    const streams = new RngStreams(state.root);
    for (const entry of state.streams) {
      if (typeof entry.name !== 'string') throw new TypeError('stream name must be a string');
      if (streams.#streams.has(entry.name)) throw new RangeError(`duplicate stream "${entry.name}"`);
      streams.#streams.set(entry.name, Rng.fromState(entry.state));
    }
    return streams;
  }

  /** The stream called `name`, created on first use; repeated calls return the same instance. */
  stream(name: string): Rng {
    if (typeof name !== 'string') throw new TypeError('stream name must be a string');
    let rng = this.#streams.get(name);
    if (rng === undefined) {
      rng = Rng.fromSeed(deriveSeed(this.root, name));
      this.#streams.set(name, rng);
    }
    return rng;
  }

  /** Canonical snapshot (streams sorted by name by UTF-16 code unit order). */
  state(): RngStreamsState {
    const names = [...this.#streams.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      root: this.root,
      streams: names.map((name) => ({ name, state: (this.#streams.get(name) as Rng).state() })),
    };
  }
}
