import type { LiveJson, LiveViewDto } from '@rpg/protocol';
import { useEffect, useState } from 'react';

import { displayLabel } from '../../content/labels.ts';
import { t, useLocale } from '../../i18n/index.ts';
import type { LiveState } from '../state.ts';
import './combat.css';

interface SkillProjection {
  readonly id: string;
  readonly labelKey?: string;
  readonly slot: number;
  readonly cooldownRemainingTicks: number;
  readonly cooldownTicks: number;
  readonly windupTicks: number;
}
interface EffectProjection {
  readonly id: number;
  readonly origin: string;
  readonly originLabelKey?: string;
  readonly type: string;
  readonly remaining: number;
  readonly unit: 'ticks' | 'actions' | 'attacks';
  readonly amount?: number;
  readonly school?: string;
  readonly stat?: string;
}
interface CombatActorProjection {
  readonly id: string;
  readonly labelKey?: string;
  readonly side: 'hero' | 'enemy';
  readonly hp: number;
  readonly maxHp: number;
  readonly alive: boolean;
  readonly effects: readonly EffectProjection[];
  readonly auto?: boolean;
  readonly queued: { readonly kind: string; readonly skill?: string; readonly item?: string; readonly target?: string | null } | null;
  readonly windup: { readonly skill: string; readonly skillLabelKey?: string; readonly targetIds: readonly string[]; readonly startedTick: number; readonly resolveAtTick: number } | null;
}
interface CombatProjection {
  readonly tick: number;
  readonly groupId: string | null;
  readonly actors: readonly CombatActorProjection[];
}
interface HeroProjection {
  readonly actorId: string;
  readonly skills?: readonly SkillProjection[];
  readonly automation?: { readonly enabled: boolean };
  readonly consumables: readonly { readonly item: string; readonly qty: number }[];
}
type CombatView = Omit<LiveViewDto, 'heroes' | 'combat'> & {
  readonly heroes?: readonly HeroProjection[];
  readonly combat?: CombatProjection | null;
  readonly canRetreat?: boolean;
  readonly retreatBlockedReason?: 'boss' | 'not_in_combat' | 'unknown_group' | null;
};
type EventRow = { readonly epoch: number; readonly seq: number; readonly source: 'game' | 'host'; readonly event: LiveJson };
type FeedbackState = { readonly actorId: string | null; readonly groupId: string | null; readonly cursor: { readonly epoch: number; readonly seq: number } | null; readonly manual: string; readonly activity: string };
interface Props {
  readonly view: LiveViewDto;
  readonly events: readonly EventRow[];
  readonly actorId: string;
  readonly pendingCommandIds: readonly string[];
  readonly connection: LiveState;
  readonly onSubmit: (command: LiveJson) => string;
}

const EFFECT_UNIT_KEYS: Readonly<Record<EffectProjection['unit'], string>> = {
  ticks: 'ui.combat.unit.ticks', actions: 'ui.combat.unit.actions', attacks: 'ui.combat.unit.attacks',
};

