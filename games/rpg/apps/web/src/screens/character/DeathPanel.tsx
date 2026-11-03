import { useCallback, useEffect, useState } from 'react';
import type { LiveDeathSummaryDto } from '@rpg/protocol';
import type { ApiClient } from '../../api/http.ts';
import type { LiveClient } from '../../live/client.ts';

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

/** Reusable warning for a future reachable live boss/risk entry point; all listed Live values remain provisional. */
export function ProvisionalLiveRiskNotice() {
  return <aside className="live-risk-notice" aria-label="Provisional live death consequences">
    <h2>Death consequences · provisional</h2>
    <p>The current live rules apply an XP loss of 10% of the XP required for the next level. That loss can drop a level, but never below level 1. Your run bag moves to a corpse for 24 hours; equipped gear is kept. The server calculates and records the actual result. These rules remain provisional.</p>
    <p>Recovering a corpse leaves its contents at risk in your run bag until you return to Sanctuary.</p>
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
      <h3>What happened</h3>
      {causeRows.length === 0
        ? <p>Cause details are unavailable: no recorded damage source could be tied to the fatal event.</p>
        : <ol className="death-panel__causes">{causeRows.map((cause) => <li key={`${cause.sourceId}:${cause.label}`}>{cause.label} · {cause.damage} damage</li>)}</ol>}
    </div>
    <div className="death-panel__section">
      <h3>XP consequence</h3>
      <p>Lost {death.xpLost} XP. Before: level {death.xpBefore.level}, {death.xpBefore.xpIntoLevel} XP in level ({death.xpBefore.totalXp} total). After: level {death.xpAfter.level}, {death.xpAfter.xpIntoLevel} XP in level ({death.xpAfter.totalXp} total).</p>
    </div>
    <div className="death-panel__section">
      <h3>Corpse · {statusLabel(corpse.status)}</h3>
      <p>Area <code>{death.areaId}</code> · location <code>{death.locationId}</code></p>
      <p>Expiry: {dateLabel(corpse.expiresAt)}</p>
      <p>{corpse.status === 'active' ? 'Corpse contents:' : 'Bag contents recorded at death:'}</p>
      {noItems ? <p className="muted">The corpse held no loot.</p> : <ul className="death-panel__loot">
        {corpse.contents.gold > 0 && <li><span>Gold</span><strong>{corpse.contents.gold}</strong></li>}
        {stackItems.map((item) => <li key={`stack:${item.item}`}><span>{item.item}</span><strong>×{item.qty}</strong></li>)}
        {uniques.map((item) => <li key={`unique:${item.itemId}`}><span>{item.definition}</span><strong>×1</strong></li>)}
      </ul>}
    </div>
    <div className="death-panel__recovery">
      {corpse.status === 'active' ? <>
        <h3>Recovery</h3>
        <p>Only you can recover this corpse. Enter a new live instance in area <code>{death.areaId}</code>, reach location <code>{death.locationId}</code>, and interact with your corpse. Sanctuary alone cannot recover it.</p>
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
