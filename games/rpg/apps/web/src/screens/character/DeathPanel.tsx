import { useCallback, useEffect, useState } from 'react';
import type { LiveBossRiskDto, LiveDeathSummaryDto } from '@rpg/protocol';
import type { ApiClient } from '../../api/http.ts';
import type { LiveClient } from '../../live/client.ts';
import { displayLabel } from '../../content/labels.ts';

type State = { readonly phase: 'loading' } | { readonly phase: 'error' } |
  { readonly phase: 'ready'; readonly death: LiveDeathSummaryDto | null };

/** Read-only view of the latest persisted live death. Refresh on load/reload and on durable death/corpse events. */
export function DeathPanel({ actorId, api, live }: { actorId: string; api: ApiClient; live?: Partial<Pick<LiveClient, 'subscribeFrames'>> | undefined }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    void api.liveDeath(actorId).then((death) => {
      if (!cancelled) setState({ phase: 'ready', death });
    }).catch(() => {
      if (!cancelled) setState({ phase: 'error' });
    });
    return () => { cancelled = true; };
  }, [actorId, api, attempt]);

  useEffect(() => live?.subscribeFrames?.((frame) => {
    if (frame.type === 'live.closed') { refresh(); return; }
    if (frame.type !== 'live.event' || frame.source !== 'game' || !isRecord(frame.event)) return;
    if (frame.event.type === 'heroDied' && frame.event.actorId === actorId) { refresh(); return; }
    if (frame.event.type === 'corpseRecovered' && frame.event.actorId === actorId) refresh();
  }), [actorId, live, refresh]);

  return <section className="death-panel" aria-labelledby="death-panel-title">
    <div className="death-panel__heading">
      <h2 id="death-panel-title" className="screen__subtitle">Latest live death</h2>
      <button type="button" className="button button--secondary death-panel__refresh" onClick={refresh}>Refresh</button>
    </div>
    {state.phase === 'loading' && <p className="muted" role="status">Loading death record…</p>}
    {state.phase === 'error' && <div role="alert"><p>Could not load the death record.</p><button type="button" className="button button--secondary" onClick={refresh}>Try again</button></div>}
    {state.phase === 'ready' && !state.death && <p className="muted">No recent live death.</p>}
    {state.phase === 'ready' && state.death && <DeathRecord death={state.death} />}
  </section>;
}

/** Formats the server's boss-entry warning without estimating or deriving risk in the client. */
export function ProvisionalLiveRiskNotice({ risk, actorId }: { risk?: LiveBossRiskDto; actorId?: string } = {}) {
  if (risk === undefined) return <aside className="live-risk-notice" aria-label="Provisional live death consequences">
    <h2>Death consequences · provisional</h2>
    <p>The current live rules apply an XP loss of 10% of the XP required for the next level. That loss can drop a level, but never below level 1. Your run bag moves to a corpse for 24 hours; equipped gear is kept. The server calculates and records the actual result. These rules remain provisional.</p>
    <p>Recovering a corpse leaves its contents at risk in your run bag until you return to Sanctuary.</p>
  </aside>;
  return <aside className="live-risk-notice" aria-label="Provisional live death consequences">
    <h3>Server risk summary · provisional rules</h3>
    <p>Location: {displayLabel(risk.locationId)}. Retreat is blocked in this boss room.</p>
    <div className="live-risk-notice__section">
      <h4>Enemies</h4>
      {risk.enemies.length === 0 ? <p>None listed by the server.</p> : <ul>{risk.enemies.map((enemy, index) =>
        <li key={`${enemy.enemy}:${index}`}>{displayLabel(enemy.enemy)} · {displayLabel(enemy.rank)} rank · level {enemy.level}</li>)}</ul>}
    </div>
    <div className="live-risk-notice__section">
      <h4>Party status</h4>
      {risk.heroes.length === 0 ? <p>No hero details returned.</p> : <ul>{risk.heroes.map((hero) =>
        <li key={hero.actorId}>{heroLabel(hero.actorId, actorId)}: {hero.hp} / {hero.maxHp} HP · {hero.healingConsumables} healing supplies</li>)}</ul>}
    </div>
    <div className="live-risk-notice__section">
      <h4>What is at risk if you die</h4>
      {risk.deathConsequences.length === 0 ? <p>The server returned no per-hero loss estimate.</p> : <ul>{risk.deathConsequences.map((consequence) => {
        const bag = consequence.runBag;
        const itemCount = bag.items.reduce((sum, item) => sum + item.qty, 0);
        return <li key={consequence.actorId}>{heroLabel(consequence.actorId, actorId)}: lose {consequence.xpLost} XP; run bag ({itemCount} stack item(s), {bag.gold} gold, {bag.uniques.length} unique item(s)) moves to a corpse.</li>;
      })}</ul>}
      {risk.onDeath.length > 0 && <p>Server-listed consequences: {risk.onDeath.map(deathConsequenceLabel).join(', ')}.</p>}
    </div>
    <p>The server computes and records any actual loss. Recovering a corpse leaves its contents at risk until you return to Sanctuary.</p>
  </aside>;
}

