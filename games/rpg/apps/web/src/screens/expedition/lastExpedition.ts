import type { ExpeditionEstimateRequest, ExpeditionOptionsDto } from '@rpg/protocol';
import { parseExpeditionEstimateRequest } from '@rpg/protocol';

/**
 * "Repeat last expedition" (ui-mobile §1: ≤ 3 taps). The last *started* request and configuration are a per-device
 * convenience kept in localStorage per character; the server still validates every start. Storage may be missing or
 * throw (private mode, blocked site data), so every access is guarded and the screen works without it.
 */
const key = (actorId: string) => `rpg.expeditions.last.${actorId}`;

export type LastExpedition = ExpeditionEstimateRequest;

export function loadLastExpedition(actorId: string, storage: Storage | undefined = safeStorage()): LastExpedition | null {
  try {
    const raw = storage?.getItem(key(actorId));
    return raw ? parseExpeditionEstimateRequest(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function saveLastExpedition(actorId: string, value: LastExpedition, storage: Storage | undefined = safeStorage()): void {
  try { storage?.setItem(key(actorId), JSON.stringify(value)); } catch { /* convenience only */ }
}

function safeStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** Why the saved configuration cannot be started with the current server options (null = it can). */
export function lastExpeditionProblem(last: LastExpedition, options: ExpeditionOptionsDto): string | null {
  const area = options.areas.find((candidate) => candidate.areaId === last.request.areaId);
  const activity = area?.activities.find((candidate) => candidate.activityId === last.request.activityId);
  if (!activity?.available) return 'That activity is no longer available.';
  if (!options.durationsMin.includes(last.request.durationMin)) return 'That duration is no longer offered.';
  if (last.request.paceBp < options.paceBp.min || last.request.paceBp > options.paceBp.max) return 'That pace is no longer offered.';
  for (const consumable of last.config.consumables) {
    const available = options.consumables.find((item) => item.item === consumable.item)?.availableQty ?? 0;
    if (available < consumable.qty) return 'Not enough consumables in your inventory for the same loadout.';
  }
  return null;
}