/** DOM combat controls and status view; the server remains the only combat authority. */
export function LiveCombat({ view, events, actorId, pendingCommandIds, connection, onSubmit }: Props) {
  useLocale();
  const [logOpen, setLogOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({ actorId: null, groupId: null, cursor: null, manual: '', activity: '' });
  const combatView = view as CombatView;
  const combat = combatView.combat;
  const me = combatView.heroes?.find((hero) => hero.actorId === actorId);
  const actors = combat?.actors ?? [];
  const skills = [...(me?.skills ?? [])].sort((a, b) => a.slot - b.slot).slice(0, 4);
  const online = connection.status === 'open';
  const ownActor = actors.find((actor) => actor.id === actorId);
  const ownQueued = actors.filter((actor) => actor.id === actorId && actor.queued !== null);
  const windups = actors.filter((actor) => actor.side === 'enemy' && actor.windup !== null);
  const latestEvents = events.slice(-30).reverse();
  const currentFeedback = feedback.actorId === actorId && feedback.groupId === (combat?.groupId ?? null) ? feedback : null;

  useEffect(() => {
    const groupId = combat?.groupId ?? null;
    setFeedback((previous) => advanceFeedback(events, actorId, groupId, actors, previous));
  }, [actorId, combat?.groupId, events, actors]);

  if (!combat) return <section className="live-combat" aria-label={t('ui.combat.title')}>{t('ui.combat.none')}</section>;

  return <section className="live-combat" aria-label={t('ui.combat.title')}>
    <header className="live-combat__header">
      <div><h2>{t('ui.combat.title')}</h2><p>{t('ui.combat.tick', { tick: combat.tick })}</p></div>
      <span className={`live-combat__connection live-combat__connection--${online ? 'online' : 'offline'}`} role="status">
        {online ? t('ui.combat.connected') : t('ui.combat.offline')}
      </span>
    </header>

    {windups.map((actor) => {
      const windup = actor.windup;
      if (!windup) return null;
      const remaining = Math.max(0, windup.resolveAtTick - combat.tick);
      const targets = windup.targetIds.map((id) => {
        const target = actors.find((candidate) => candidate.id === id);
        return target ? actorLabel(target, actorId) : null;
      }).filter((name): name is string => name !== null);
      return <aside className="live-combat__telegraph" key={actor.id} role="status" aria-live="polite">
        <strong>{t('ui.combat.winding_up', { actor: actorLabel(actor, actorId), skill: displayLabel(windup.skillLabelKey ?? windup.skill) })}</strong>
        <span>{t('ui.combat.resolves', { ticks: t('ui.unit.ticks', { count: remaining }) })}</span>
        {targets.length > 0 && <span>{t('ui.combat.targets', { targets: targets.join(', ') })}</span>}
      </aside>;
    })}

    <div className="live-combat__frames" role="group" aria-label={t('ui.combat.combatants')}>
      {(['hero', 'enemy'] as const).map((side) => <div className="live-combat__side" key={side}>
        <h3>{side === 'hero' ? t('ui.combat.party') : t('ui.combat.enemies')}</h3>
        <div className={`live-combat__actor-grid live-combat__actor-grid--${side}`}>
          {actors.filter((actor) => actor.side === side).map((actor) => <ActorCard key={actor.id} actor={actor} actorId={actorId} />)}
        </div>
      </div>)}
    </div>

    <div className="live-combat__controls">
      <div className="live-combat__control-heading">
        <h3>{t('ui.combat.your_actions')}</h3>
        <label className="live-combat__auto">
          <input type="checkbox" checked={actors.find((actor) => actor.id === actorId)?.auto ?? me?.automation?.enabled ?? false}
            disabled={!online} onChange={(event) => onSubmit({ type: 'setAuto', auto: event.currentTarget.checked })} />
          {t('ui.combat.auto')}
        </label>
      </div>
      <div className="live-combat__feedback" aria-live="polite">
        {ownQueued.length > 0 && <p className="live-combat__queued" role="status">{t('ui.combat.queued', { list: ownQueued.map((actor) => describeQueued(actor.queued)).join('; ') })}</p>}
        {pendingCommandIds.length > 0 && <p className="live-combat__pending" role="status">{t('ui.combat.pending')}</p>}
        {currentFeedback?.manual && <p className="live-combat__result" role="status">{currentFeedback.manual}</p>}
        {currentFeedback?.activity && <p className="live-combat__result" role="status">{currentFeedback.activity}</p>}
      </div>
      <div className="live-combat__skills" aria-label={t('ui.combat.slots_label')}>
        {Array.from({ length: 4 }, (_, index) => {
          const skill = skills[index];
          return <button className="live-combat__action" type="button" key={skill?.id ?? `slot-${index + 1}`} disabled={!online || !skill || (skill?.cooldownRemainingTicks ?? 0) > 0}
            onClick={() => skill && onSubmit({ type: 'useSkill', skill: skill.id })}>
            <span>{t('ui.combat.slot', { n: index + 1 })}</span><strong>{skill ? displayLabel(skill.labelKey ?? skill.id) : t('ui.common.empty')}</strong>
            {skill && <small>{t('ui.combat.skill_info', {
              state: skill.cooldownRemainingTicks > 0 ? t('ui.combat.cooldown_remaining', { ticks: skill.cooldownRemainingTicks }) : t('ui.combat.ready'),
              ticks: skill.cooldownTicks,
            })}</small>}
          </button>;
        })}
      </div>
      <div className="live-combat__items" aria-label={t('ui.combat.consumables')}>
        {me?.consumables.map((item) => <button className="live-combat__item" type="button" key={item.item} disabled={!online || item.qty <= 0}
          onClick={() => onSubmit({ type: 'useConsumable', itemId: item.item })}>
          {t('ui.combat.use', { name: displayLabel(item.item) })} <span>{t('ui.combat.stock', { qty: item.qty })}</span>
        </button>)}
        {(!me || me.consumables.length === 0) && <p>{t('ui.combat.no_consumables')}</p>}
      </div>
      <div className="live-combat__retreat">
        <button className="live-combat__retreat-button" type="button"
          disabled={!online || pendingCommandIds.length > 0 || ownActor?.alive !== true || combatView.canRetreat !== true}
          aria-describedby="live-combat-retreat-reason"
          onClick={() => onSubmit({ type: 'retreat' })}>
          {t('ui.combat.retreat')}
        </button>
        <p id="live-combat-retreat-reason" className="live-combat__retreat-reason" role="status">
          {combatView.canRetreat === true
            ? pendingCommandIds.length > 0 ? t('ui.combat.retreat_pending') : ownActor?.alive !== true ? t('ui.combat.retreat_down') : !online ? t('ui.combat.retreat_offline') : t('ui.combat.retreat_available')
            : t(combatView.retreatBlockedReason === 'boss' ? 'ui.combat.retreat_boss'
              : combatView.retreatBlockedReason === 'unknown_group' ? 'ui.combat.retreat_unknown_group' : 'ui.combat.retreat_not_allowed')}
        </p>
      </div>
      <p className="live-combat__timing">{t('ui.combat.timing')}</p>
    </div>

    <div className="live-combat__log">
      <button type="button" className="live-combat__log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((open) => !open)}>
        {t('ui.combat.log', { count: events.length })}
      </button>
      {logOpen && <ol aria-label={t('ui.combat.log_label')}>
        {latestEvents.map((row) => <li key={`${row.epoch}:${row.seq}`}>{formatEvent(row.event, actorId, actors)}</li>)}
        {latestEvents.length === 0 && <li>{t('ui.combat.log_empty')}</li>}
      </ol>}
    </div>
  </section>;
}

function ActorCard({ actor, actorId }: { readonly actor: CombatActorProjection; readonly actorId: string }) {
  const name = actorLabel(actor, actorId);
  const hpPercent = actor.maxHp > 0 ? Math.max(0, Math.min(100, actor.hp / actor.maxHp * 100)) : 0;
  const isSelf = actor.id === actorId;
  const knownMaxHp = Number.isFinite(actor.maxHp) && actor.maxHp > 0;
  return <article className={`live-combat__actor${actor.alive ? '' : ' live-combat__actor--down'}${isSelf ? ' live-combat__actor--self' : ''}`}
    aria-label={name}>
    <div className="live-combat__actor-title">
      <span className="live-combat__portrait" aria-hidden="true">{initials(name)}</span>
      <strong>{name}</strong>
      {isSelf && <span className="live-combat__self-tag">{t('ui.combat.self')}</span>}
      <span className="live-combat__actor-hp">{actor.alive ? t('ui.combat.hp', { hp: actor.hp, max: actor.maxHp }) : t('ui.combat.down')}</span>
    </div>
    <div className="live-combat__hp" role="progressbar" aria-label={t('ui.combat.hp_label', { name, hp: actor.hp, max: actor.maxHp })}
      aria-valuemin={0} aria-valuemax={knownMaxHp ? actor.maxHp : undefined} aria-valuenow={knownMaxHp ? Math.max(0, Math.min(actor.maxHp, actor.hp)) : undefined}>
      <span style={{ width: `${hpPercent}%` }} />
    </div>
    {actor.side === 'enemy' && knownMaxHp && <span className="live-combat__hp-percent">{t('ui.combat.hp_percent', { percent: Math.round(hpPercent) })}</span>}
    {actor.effects.length > 0 && <ul className="live-combat__effects" aria-label={t('ui.combat.effects_label', { name })}>
      {actor.effects.map((effect) => <li key={effect.id}>
        {[displayLabel(effect.type),
          effect.amount !== undefined ? `${effect.amount}${effect.school ? ` ${displayLabel(effect.school)}` : ''}` : null,
          effect.stat ? displayLabel(effect.stat) : null,
          t('ui.combat.remaining', { remaining: effect.remaining, unit: t(EFFECT_UNIT_KEYS[effect.unit]) })].filter((part) => part !== null).join(' · ')}
      </li>)}
    </ul>}
    {actor.queued && <p className="live-combat__actor-queued">{t('ui.combat.actor_queued', { what: describeQueued(actor.queued) })}</p>}
  </article>;
}

function initials(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? '?';
}

function describeQueued(value: CombatActorProjection['queued']): string {
  if (!value) return '';
  if (value.kind === 'useSkill') return displayLabel(value.skill ?? t('ui.combat.word_skill'));
  if (value.kind === 'useConsumable') return t('ui.combat.queued_item', { name: displayLabel(value.item ?? t('ui.combat.word_consumable')) });
  return displayLabel(value.kind);
}
function actorLabel(actor: CombatActorProjection, actorId: string): string {
  if (actor.id === actorId) return t('ui.common.you');
  if (actor.side === 'hero' && isUuid(actor.id)) return t('ui.common.party_member');
  return displayLabel(actor.labelKey ?? actor.id);
}
function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value); }
function formatEvent(value: LiveJson, actorId: string, actors: readonly CombatActorProjection[]): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return t('ui.combat.event_received');
  const event = value as { readonly [key: string]: LiveJson };
  if (event['type'] === 'combat' && event['event'] !== null && !Array.isArray(event['event']) && typeof event['event'] === 'object') {
    return formatEvent(event['event'], actorId, actors);
  }
  const type = typeof event['type'] === 'string' ? event['type'] : t('ui.combat.word_event');
  const actorIdValue = typeof event['actorId'] === 'string' ? event['actorId'] : '';
  const actor = actorIdValue ? combatantLabel(actorIdValue, actorId, actors) : t('ui.combat.word_combatant');
  if (type === 'ActionStarted') {
    const mode = event['source'] === 'auto' ? t('ui.combat.mode_auto') : event['source'] === 'manual' ? t('ui.combat.mode_manual') : '';
    return t('ui.combat.event_started', { actor, action: actionLabel(event['action']), mode });
  }
  if (type === 'InputRejected') {
    const params = { input: inputLabel(event['kind']), reason: reasonLabel(event['reason']), actor };
    return t(actorIdValue === actorId ? 'ui.combat.event_rejected_you' : 'ui.combat.event_rejected', params);
  }
  if (type === 'ConsumableUsed') return t('ui.combat.event_consumable', { actor, item: displayLabel(typeof event['item'] === 'string' ? event['item'] : t('ui.combat.word_consumable')), remaining: Number(event['remaining']) || 0 });
  if (type === 'DamageDealt') return t('ui.combat.event_damage', { source: combatantLabel(event['sourceId'], actorId, actors), amount: Number(event['amount']) || 0, target: combatantLabel(event['targetId'], actorId, actors) });
  if (type === 'Healed') return t('ui.combat.event_healed', { actor: event['targetId'] === actorId ? t('ui.common.you') : actor, amount: Number(event['amount']) || 0 });
  const reason = typeof event['reason'] === 'string' ? ` · ${displayLabel(event['reason'])}` : '';
  return `${displayLabel(type)}${actorIdValue ? ` · ${actor}` : ''}${reason}`;
}

