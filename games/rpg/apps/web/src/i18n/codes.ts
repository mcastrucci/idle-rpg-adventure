import { has, t } from './translate.ts';

/**
 * Stable server error / reason codes that have a player-facing message under `ui.code.<code>`. The completeness test
 * checks that each one exists in every locale; codes the server adds later arrive as extra `ui.code.*` entries.
 */
export const KNOWN_CODES = [
  'activity_conflict', 'already_gathered', 'already_upgraded', 'auth_request_failed', 'auth_unavailable',
  'boss_room_requires_confirmation', 'busy', 'character_exists', 'command_expired', 'command_failed',
  'command_id_conflict', 'confirmation_required', 'conquest_required', 'corpse_unavailable', 'debug_clock_limit', 'email_unavailable',
  'estimate_busy', 'exit_locked', 'expedition_version_unavailable', 'forbidden', 'full_hp',
  'guest_credential_disabled', 'hero_dead', 'idempotency_conflict', 'idle.death.biggest_hit',
  'idle.death.damage_taken', 'idle.death.no_consumables', 'idle.death.out_of_consumables', 'idle.death.outnumbered',
  'idle.death.started_wounded', 'idle.death.stunned', 'idle.event.consumable', 'idle.event.death', 'idle.event.gold',
  'idle.event.kill', 'idle.event.loot', 'idle.event.retreat', 'idle.suggestion.bring_healing',
  'idle.suggestion.bring_more_healing', 'idle.suggestion.restore_health', 'idle.suggestion.review_defenses',
  'idle.suggestion.review_risk_retreat', 'idle.suggestion.review_stuns', 'in_combat', 'instance_closing',
  'instance_unavailable', 'insufficient_consumables', 'insufficient_funds', 'internal_error', 'invalid_body',
  'invalid_command', 'invalid_configuration', 'invalid_credentials', 'invalid_email', 'invalid_equipped_item',
  'invalid_live_command', 'invalid_live_start', 'invalid_pace', 'invalid_password', 'invalid_progression',
  'invalid_request', 'invalid_token', 'lease_lost', 'level_required', 'live.corpse', 'live.death.cause.unknown',
  'live.death.run_bag_to_corpse', 'live.death.xp_penalty', 'live_session_active', 'live_session_expired',
  'malformed', 'network_error', 'no_effect_out_of_combat', 'no_living_heroes', 'no_such_consumable',
  'not_a_boss_room', 'not_found', 'not_hosted', 'not_in_combat', 'not_participant', 'not_present',
  'not_safe_location', 'operation_route_mismatch', 'origin_forbidden', 'password_capacity', 'rate_limited',
  'region_locked', 'requires.areaCompleted', 'requires.discovered', 'requires.flag', 'requires.game.defeated',
  'requires.game.levelAtLeast', 'requires.hasItem', 'requires.not', 'requires.other', 'retreat_not_allowed',
  'stale_start_snapshot', 'start.areaNotCompleted', 'start.unknownArea', 'store_error', 'too_many_unique_items', 'unauthorized', 'unknown_area', 'unknown_enemy',
  'unknown_error', 'unknown_exit', 'unknown_group', 'unknown_hotspot', 'unknown_item', 'unknown_location',
  'unknown_node', 'unsupported_equipment_rolls', 'unsupported_operation', 'version_unavailable',
  'world.noRouteFromReachableArea',
] as const;

/** Player-facing text for a stable code, or the code itself when no message exists yet. */
export function codeText(code: string): string {
  const key = `ui.code.${code}`;
  return has(key) ? t(key) : code;
}

/** `true` when `code` has a translated message. */
export function hasCode(code: string): boolean {
  return has(`ui.code.${code}`);
}
