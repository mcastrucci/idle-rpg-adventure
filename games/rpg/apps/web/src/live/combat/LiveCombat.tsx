import type { LiveJson, LiveViewDto } from '@rpg/protocol';
import { useEffect, useState } from 'react';

import { displayLabel } from '../../content/labels.ts';
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

/** DOM combat controls and status view; the server remains the only combat authority. */
export function LiveCombat({ view, events, actorId, pendingCommandIds, connection, onSubmit }: Props) {
  const [logOpen, setLogOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({ actorId: null, groupId: null, cursor: null, manual: '', activity: '' });
  const combatView = view as CombatView;
  const combat = combatView.combat;
  const me = combatView.heroes?.find((hero) => hero.actorId === actorId);
  const actors = combat?.actors ?? [];
  const skills = [...(me?.skills ?? [])].sort((a, b) => a.slot - b.slot).slice(0, 4);
  const online = connection.status === 'open';
  const queued = actors.filter((actor) => actor.queued !== null);
  const windups = actors.filter((actor) => actor.side === 'enemy' && actor.windup !== null);
  const latestEvents = events.slice(-30).reverse();
  const currentFeedback = feedback.actorId === actorId && feedback.groupId === (combat?.groupId ?? null) ? feedback : null;

  useEffect(() => {
    const groupId = combat?.groupId ?? null;
    setFeedback((previous) => advanceFeedback(events, actorId, groupId, actors, previous));
  }, [actorId, combat?.groupId, events, actors]);

  if (!combat) return <section className="live-combat" aria-label="Combat">No active combat.</section>;

  return <section className="live-combat" aria-label="Combat">
    <header className="live-combat__header">
      <div><h2>Combat</h2><p>Server tick {combat.tick}</p></div>
      <span className={`live-combat__connection live-combat__connection--${online ? 'online' : 'offline'}`} role="status">
        {online ? 'Connected' : 'Offline · actions paused'}
      </span>
    </header>

    {windups.map((actor) => {
      const windup = actor.windup;
      if (!windup) return null;
      const remaining = Math.max(0, windup.resolveAtTick - combat.tick);
      return <aside className="live-combat__telegraph" key={actor.id} role="status" aria-live="polite">
        <strong>{actorLabel(actor, actorId)} is winding up {displayLabel(windup.skillLabelKey ?? windup.skill)}</strong>
        <span>Resolves in {remaining} {remaining === 1 ? 'tick' : 'ticks'}</span>
      </aside>;
    })}

    <div className="live-combat__frames" aria-label="Combatants">
      {(['hero', 'enemy'] as const).map((side) => <div className="live-combat__side" key={side}>
        <h3>{side === 'hero' ? 'Party' : 'Enemies'}</h3>
        {actors.filter((actor) => actor.side === side).map((actor) => <ActorCard key={actor.id} actor={actor} actorId={actorId} />)}
      </div>)}
    </div>

    <div className="live-combat__controls">
      <div className="live-combat__control-heading">
        <h3>Your actions</h3>
        <label className="live-combat__auto">
          <input type="checkbox" checked={actors.find((actor) => actor.id === actorId)?.auto ?? me?.automation?.enabled ?? false}
            disabled={!online} onChange={(event) => onSubmit({ type: 'setAuto', auto: event.currentTarget.checked })} />
          Auto
        </label>
      </div>
      <div className="live-combat__feedback" aria-live="polite">
        {queued.length > 0 && <p className="live-combat__queued" role="status">Queued: {queued.map((actor) => `${actorLabel(actor, actorId)} · ${describeQueued(actor.queued)}`).join('; ')}</p>}
        {pendingCommandIds.length > 0 && <p className="live-combat__pending" role="status">Command sent; waiting for server receipt.</p>}
        {currentFeedback?.manual && <p className="live-combat__result" role="status">{currentFeedback.manual}</p>}
        {currentFeedback?.activity && <p className="live-combat__result" role="status">{currentFeedback.activity}</p>}
      </div>
      <div className="live-combat__skills" aria-label="Equipped skill slots">
        {Array.from({ length: 4 }, (_, index) => {
          const skill = skills[index];
          return <button className="live-combat__action" type="button" key={skill?.id ?? `slot-${index + 1}`} disabled={!online || !skill || (skill?.cooldownRemainingTicks ?? 0) > 0}
            onClick={() => skill && onSubmit({ type: 'useSkill', skill: skill.id })}>
            <span>Slot {index + 1}</span><strong>{skill ? displayLabel(skill.labelKey ?? skill.id) : 'Empty'}</strong>
            {skill && <small>{skill.cooldownRemainingTicks > 0 ? `Cooldown remaining: ${skill.cooldownRemainingTicks} ticks` : 'Ready'} · duration {skill.cooldownTicks} ticks</small>}
          </button>;
        })}
      </div>
      <div className="live-combat__items" aria-label="Consumables">
        {me?.consumables.map((item) => <button className="live-combat__item" type="button" key={item.item} disabled={!online || item.qty <= 0}
          onClick={() => onSubmit({ type: 'useConsumable', itemId: item.item })}>
          Use {displayLabel(item.item)} <span>Stock {item.qty}</span>
        </button>)}
        {(!me || me.consumables.length === 0) && <p>No consumables in the live loadout.</p>}
      </div>
      <p className="live-combat__timing">Actions share your combat action timing. A click replaces your single queued action; cooldown is checked when the action resolves.</p>
    </div>

    <div className="live-combat__log">
      <button type="button" className="live-combat__log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((open) => !open)}>
        Combat log ({events.length})
      </button>
      {logOpen && <ol aria-label="Combat event log">
        {latestEvents.map((row) => <li key={`${row.epoch}:${row.seq}`}>{formatEvent(row.event, actorId, actors)}</li>)}
        {latestEvents.length === 0 && <li>Waiting for combat events.</li>}
      </ol>}
    </div>
  </section>;
}

function ActorCard({ actor, actorId }: { readonly actor: CombatActorProjection; readonly actorId: string }) {
  const name = actorLabel(actor, actorId);
  const hpPercent = actor.maxHp > 0 ? Math.max(0, Math.min(100, actor.hp / actor.maxHp * 100)) : 0;
  return <article className={`live-combat__actor${actor.alive ? '' : ' live-combat__actor--down'}`}>
    <div className="live-combat__actor-title"><strong>{name}</strong><span>{actor.alive ? `${actor.hp} / ${actor.maxHp} HP` : 'Down'}</span></div>
    <div className="live-combat__hp" role="img" aria-label={`${name} HP ${actor.hp} of ${actor.maxHp}`}>
      <span style={{ width: `${hpPercent}%` }} />
    </div>
    {actor.effects.length > 0 && <ul className="live-combat__effects" aria-label={`${name} effects`}>
      {actor.effects.map((effect) => <li key={effect.id}>
        {displayLabel(effect.type)} {effect.amount !== undefined ? `· ${effect.amount}${effect.school ? ` ${displayLabel(effect.school)}` : ''}` : ''}
        {effect.stat ? ` · ${displayLabel(effect.stat)}` : ''} · {effect.remaining} {effect.unit} remaining
      </li>)}
    </ul>}
    {actor.queued && <p className="live-combat__actor-queued">Queued {describeQueued(actor.queued)}</p>}
  </article>;
}

function describeQueued(value: CombatActorProjection['queued']): string {
  if (!value) return '';
  if (value.kind === 'useSkill') return displayLabel(value.skill ?? 'skill');
  if (value.kind === 'useConsumable') return `item ${displayLabel(value.item ?? 'consumable')}`;
  return displayLabel(value.kind);
}
function actorLabel(actor: CombatActorProjection, actorId: string): string {
  if (actor.id === actorId) return 'You';
  if (actor.side === 'hero' && isUuid(actor.id)) return 'Party member';
  return displayLabel(actor.labelKey ?? actor.id);
}
function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value); }
function formatEvent(value: LiveJson, actorId: string, actors: readonly CombatActorProjection[]): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return 'Combat event received.';
  const event = value as { readonly [key: string]: LiveJson };
  if (event['type'] === 'combat' && event['event'] !== null && !Array.isArray(event['event']) && typeof event['event'] === 'object') {
    return formatEvent(event['event'], actorId, actors);
  }
  const type = typeof event['type'] === 'string' ? event['type'] : 'Combat event';
  const actorIdValue = typeof event['actorId'] === 'string' ? event['actorId'] : '';
  const actor = actorIdValue ? combatantLabel(actorIdValue, actorId, actors) : 'Combatant';
  if (type === 'ActionStarted') return `${actor} started ${actionLabel(event['action'])}${event['source'] === 'auto' ? ' (auto)' : event['source'] === 'manual' ? ' (manual)' : ''}.`;
  if (type === 'InputRejected') return `${actorIdValue === actorId ? 'Your' : `${actor}'s`} ${inputLabel(event['kind'])} was rejected: ${reasonLabel(event['reason'])}.`;
  if (type === 'ConsumableUsed') return `${actor} used ${displayLabel(typeof event['item'] === 'string' ? event['item'] : 'consumable')}; ${Number(event['remaining']) || 0} remaining.`;
  if (type === 'DamageDealt') return `${combatantLabel(event['sourceId'], actorId, actors)} dealt ${Number(event['amount']) || 0} damage to ${combatantLabel(event['targetId'], actorId, actors)}.`;
  if (type === 'Healed') return `${event['targetId'] === actorId ? 'You' : actor} healed ${Number(event['amount']) || 0} HP.`;
  const reason = typeof event['reason'] === 'string' ? ` · ${displayLabel(event['reason'])}` : '';
  return `${displayLabel(type)}${actorIdValue ? ` · ${actor}` : ''}${reason}`;
}

