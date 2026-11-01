/**
 * Integer and basis-point math (ADR-0004). Every function accepts and returns safe integers only and rounds
 * explicitly; nothing here produces a fractional number.
 */

/** 1 bp = 0.01 %; 10 000 bp = 100 %. */
export const BP_SCALE = 10_000;

/** Throws a `RangeError` unless `v` is a safe integer (`Number.isSafeInteger`). */
export function assertInt(v: number, name = 'value'): void {
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(v)}`);
  }
}

/**
 * Floor division `⌊a / b⌋` (rounds toward −∞, also for negative operands). Throws on `b === 0`.
 *
 * Exact for all safe integers: `a - (a % b)` is an exact multiple of `b`, so the final division has an integer result
 * that IEEE-754 division returns exactly.
 */
export function divFloor(a: number, b: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  if (b === 0) throw new RangeError('division by zero');
  const r = a % b;
  let q = (a - r) / b;
  if (r !== 0 && r < 0 !== b < 0) q -= 1;
  return q + 0; // normalise -0 to 0
}

/** Clamps the integer `v` into `[min, max]`. Throws if any argument is not a safe integer or `min > max`. */
export function clampInt(v: number, min: number, max: number): number {
  assertInt(v, 'v');
  assertInt(min, 'min');
  assertInt(max, 'max');
  if (min > max) throw new RangeError(`clampInt: min (${min}) > max (${max})`);
  return v < min ? min : v > max ? max : v;
}

/**
 * `⌊value × num / den⌋` computed exactly. Uses plain number arithmetic while the product is a safe integer and falls
 * back to BigInt otherwise. Throws if the result is not a safe integer or `den === 0`.
 */
export function mulDivFloor(value: number, num: number, den: number): number {
  assertInt(value, 'value');
  assertInt(num, 'num');
  assertInt(den, 'den');
  if (den === 0) throw new RangeError('division by zero');
  const product = value * num;
  if (Number.isSafeInteger(product)) return divFloor(product, den);

  const p = BigInt(value) * BigInt(num);
  const d = BigInt(den);
  let q = p / d; // BigInt division truncates toward zero
  if (p % d !== 0n && p < 0n !== d < 0n) q -= 1n;
  const result = Number(q);
  if (!Number.isSafeInteger(result) || BigInt(result) !== q) {
    throw new RangeError(`mulDivFloor: result ${q.toString()} is not a safe integer`);
  }
  return result;
}

/** `⌊value × bp / 10 000⌋`, exact for every safe-integer input (see {@link mulDivFloor}). */
export function mulBp(value: number, bp: number): number {
  return mulDivFloor(value, bp, BP_SCALE);
}