function DeathRecord({ death }: { death: LiveDeathSummaryDto }) {
  const { corpse } = death;
  const causeRows = death.causes.slice(0, 3);
  const stackItems = corpse.contents.stacks;
  const uniques = corpse.contents.uniques;
  const noItems = stackItems.length === 0 && uniques.length === 0 && corpse.contents.gold === 0;
  return <div className="death-panel__record">
    <p className="death-panel__date">Died {dateLabel(death.occurredAt)}</p>
    <div className="death-panel__section">
      <h3>Top damage sources in this fight</h3>
      {causeRows.length === 0
        ? <p>Damage source details are unavailable for this fight.</p>
        : <ol className="death-panel__causes">{causeRows.map((cause) => <li key={`${cause.sourceId}:${cause.label}`}>{displayLabel(cause.label)} · {cause.damage} damage</li>)}</ol>}
    </div>
    <div className="death-panel__section">
      <h3>XP consequence</h3>
      <p>Lost {death.xpLost} XP · total XP {death.xpBefore.totalXp} → {death.xpAfter.totalXp}. Level {death.xpBefore.level} → {death.xpAfter.level}; XP in level {death.xpBefore.xpIntoLevel} → {death.xpAfter.xpIntoLevel}.</p>
    </div>
    <div className="death-panel__section">
      <h3>Corpse · {statusLabel(corpse.status)}</h3>
      <p>Area {displayLabel(death.areaId)} · location {displayLabel(death.locationId)}</p>
      <p>Expiry: {dateLabel(corpse.expiresAt)}</p>
      <p>{corpse.status === 'active' ? 'Corpse contents:' : 'Bag contents recorded at death:'}</p>
      {noItems ? <p className="muted">The corpse held no loot.</p> : <ul className="death-panel__loot">
        {corpse.contents.gold > 0 && <li><span>Gold</span><strong>{corpse.contents.gold}</strong></li>}
        {stackItems.map((item) => <li key={`stack:${item.item}`}><span>{displayLabel(item.item)}</span><strong>×{item.qty}</strong></li>)}
        {uniques.map((item) => <li key={`unique:${item.itemId}`}><span>{displayLabel(item.definition)}</span><strong>×1</strong></li>)}
      </ul>}
    </div>
    <div className="death-panel__recovery">
      {corpse.status === 'active' ? <>
        <h3>Recovery</h3>
        <p>Only you can recover this corpse. Enter a new live instance in {displayLabel(death.areaId)}, reach {displayLabel(death.locationId)}, and interact with your corpse. Sanctuary alone cannot recover it.</p>
        <p>Recovered loot stays in your run bag and remains at risk until you return to Sanctuary.</p>
      </> : <p>{statusDetail(corpse.status)}</p>}
    </div>
  </div>;
}

function statusLabel(status: LiveDeathSummaryDto['corpse']['status']): string {
  switch (status) {
    case 'active': return 'active';
    case 'recovered': return 'recovered';
    case 'expired': return 'expired';
    case 'invalidated': return 'lost after a newer death';
  }
}
function statusDetail(status: LiveDeathSummaryDto['corpse']['status']): string {
  switch (status) {
    case 'active': return 'Your corpse is active.';
    case 'recovered': return 'This corpse has been recovered. The list above records what it held at death.';
    case 'expired': return 'This corpse has expired and its contents can no longer be recovered.';
    case 'invalidated': return 'A newer death replaced this corpse; these contents can no longer be recovered.';
  }
}
function dateLabel(timestamp: number): string { return new Date(timestamp).toLocaleString(); }
function heroLabel(heroId: string, actorId?: string): string {
  if (actorId && heroId === actorId) return 'You';
  return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(heroId) ? 'Party member' : displayLabel(heroId);
}
function deathConsequenceLabel(value: string): string {
  if (value === 'live.death.run_bag_to_corpse') return 'Run bag moves to a corpse';
  if (value === 'live.death.xp_penalty') return 'XP is lost';
  return displayLabel(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
