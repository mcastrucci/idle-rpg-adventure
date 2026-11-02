/** JSON boundaries deliberately reject JS-only values rather than silently changing the request fingerprint. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export const MAX_COMMAND_JSON_BYTES = 65_536;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

export function canonicalCommandJson(input: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function token(value: string): string {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_COMMAND_JSON_BYTES) throw new TypeError('command JSON is too large');
    return value;
  }
  function encode(value: unknown, depth: number): string {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('command JSON is too complex');
    if (value === null) return token('null');
    if (typeof value === 'string' || typeof value === 'boolean') return token(JSON.stringify(value));
    if (typeof value === 'number' && Number.isFinite(value)) return token(JSON.stringify(value));
    if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('invalid command JSON');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid command JSON object');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0) || keys.some((key) => !('value' in (descriptors[key] ?? {})))) throw new TypeError('invalid command JSON property');
    let result: string;
    token('[]'); // Two delimiter bytes for both arrays and objects.
    if (Array.isArray(value)) {
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError('invalid command JSON array');
      result = `[${keys.map((key, index) => `${index > 0 ? token(',') : ''}${encode(descriptors[key]?.value, depth + 1)}`).join('')}]`;
    } else {
      result = `{${keys.sort().map((key, index) => `${token(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`)}${encode(descriptors[key]?.value, depth + 1)}`).join('')}}`;
    }
    ancestors.delete(value);
    return result;
  }
  return encode(input, 0);
}
