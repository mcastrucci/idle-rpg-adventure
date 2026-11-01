/**
 * Minimal integer helpers (ADR-0004 rules: integers only, explicit rounding, no transcendental Math).
 *
 * Deliberately duplicated from `@engine/sim-core` instead of imported: this package is shipped to the web client
 * (ADR-0003) and must not pull a simulator package into the client bundle. The semantics match sim-core's
 * `assertInt`, `divFloor`, `mulDivFloor` and `mulBp`; the tests pin them.
 */

/** Basis-point scale (10000 = 100%). Same value as `@rpg/rpg-schema` `BP`. */
export const BP_SCALE = 10_000;

/** Throws unless `v` is a safe integer. */
export function assertInt(v: number, name = 'value'): void {
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(v)}`);
  }
}

/** `⌊a / b⌋` (toward −∞). Throws on `b === 0`. */
export function divFloor(a: number, b: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  if (b === 0) throw new RangeError('division by zero');
  const r = a % b;
  let q = (a - r) / b;
  if (r !== 0 && r < 0 !== b < 0) q -= 1;
  return q + 0; // normalise -0
}

/** `⌈a / b⌉` (toward +∞). Throws on `b === 0`. */
export function divCeil(a: number, b: number): number {
  return -divFloor(-a, b) + 0;
}

/** `⌊value × num / den⌋`, exact for all safe-integer inputs (BigInt fallback when the product overflows). */
export function mulDivFloor(value: number, num: number, den: number): number {
  assertInt(value, 'value');
  assertInt(num, 'num');
  assertInt(den, 'den');
  if (den === 0) throw new RangeError('division by zero');
  const product = value * num;
  if (Number.isSafeInteger(product)) return divFloor(product, den);

  const p = BigInt(value) * BigInt(num);
  const d = BigInt(den);
  let q = p / d;
  if (p % d !== 0n && p < 0n !== d < 0n) q -= 1n;
  const result = Number(q);
  if (!Number.isSafeInteger(result) || BigInt(result) !== q) {
    throw new RangeError(`mulDivFloor: result ${q.toString()} is not a safe integer`);
  }
  return result;
}

/** `⌊value × bp / 10000⌋`. */
export function mulBp(value: number, bp: number): number {
  return mulDivFloor(value, bp, BP_SCALE);
}
