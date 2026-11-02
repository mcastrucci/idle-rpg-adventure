/**
 * @engine/live-kernel — game-agnostic live instance hosting (ADR-0012): the in-house `InstanceHost` (leases, fenced
 * checkpoints, crash restore, drift-safe ticks while the game is in a ticking phase, command dedupe, event sequencing,
 * reconnection grace) and the `LiveGame` / `InstanceStore` plugin ports. Transport and PostgreSQL live in server-kit.
 */
export const LIVE_KERNEL_PACKAGE = '@engine/live-kernel';

export * from './types.ts';
export * from './host.ts';
export { MemoryInstanceStore } from './memory-store.ts';
