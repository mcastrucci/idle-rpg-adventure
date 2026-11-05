import { computeWorldView, validateWorld } from '@engine/world';
import type { EvalContext } from '@engine/world';
import { createRpgPredicateRegistry, RpgAreaSchema, RpgLocationSchema } from '@rpg/rpg-schema';
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

/** Makes truly hidden and absent IDs indistinguishable while retaining the public locked-area response. */
export function requireRpgLiveStartAccessible(content: LoadedContent, context: EvalContext<RpgGameContext>, areaId: string): void {
  const area = computeRpgWorldView(content, context).areas.find(candidate => candidate.id === areaId);
  if (!area || area.visibility === 'hidden') throw new RangeError('invalid live start area');
  if (area.visibility !== 'known') throw new RpgAreaLockedError();
}

/** Returns only a validated, authored explorable area that can be used as a live start. */
export function getRpgLiveStartArea(content: LoadedContent, areaId: string, exposeTechnicalAreas = false) {
  return getRpgLiveStartAreas(content, exposeTechnicalAreas).find(area => area.id === areaId);
}

/** Authored tag marking developer/test seed areas that players must never see or enter (issue #156). */
export const TECHNICAL_AREA_TAG = 'technical_seed';

/**
 * IDs of technical areas the player-facing server must hide. Empty when the RPG debug tools are enabled (staging),
 * where these areas stay visible. This is the single server-side filter for the world map, live entry and idle expeditions.
 */
export function hiddenTechnicalAreaIds(content: LoadedContent, exposeTechnicalAreas: boolean): ReadonlySet<string> {
  if (exposeTechnicalAreas) return new Set();
  const world = content.world as { readonly areas?: readonly unknown[] };
  return new Set((world.areas ?? []).map(raw => RpgAreaSchema.parse(raw))
    .filter(area => area.tags?.includes(TECHNICAL_AREA_TAG)).map(area => area.id));
}

/** Returns startable areas in authored order, excluding hubs and areas without a start location. */
export function getRpgLiveStartAreas(content: LoadedContent, exposeTechnicalAreas = false) {
  const world = content.world as { readonly areas?: readonly unknown[]; readonly locations?: readonly unknown[] };
  const locationIds = new Set((world.locations ?? []).map(raw => RpgLocationSchema.parse(raw).id));
  return (world.areas ?? [])
    .map(raw => RpgAreaSchema.parse(raw))
    .filter(area => area.kind === 'explorable' && (exposeTechnicalAreas || !area.tags?.includes(TECHNICAL_AREA_TAG)) && area.startLocation !== undefined &&
      area.locations.includes(area.startLocation) && locationIds.has(area.startLocation));
}
