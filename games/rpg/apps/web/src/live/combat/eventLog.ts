import type { LiveJson } from '@rpg/protocol';

import { displayLabel } from '../../content/labels.ts';
import { t } from '../../i18n/index.ts';

/** The slice of a combat actor the event log needs to name a combatant. */
export interface EventActor {
  readonly id: string;
  readonly labelKey?: string;
  readonly side: 'hero' | 'enemy';
}
type Fields = { readonly [key: string]: LiveJson };

/** Live events the server wraps as `{ type: 'combat', event }` (the combat simulator's event stream). */
export const COMBAT_EVENT_TYPES = ['CombatStarted', 'ActionStarted', 'TelegraphStarted', 'ActionInterrupted', 'ActionSkipped', 'DamageDealt',
  'Healed', 'EffectApplied', 'EffectExpired', 'Cleansed', 'EffectNegated', 'ConsumableUsed', 'ActorDied', 'PhaseChanged', 'AutoToggled',
  'InputRejected', 'CombatEnded'] as const;
/** Live events the game and the live host emit directly. */
export const GAME_EVENT_TYPES = ['traveled', 'discovered', 'combatStarted', 'combat', 'combatEnded', 'combatRewards', 'retreated',
  'bossRoomWarning', 'hotspotInteracted', 'gathered', 'consumableUsed', 'returned', 'heroLeft', 'heroDied', 'corpseRecovered',
  'participant'] as const;

const EFFECT_KEYS: Readonly<Record<string, string>> = {
  shield: 'ui.event.effect.shield', dot: 'ui.event.effect.dot', hot: 'ui.event.effect.hot', stat_mod: 'ui.event.effect.stat_mod',
  taunt: 'ui.event.effect.taunt', stun: 'ui.event.effect.stun',
};
const OUTCOME_KEYS: Readonly<Record<string, string>> = {
  victory: 'ui.event.combat_ended.victory', defeat: 'ui.event.combat_ended.defeat', retreated: 'ui.event.combat_ended.retreated',
};
const PARTICIPANT_KEYS: Readonly<Record<string, string>> = {
  connected: 'ui.event.participant.connected', disconnected: 'ui.event.participant.disconnected',
  leaving: 'ui.event.participant.leaving', left: 'ui.event.participant.left',
};
const REASON_KEYS: Readonly<Record<string, string>> = {
  onCooldown: 'ui.combat.reason.on_cooldown', noConsumable: 'ui.combat.reason.no_consumable',
  noSkill: 'ui.combat.reason.no_skill', invalidTarget: 'ui.combat.reason.invalid_target',
};

export function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value); }

export function actorLabel(actor: EventActor, actorId: string): string {
  if (actor.id === actorId) return t('ui.common.you');
  if (actor.side === 'hero' && isUuid(actor.id)) return t('ui.common.party_member');
  return displayLabel(actor.labelKey ?? actor.id);
}

function combatantLabel(value: LiveJson | undefined, actorId: string, actors: readonly EventActor[]): string {
  if (typeof value !== 'string') return t('ui.combat.word_target');
  if (value === actorId) return t('ui.common.you');
  const projection = actors.find((actor) => actor.id === value);
  return projection ? actorLabel(projection, actorId) : isUuid(value) ? t('ui.combat.word_party_member') : displayLabel(value);
}
function actionLabel(value: LiveJson | undefined): string {
  if (value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object') {
    const action = value as Fields;
    if (action['kind'] === 'skill' && typeof action['skill'] === 'string') return displayLabel(action['skill']);
    if (action['kind'] === 'consumable' && typeof action['item'] === 'string') return displayLabel(action['item']);
  }
  return t('ui.combat.word_action');
}
function inputLabel(value: LiveJson | undefined): string {
  return value === 'useSkill' ? t('ui.combat.word_skill') : value === 'useConsumable' ? t('ui.combat.word_item') : displayLabel(typeof value === 'string' ? value : t('ui.combat.word_action'));
}
function reasonLabel(value: LiveJson | undefined): string {
  if (typeof value !== 'string') return t('ui.combat.reason.unknown');
  const key = REASON_KEYS[value];
  return key === undefined ? displayLabel(value) : t(key);
}
function effectLabel(value: LiveJson | undefined): string {
  const key = typeof value === 'string' ? EFFECT_KEYS[value] : undefined;
  return key === undefined ? t('ui.event.effect.unknown') : t(key);
}
function text(value: LiveJson | undefined, fallbackKey: string): string {
  return typeof value === 'string' ? displayLabel(value) : t(fallbackKey);
}
const num = (value: LiveJson | undefined): number => (typeof value === 'number' ? value : 0);

/**
 * Player-facing, translated sentence for one live event (a game, host or combat event). Unknown types and malformed
 * payloads get a generic translated sentence: the raw `type` is never shown.
 */
