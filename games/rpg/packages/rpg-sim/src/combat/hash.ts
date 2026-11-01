/**
 * Event-stream fingerprint for golden replays, caching and cross-version checks: two independent 32-bit
 * `hashSeed` chains over the canonical JSON of each event (key order is fixed by the engine), printed as 16 hex digits.
 */
import { hashSeed } from '@engine/sim-core';

import type { CombatEvent } from './types.ts';

export function hashEvents(events: readonly CombatEvent[]): string {
  let a = hashSeed('rpg-sim/events/a');
  let b = hashSeed('rpg-sim/events/b');
  for (const e of events) {
    const json = JSON.stringify(e);
    a = hashSeed(a, json);
    b = hashSeed(json, b);
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