function actionLabel(value: LiveJson | undefined): string {
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const action = value as { readonly [key: string]: LiveJson };
    if (action['kind'] === 'skill' && typeof action['skill'] === 'string') return displayLabel(action['skill']);
    if (action['kind'] === 'consumable' && typeof action['item'] === 'string') return displayLabel(action['item']);
  }
  return 'action';
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
      state = { ...state, activity: `You took ${Number(event['amount']) || 0} damage; ${Number(event['hpAfter']) || 0} HP remaining.` };
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
  if (typeof value !== 'string') return 'a target';
  if (value === actorId) return 'You';
  const projection = actors.find((actor) => actor.id === value);
  return projection ? actorLabel(projection, actorId) : isUuid(value) ? 'a party member' : displayLabel(value);
}
function inputLabel(value: LiveJson | undefined): string {
  return value === 'useSkill' ? 'skill' : value === 'useConsumable' ? 'item' : displayLabel(typeof value === 'string' ? value : 'action');
}
function reasonLabel(value: LiveJson | undefined): string {
  if (typeof value !== 'string') return 'unknown reason';
  const readable: Record<string, string> = { onCooldown: 'on cooldown', noConsumable: 'no item remaining', noSkill: 'skill unavailable', invalidTarget: 'invalid target' };
  return readable[value] ?? displayLabel(value);
}

function unwrapCombat(value: LiveJson): { readonly [key: string]: LiveJson } | null {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return null;
  const event = value as { readonly [key: string]: LiveJson };
  if (event['type'] === 'combat') return unwrapCombat(event['event'] ?? null);
  return event;
}