function actionLabel(value: LiveJson | undefined): string {
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const action = value as { readonly [key: string]: LiveJson };
    if (action['kind'] === 'skill' && typeof action['skill'] === 'string') return displayLabel(action['skill']);
    if (action['kind'] === 'consumable' && typeof action['item'] === 'string') return displayLabel(action['item']);
  }
  return t('ui.combat.word_action');
}

function advanceFeedback(rows: readonly EventRow[], actorId: string, groupId: string | null, actors: readonly CombatActorProjection[], previous: FeedbackState): FeedbackState {
  let state = previous;
  if (previous.actorId !== actorId || previous.groupId !== groupId) {
    let marker: EventRow | undefined;
    for (const row of rows) if (row.source === 'game' && isCombatStart(unwrapCombat(row.event), groupId)) marker = row;
    if (!marker) return { actorId, groupId, cursor: latestCursor(rows), manual: '', activity: '' };
    state = { actorId, groupId, cursor: { epoch: marker.epoch, seq: marker.seq }, manual: '', activity: '' };
  }
  for (const row of rows) {
    if (state.cursor && compareCursor(row, state.cursor) <= 0) continue;
    const event = unwrapCombat(row.event);
    if (state.cursor && row.epoch !== state.cursor.epoch) state = { ...state, cursor: { epoch: row.epoch, seq: row.seq }, manual: '', activity: '' };
    if (event?.['type'] === 'CombatEnded') {
      state = { ...state, cursor: { epoch: row.epoch, seq: row.seq }, manual: '', activity: '' };
      continue;
    }
    if (row.source === 'game' && isCombatStart(event, groupId)) {
      state = { actorId, groupId, cursor: { epoch: row.epoch, seq: row.seq }, manual: '', activity: '' };
      continue;
    }
    state = { ...state, cursor: { epoch: row.epoch, seq: row.seq } };
    if (row.source !== 'game' || !event) continue;
    if (event['type'] === 'InputRejected' && event['actorId'] === actorId) {
      state = { ...state, manual: formatEvent(row.event, actorId, actors) };
    } else if (event['type'] === 'ActionStarted' && event['actorId'] === actorId) {
      const message = formatEvent(row.event, actorId, actors);
      state = event['source'] === 'manual' ? { ...state, manual: message } : { ...state, activity: message };
    } else if ((event['type'] === 'ConsumableUsed' && event['actorId'] === actorId)
      || (event['type'] === 'DamageDealt' && event['sourceId'] === actorId)
      || (event['type'] === 'Healed' && event['targetId'] === actorId)) {
      state = { ...state, activity: formatEvent(row.event, actorId, actors) };
    } else if (event['type'] === 'DamageDealt' && event['targetId'] === actorId) {
      state = { ...state, activity: t('ui.combat.you_took', { amount: Number(event['amount']) || 0, hp: Number(event['hpAfter']) || 0 }) };
    }
  }
  return state;
}
function isCombatStart(event: { readonly [key: string]: LiveJson } | null, groupId: string | null): boolean {
  return event?.['type'] === 'combatStarted' && (groupId === null || event['groupId'] === groupId);
}
function latestCursor(rows: readonly EventRow[]): { readonly epoch: number; readonly seq: number } | null {
  const row = rows.at(-1);
  return row ? { epoch: row.epoch, seq: row.seq } : null;
}
function compareCursor(row: EventRow, cursor: { readonly epoch: number; readonly seq: number }): number {
  return row.epoch - cursor.epoch || row.seq - cursor.seq;
}
function combatantLabel(value: LiveJson | undefined, actorId: string, actors: readonly CombatActorProjection[]): string {
  if (typeof value !== 'string') return t('ui.combat.word_target');
  if (value === actorId) return t('ui.common.you');
  const projection = actors.find((actor) => actor.id === value);
  return projection ? actorLabel(projection, actorId) : isUuid(value) ? t('ui.combat.word_party_member') : displayLabel(value);
}
function inputLabel(value: LiveJson | undefined): string {
  return value === 'useSkill' ? t('ui.combat.word_skill') : value === 'useConsumable' ? t('ui.combat.word_item') : displayLabel(typeof value === 'string' ? value : t('ui.combat.word_action'));
}
const REASON_KEYS: Readonly<Record<string, string>> = {
  onCooldown: 'ui.combat.reason.on_cooldown', noConsumable: 'ui.combat.reason.no_consumable',
  noSkill: 'ui.combat.reason.no_skill', invalidTarget: 'ui.combat.reason.invalid_target',
};
function reasonLabel(value: LiveJson | undefined): string {
  if (typeof value !== 'string') return t('ui.combat.reason.unknown');
  const key = REASON_KEYS[value];
  return key === undefined ? displayLabel(value) : t(key);
}

function unwrapCombat(value: LiveJson): { readonly [key: string]: LiveJson } | null {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return null;
  const event = value as { readonly [key: string]: LiveJson };
  if (event['type'] === 'combat') return unwrapCombat(event['event'] ?? null);
  return event;
}
