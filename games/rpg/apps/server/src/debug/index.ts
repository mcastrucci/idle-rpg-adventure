import { SystemClock } from '@engine/server-kit';
import type { Clock, ProcessRole, ServerModule } from '@engine/server-kit';

import { TimeTravelClock } from './clock.ts';
import { assertDebugToolsAllowed } from './config.ts';
import type { RpgDebugToolsConfig } from './config.ts';
import { createDebugModule } from './http.ts';

export * from './config.ts';
export { MAX_DEBUG_ADVANCE_MS, MAX_DEBUG_OFFSET_MS, TimeTravelClock } from './clock.ts';
export { DEBUG_GRANT_SOURCE } from './service.ts';
export { DEBUG_CLOCK_REFRESH_MS } from './http.ts';

/**
 * Builds the debug module and the app clock it controls. Returns null when disabled; throws (refusing to boot) when
 * enabled with production or non-allowlisted environment configuration.
 */
export function createRpgDebugTools(config: RpgDebugToolsConfig | undefined, base: Clock | undefined,
  roles: readonly ProcessRole[]): { readonly clock: TimeTravelClock; readonly module: ServerModule } | null {
  if (!config?.enabled) return null;
  assertDebugToolsAllowed(config);
  const clock = new TimeTravelClock(base ?? new SystemClock());
  return { clock, module: createDebugModule(config, clock, roles) };
}
