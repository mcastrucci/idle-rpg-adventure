/**
 * @engine/world — game-agnostic world graph: hubs, world map of areas, area graphs of locations, requirements,
 * completion and visibility (ADR-0018, docs/engine/world-model.md).
 */
export const WORLD_PACKAGE = '@engine/world';

export * from './schemas.ts';
export * from './actor.ts';
export * from './registry.ts';
export * from './requirements.ts';
export * from './completion.ts';
export * from './view.ts';
export * from './validate.ts';
export * from './mermaid.ts';
