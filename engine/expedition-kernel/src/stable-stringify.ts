/**
 * Canonical JSON: like `JSON.stringify` but with object keys sorted (UTF-16 code unit order), so two structurally
 * equal values always serialize identically (timeline hashes, determinism checks, cache keys).
 *
 * Only JSON data is accepted: `null`, booleans, finite numbers, strings, arrays and plain objects. Object properties
 * whose value is `undefined` are omitted (as in JSON). Anything else (`undefined` at top level or in arrays,
 * non-finite numbers, bigint, functions, symbols, class instances, cycles) throws a `TypeError`, because it would not
 * survive persistence unchanged.
 */
export function stableStringify(value: unknown): string {
  return encode(value, new Set(), '$');
}

function encode(value: unknown, stack: Set<object>, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number ${String(value)}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${path}: ${typeof value} is not JSON data`);
  }
  if (stack.has(value)) throw new TypeError(`${path}: cyclic reference`);
  stack.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((v, i) => encode(v, stack, `${path}[${i}]`)).join(',')}]`;
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}: not a plain object`);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], stack, `${path}.${k}`)}`).join(',')}}`;
  }
  stack.delete(value);
  return out;
}
