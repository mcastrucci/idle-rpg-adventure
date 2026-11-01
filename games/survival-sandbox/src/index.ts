/**
 * @survival/sandbox: a toy survival game built only on `@engine/*` packages, to prove the engine boundary (ADR-0017).
 * Tests/CLI only — no art, no UI.
 */
export const SURVIVAL_SANDBOX_PACKAGE = '@survival/sandbox';

export * from './world.ts';
export * from './tables.ts';
export * from './scavenge.ts';
