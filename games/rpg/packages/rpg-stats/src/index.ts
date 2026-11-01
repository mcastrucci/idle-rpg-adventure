/**
 * @rpg/rpg-stats — integer derivation of RPG combat stats from attributes + equipment (combat-engine §3), plus XP
 * curve helpers. Shared by the web client (equip previews) and the server/simulator (authoritative; ADR-0003).
 * Pure and deterministic (ADR-0004). Does not depend on any simulator package.
 */
export const RPG_STATS_PACKAGE = '@rpg/rpg-stats';

export * from './formulas.ts';
export * from './derive.ts';
export * from './delta.ts';
export * from './xp.ts';
export { BP_SCALE } from './int-math.ts';
