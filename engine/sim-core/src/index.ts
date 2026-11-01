/** @engine/sim-core: seeded RNG streams, integer/basis-point math, determinism helpers (ADR-0004). */
export { assertSeed, deriveSeed, fmix32, hashSeed } from './hash.ts';
export type { Seed } from './hash.ts';
export { BP_SCALE, assertInt, clampInt, divFloor, mulBp, mulDivFloor } from './int-math.ts';
export { Rng, RngStreams } from './rng.ts';
export type { RngState, RngStreamsState, U64 } from './rng.ts';
