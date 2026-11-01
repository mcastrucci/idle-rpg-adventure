/**
 * Canonical JSON and content hashing. The compiler is a build tool, not a simulator, so node:crypto is fine here
 * (`@engine/sim-core`'s `hashSeed` derives RNG seeds and is not a content hash).
 */
import { createHash } from 'node:crypto';

/** Deep copy with object keys sorted (arrays keep their order; `undefined` fields dropped as in JSON). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => (item === undefined ? null : canonicalize(item)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

/** Canonical (sorted-key) JSON serialization; `indent` only changes whitespace. */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalize(value), null, indent);
}

/** Lowercase hex SHA-256 of the compact canonical JSON of `value`. */
export function contentHashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
