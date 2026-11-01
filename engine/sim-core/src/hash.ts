/**
 * Deterministic 32-bit seed hashing (FNV-1a 32 over a canonical byte encoding, then the murmur3 `fmix32` finalizer).
 *
 * Canonical encoding of `parts`, so that different part lists never share a byte string:
 *   for each part: tag byte (0x01 = number, 0x02 = string), payload length as uint32 little-endian, payload bytes.
 *   - number: must be a safe integer; payload = its ASCII decimal form (`String(n)`, e.g. "-42").
 *   - string: payload = UTF-8 bytes (lone surrogates encode as U+FFFD, like `TextEncoder`).
 *
 * The output is frozen by known-answer tests: changing this file changes every derived seed and therefore every replay.
 */

import { assertInt } from './int-math.ts';

/** A 32-bit unsigned integer seed. */
export type Seed = number;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const TAG_NUMBER = 0x01;
const TAG_STRING = 0x02;

function fnvByte(h: number, byte: number): number {
  return Math.imul(h ^ byte, FNV_PRIME) >>> 0;
}

function fnvU32(h: number, v: number): number {
  h = fnvByte(h, v & 0xff);
  h = fnvByte(h, (v >>> 8) & 0xff);
  h = fnvByte(h, (v >>> 16) & 0xff);
  return fnvByte(h, (v >>> 24) & 0xff);
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >>> 18), 0x80 | ((cp >>> 12) & 0x3f), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

/** murmur3 32-bit finalizer: full avalanche of a 32-bit value. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic 32-bit hash of a list of strings and safe integers. Order and types are significant. */
export function hashSeed(...parts: readonly (string | number)[]): Seed {
  let h = FNV_OFFSET;
  for (const part of parts) {
    let tag: number;
    let bytes: number[];
    if (typeof part === 'number') {
      assertInt(part, 'hashSeed part');
      tag = TAG_NUMBER;
      bytes = utf8Bytes(String(part));
    } else if (typeof part === 'string') {
      tag = TAG_STRING;
      bytes = utf8Bytes(part);
    } else {
      throw new TypeError(`hashSeed parts must be strings or safe integers, got ${typeof part}`);
    }
    h = fnvByte(h, tag);
    h = fnvU32(h, bytes.length);
    for (const b of bytes) h = fnvByte(h, b);
  }
  return fmix32(h);
}

/** Throws unless `seed` is an integer in `[0, 2^32 - 1]`. */
export function assertSeed(seed: Seed, name = 'seed'): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`${name} must be a uint32, got ${String(seed)}`);
  }
}

/** Child seed for a labelled purpose (stream name, revision, Monte Carlo sample, …): `hashSeed(root, ...labels)`. */
export function deriveSeed(root: Seed, ...labels: readonly (string | number)[]): Seed {
  assertSeed(root, 'root');
  return hashSeed(root, ...labels);
}
