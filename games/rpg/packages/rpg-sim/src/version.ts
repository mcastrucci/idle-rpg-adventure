/**
 * Engine version stamped into every combat state and `CombatStarted` event (ADR-0004). Any behaviour change (formulas,
 * tick order, targeting, event shapes, RNG usage, default tuning or stat formulas) bumps it, and the golden replay
 * fixtures in `src/combat/golden.test.ts` are updated deliberately in the same commit (see README).
 */
export const ENGINE_VERSION = 'rpg-sim@1.0.0';