export function formatEvent(value: LiveJson, actorId: string, actors: readonly EventActor[]): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return t('ui.combat.event_received');
  const event = value as Fields;
  const type = event['type'];
  if (type === 'combat') {
    const inner = event['event'];
    return inner !== null && inner !== undefined && !Array.isArray(inner) && typeof inner === 'object'
      ? formatEvent(inner, actorId, actors) : t('ui.combat.event_received');
  }
  const actorIdValue = typeof event['actorId'] === 'string' ? event['actorId'] : '';
  const actor = actorIdValue ? combatantLabel(actorIdValue, actorId, actors) : t('ui.combat.word_combatant');
  const source = combatantLabel(event['sourceId'], actorId, actors);
  const target = combatantLabel(event['targetId'], actorId, actors);
  const isYou = actorIdValue === actorId;
  switch (type) {
    // Combat simulator events.
    case 'CombatStarted': return t('ui.event.combat_started');
    case 'ActionStarted': {
      const mode = event['source'] === 'auto' ? t('ui.combat.mode_auto') : event['source'] === 'manual' ? t('ui.combat.mode_manual') : '';
      return t('ui.combat.event_started', { actor, action: actionLabel(event['action']), mode });
    }
    case 'TelegraphStarted': return t('ui.event.telegraph', { actor, skill: text(event['skill'], 'ui.combat.word_skill') });
    case 'ActionInterrupted': return t('ui.event.interrupted', { actor, skill: text(event['skill'], 'ui.combat.word_skill') });
    case 'ActionSkipped': return t('ui.event.skipped', { actor });
    case 'DamageDealt': return t('ui.combat.event_damage', { source, amount: num(event['amount']), target });
    case 'Healed': return t('ui.combat.event_healed', { actor: event['targetId'] === actorId ? t('ui.common.you') : target, amount: num(event['amount']) });
    case 'EffectApplied': return t('ui.event.effect_applied', { effect: effectLabel(event['effect']), source, target });
    case 'EffectExpired': return t('ui.event.effect_expired', { effect: effectLabel(event['effect']), target });
    case 'Cleansed': return t('ui.event.cleansed', { count: num(event['removed']), target });
    case 'EffectNegated': return t('ui.event.effect_negated', { effect: effectLabel(event['effect']), target });
    case 'ConsumableUsed': return t('ui.combat.event_consumable', { actor, item: text(event['item'], 'ui.combat.word_consumable'), remaining: num(event['remaining']) });
    case 'ActorDied': return t('ui.event.actor_died', { actor });
    case 'PhaseChanged': return t('ui.event.phase_changed', { actor, phase: num(event['phase']) });
    case 'AutoToggled': return t(event['auto'] === true ? 'ui.event.auto_on' : 'ui.event.auto_off', { actor });
    case 'InputRejected': {
      const params = { input: inputLabel(event['kind']), reason: reasonLabel(event['reason']), actor };
      return t(isYou ? 'ui.combat.event_rejected_you' : 'ui.combat.event_rejected', params);
    }
    case 'CombatEnded': return t(OUTCOME_KEYS[String(event['outcome'])] ?? 'ui.event.combat_ended.unknown');
    // Game and host events.
    case 'combatStarted': return t(event['boss'] === true ? 'ui.event.combat_started_boss' : 'ui.event.combat_started');
    case 'combatEnded': return t(OUTCOME_KEYS[String(event['outcome'])] ?? 'ui.event.combat_ended.unknown');
    case 'combatRewards': return rewardsText(event['rewards'], actorId);
    case 'traveled': return t('ui.event.traveled', { place: text(event['to'], 'ui.event.word_place') });
    case 'discovered': return t('ui.event.discovered', { place: text(event['locationId'], 'ui.event.word_place') });
    case 'retreated': return t('ui.event.retreated', { place: text(event['to'], 'ui.event.word_place'), hp: num(event['hpCost']) });
    case 'bossRoomWarning': return t('ui.event.boss_room_warning');
    case 'hotspotInteracted': return t('ui.event.hotspot', { name: text(event['hotspotId'], 'ui.event.word_place') });
    case 'gathered': return t('ui.event.gathered', { resource: text(event['resource'], 'ui.event.word_resource') });
    case 'consumableUsed': return t('ui.event.consumable_used', { actor, item: text(event['itemId'], 'ui.combat.word_consumable'), hp: num(event['hp']) });
    case 'returned': return t('ui.event.returned', { place: text(event['locationId'], 'ui.event.word_place') });
    case 'heroLeft': return t('ui.event.hero_left', { actor });
    case 'heroDied': return t(isYou ? 'ui.event.hero_died_you' : 'ui.event.hero_died', { actor, xp: num(event['xpLost']) });
    case 'corpseRecovered': return t(event['repeat'] === true ? 'ui.event.corpse_repeat' : 'ui.event.corpse_recovered');
    case 'participant': {
      const key = PARTICIPANT_KEYS[String(event['status'])];
      return key === undefined ? t('ui.event.unknown') : t(key);
    }
    default: return t('ui.event.unknown');
  }
}

function rewardsText(rewards: LiveJson | undefined, actorId: string): string {
  if (!Array.isArray(rewards)) return t('ui.event.rewards_generic');
  const mine = rewards.find((row) => row !== null && !Array.isArray(row) && typeof row === 'object' && (row as Fields)['actorId'] === actorId);
  if (mine === undefined || mine === null || Array.isArray(mine) || typeof mine !== 'object') return t('ui.event.rewards_generic');
  const reward = mine as Fields;
  return t('ui.event.rewards', { xp: num(reward['xp']), gold: num(reward['gold']) });
}
