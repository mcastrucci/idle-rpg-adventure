import type { LiveJson, LiveServerFrame, LiveViewDto } from '@rpg/protocol';
import { useState } from 'react';

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
interface Props {
  readonly view: LiveViewDto;
  readonly events: readonly EventRow[];
  readonly actorId: string;
  readonly pendingCommandIds: readonly string[];
  readonly lastAck: Extract<LiveServerFrame, { readonly type: 'live.ack' }> | null;
  readonly connection: LiveState;
  readonly onSubmit: (command: LiveJson) => string;
}

/** DOM combat controls and status view; the server remains the only combat authority. */
export function LiveCombat({ view, events, actorId, pendingCommandIds, lastAck, connection, onSubmit }: Props) {
  const [logOpen, setLogOpen] = useState(false);
  const combatView = view as CombatView;
  const combat = combatView.combat;
  const me = combatView.heroes?.find((hero) => hero.actorId === actorId);
  const actors = combat?.actors ?? [];
  const skills = [...(me?.skills ?? [])].sort((a, b) => a.slot - b.slot).slice(0, 4);
  const online = connection.status === 'open';
  const queued = actors.filter((actor) => actor.queued !== null);
  const windups = actors.filter((actor) => actor.side === 'enemy' && actor.windup !== null);
  const latestEvents = events.slice(-30).reverse();
  const ackMessage = lastAck?.status === 'rejected'
    ? `The server rejected the last action (${lastAck.reason ?? 'unknown'}).`
    : lastAck?.status === 'applied' ? 'Last action accepted by the server.' : '';

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
        <strong>{label(actor.labelKey ?? actor.id)} is winding up {label(windup.skillLabelKey ?? windup.skill)}</strong>
        <span>Resolves in {remaining} {remaining === 1 ? 'tick' : 'ticks'}</span>
      </aside>;
    })}

    <div className="live-combat__frames" aria-label="Combatants">
      {(['hero', 'enemy'] as const).map((side) => <div className="live-combat__side" key={side}>
        <h3>{side === 'hero' ? 'Party' : 'Enemies'}</h3>
        {actors.filter((actor) => actor.side === side).map((actor) => <ActorCard key={actor.id} actor={actor} />)}
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
      <div className="live-combat__skills" aria-label="Equipped skill slots">
        {Array.from({ length: 4 }, (_, index) => {
          const skill = skills[index];
          return <button className="live-combat__action" type="button" key={skill?.id ?? `slot-${index + 1}`} disabled={!online || !skill}
            onClick={() => skill && onSubmit({ type: 'useSkill', skill: skill.id })}>
            <span>Slot {index + 1}</span><strong>{skill ? label(skill.labelKey ?? skill.id) : 'Empty'}</strong>
            {skill && <small>{skill.cooldownRemainingTicks > 0 ? `Cooldown ${skill.cooldownRemainingTicks} ticks` : 'Ready'} · cooldown {skill.cooldownTicks} ticks</small>}
          </button>;
        })}
      </div>
      <div className="live-combat__items" aria-label="Consumables">
        {me?.consumables.map((item) => <button className="live-combat__item" type="button" key={item.item} disabled={!online}
          onClick={() => onSubmit({ type: 'useConsumable', itemId: item.item })}>
          Use {label(item.item)} <span>Stock {item.qty}</span>
        </button>)}
        {(!me || me.consumables.length === 0) && <p>No consumables in the live loadout.</p>}
      </div>
      {queued.length > 0 && <p className="live-combat__queued" role="status">Queued: {queued.map((actor) => `${label(actor.id)} · ${describeQueued(actor.queued)}`).join('; ')}</p>}
      {pendingCommandIds.length > 0 && <p className="live-combat__pending" role="status">Action awaiting server acknowledgement.</p>}
      {ackMessage && <p className={`live-combat__ack live-combat__ack--${lastAck?.status}`} role="status">{ackMessage}</p>}
    </div>

    <div className="live-combat__log">
      <button type="button" className="live-combat__log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((open) => !open)}>
        Combat log ({events.length})
      </button>
      {logOpen && <ol aria-label="Combat event log">
        {latestEvents.map((row) => <li key={`${row.epoch}:${row.seq}`}>{formatEvent(row.event)}</li>)}
        {latestEvents.length === 0 && <li>Waiting for combat events.</li>}
      </ol>}
    </div>
  </section>;
}

function ActorCard({ actor }: { readonly actor: CombatActorProjection }) {
  const hpPercent = actor.maxHp > 0 ? Math.max(0, Math.min(100, actor.hp / actor.maxHp * 100)) : 0;
  return <article className={`live-combat__actor${actor.alive ? '' : ' live-combat__actor--down'}`}>
    <div className="live-combat__actor-title"><strong>{label(actor.labelKey ?? actor.id)}</strong><span>{actor.alive ? `${actor.hp} / ${actor.maxHp} HP` : 'Down'}</span></div>
    <div className="live-combat__hp" role="img" aria-label={`${label(actor.labelKey ?? actor.id)} HP ${actor.hp} of ${actor.maxHp}`}>
      <span style={{ width: `${hpPercent}%` }} />
    </div>
    {actor.effects.length > 0 && <ul className="live-combat__effects" aria-label={`${label(actor.id)} effects`}>
      {actor.effects.map((effect) => <li key={effect.id}>
        {label(effect.type)} {effect.amount !== undefined ? `· ${effect.amount}${effect.school ? ` ${effect.school}` : ''}` : ''}
        {effect.stat ? ` · ${effect.stat}` : ''} · {effect.remaining} {effect.unit} remaining
      </li>)}
    </ul>}
    {actor.queued && <p className="live-combat__actor-queued">Queued {describeQueued(actor.queued)}</p>}
  </article>;
}

function describeQueued(value: CombatActorProjection['queued']): string {
  if (!value) return '';
  if (value.kind === 'useSkill') return label(value.skill ?? 'skill');
  if (value.kind === 'useConsumable') return `item ${label(value.item ?? 'consumable')}`;
  return label(value.kind);
}
function label(key: string): string { return key.split(/[.:/_-]/).filter(Boolean).at(-1)?.replace(/([a-z])([A-Z])/g, '$1 $2') ?? key; }
function formatEvent(value: LiveJson): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return 'Combat event received.';
  const event = value as { readonly [key: string]: LiveJson };
  if (event['type'] === 'combat' && event['event'] !== null && !Array.isArray(event['event']) && typeof event['event'] === 'object') {
    return formatEvent(event['event']);
  }
  const type = typeof event['type'] === 'string' ? event['type'] : 'Combat event';
  const actor = typeof event['actorId'] === 'string' ? ` · ${label(event['actorId'])}` : '';
  const skill = typeof event['skill'] === 'string' ? ` · ${label(event['skill'])}` : '';
  const reason = typeof event['reason'] === 'string' ? ` · ${event['reason']}` : '';
  return `${type}${actor}${skill}${reason}`;
}
