# @engine/sim-core

Game-agnostic determinism primitives (ADR-0004, ADR-0017, `docs/spec/combat-engine.md` §8): a seeded PRNG with
named sub-streams, seed hashing/derivation, and integer/basis-point math. No dependencies, no I/O, no floats in outputs.

## RNG: PCG32

`Rng` is **PCG32** (PCG-XSH-RR, 64-bit LCG state, 32-bit output; O'Neill 2014), the generator named in ADR-0004.
The 64-bit state and increment are stored as uint32 halves and stepped with `Math.imul` / 16-bit limbs, so no BigInt
is needed on the hot path. `Rng.fromPcg32(initState, initSeq)` is the reference `pcg32_srandom_r`; it reproduces the
official `pcg32-demo` vector for `(42, 54)`: `0xa15c02b7 0x7b47f409 0xba1d3330 0x83d2f293 0xbfa4784b 0xcbed606e`.

`Rng.fromSeed(seed)` expands a uint32 seed with the murmur3 finalizer:
`initState = (fmix32(seed ^ 0x9e3779b9), seed)`, `initSeq = (fmix32(seed ^ 0x85ebca6b), fmix32(seed ^ 0xc2b2ae35))`.

- `nextU32()` — uniform uint32.
- `int(min, max)` — inclusive, unbiased (rejection of the lowest `2^32 mod range` draws); span ≤ 2^32.
- `bp()` — `int(0, 9999)`. `chanceBp(p)` — `bp() < p`, always one draw, `p ∈ [0, 10000]`.
- `pickWeighted(entries)` — integer weights ≥ 0, total in `(0, 2^32]`, scanned in the given order.
- `state()` / `Rng.fromState()` — plain JSON `{ s0, s1, i0, i1 }` (state hi/lo, increment hi/lo).

## Seeds and streams

`hashSeed(...parts)` is FNV-1a 32 over a canonical encoding (per part: tag byte `0x01` number / `0x02` string, uint32 LE
payload length, payload = decimal ASCII for safe integers or UTF-8 for strings), finished with murmur3 `fmix32`.
`deriveSeed(root, ...labels) = hashSeed(root, ...labels)` — use it for stream names, expedition revisions, Monte Carlo
sample indices, etc.

`RngStreams.fromSeed(root).stream(name)` lazily creates `Rng.fromSeed(deriveSeed(root, name))`, so a stream's sequence
depends only on `(root, name)`: never on creation order or on consumption of other streams. `state()` is
`{ root, streams: [{ name, state }] }` sorted by name.

## Integer math

`BP_SCALE = 10000`; `mulBp(v, bp) = ⌊v·bp/10000⌋` and `mulDivFloor(v, n, d)` are exact for all safe integers (BigInt
fallback when the product exceeds 2^53); `divFloor` rounds toward −∞; `clampInt`; `assertInt` (safe integer check).

## Stability

Known-answer tests freeze the PCG32 reference vector, `fromSeed`/stream sequences and `hashSeed` outputs. Any change to
them alters every replay and requires an `ENGINE_VERSION` bump plus deliberate golden-replay updates.
