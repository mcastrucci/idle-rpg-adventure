import { computeWorldView, validateWorld } from '@engine/world';
import type { EvalContext } from '@engine/world';
import { createRpgPredicateRegistry } from '@rpg/rpg-schema';
import type { RpgGameContext } from '@rpg/rpg-schema';
import type { LoadedContent } from '@engine/server-kit';

export class RpgAreaLockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'region_locked';
  constructor() { super('region_locked'); this.name = 'RpgAreaLockedError'; }
}

/** Uses the engine's existing world-route requirements and reachability evaluation. */
export function computeRpgWorldView(content: LoadedContent, context: EvalContext<RpgGameContext>) {
  const predicates = createRpgPredicateRegistry();
  const parsed = validateWorld(content.world, predicates);
  if (!parsed.ok) throw new Error('RPG content world failed runtime validation');
  return computeWorldView(parsed.world, context, predicates);
}

export function isRpgAreaAccessible(content: LoadedContent, context: EvalContext<RpgGameContext>, areaId: string): boolean {
  const area = computeRpgWorldView(content, context).areas.find(candidate => candidate.id === areaId);
  return area?.visibility === 'known';
}

export function requireRpgAreaAccessible(content: LoadedContent, context: EvalContext<RpgGameContext>, areaId: string): void {
  if (!isRpgAreaAccessible(content, context, areaId)) throw new RpgAreaLockedError();
}
