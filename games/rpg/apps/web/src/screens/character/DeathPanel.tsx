import { useCallback, useEffect, useState } from 'react';
import type { LiveBossRiskDto, LiveDeathSummaryDto } from '@rpg/protocol';
import type { ApiClient } from '../../api/http.ts';
import type { LiveClient } from '../../live/client.ts';
import { displayLabel } from '../../content/labels.ts';
import { formatDateTime, t } from '../../i18n/index.ts';

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
      <h2 id="death-panel-title" className="screen__subtitle">{t('ui.death.title')}</h2>
      <button type="button" className="button button--secondary death-panel__refresh" onClick={refresh}>{t('ui.common.refresh')}</button>
    </div>
    {state.phase === 'loading' && <p className="muted" role="status">{t('ui.death.loading')}</p>}
    {state.phase === 'error' && <div role="alert"><p>{t('ui.death.load_failed')}</p><button type="button" className="button button--secondary" onClick={refresh}>{t('ui.common.try_again')}</button></div>}
    {state.phase === 'ready' && !state.death && <p className="muted">{t('ui.death.none')}</p>}
    {state.phase === 'ready' && state.death && <DeathRecord death={state.death} />}
  </section>;
}

/** Formats the server's boss-entry warning without estimating or deriving risk in the client. */
export function ProvisionalLiveRiskNotice({ risk, actorId }: { risk?: LiveBossRiskDto; actorId?: string } = {}) {
  if (risk === undefined) return <aside className="live-risk-notice" aria-label={t('ui.death.risk_label')}>
    <h2>{t('ui.death.provisional_title')}</h2>
    <p>{t('ui.death.provisional_rules')}</p>
    <p>{t('ui.death.provisional_recovery')}</p>
  </aside>;
  return <aside className="live-risk-notice" aria-label={t('ui.death.risk_label')}>
    <h3>{t('ui.death.server_summary')}</h3>
    <p>{t('ui.death.location', { location: displayLabel(risk.locationId) })}</p>
    <div className="live-risk-notice__section">
      <h4>{t('ui.death.enemies')}</h4>
      {risk.enemies.length === 0 ? <p>{t('ui.death.none_listed')}</p> : <ul>{risk.enemies.map((enemy, index) =>
        <li key={`${enemy.enemy}:${index}`}>{t('ui.death.enemy_line', { enemy: displayLabel(enemy.enemy), rank: displayLabel(enemy.rank), level: enemy.level })}</li>)}</ul>}
    </div>
    <div className="live-risk-notice__section">
      <h4>{t('ui.death.party_status')}</h4>
      {risk.heroes.length === 0 ? <p>{t('ui.death.no_heroes')}</p> : <ul>{risk.heroes.map((hero) =>
        <li key={hero.actorId}>{t('ui.death.hero_line', { who: heroLabel(hero.actorId, actorId), hp: hero.hp, max: hero.maxHp, count: hero.healingConsumables })}</li>)}</ul>}
    </div>
    <div className="live-risk-notice__section">
      <h4>{t('ui.death.at_risk')}</h4>
      {risk.deathConsequences.length === 0 ? <p>{t('ui.death.no_estimate')}</p> : <ul>{risk.deathConsequences.map((consequence) => {
        const bag = consequence.runBag;
        const itemCount = bag.items.reduce((sum, item) => sum + item.qty, 0);
        return <li key={consequence.actorId}>{t('ui.death.loss_line', {
          who: heroLabel(consequence.actorId, actorId), xp: consequence.xpLost, items: itemCount, gold: bag.gold, uniques: bag.uniques.length,
        })}</li>;
      })}</ul>}
      {risk.onDeath.length > 0 && <p>{t('ui.death.server_consequences', { list: risk.onDeath.map(deathConsequenceLabel).join(', ') })}</p>}
    </div>
    <p>{t('ui.death.server_records')}</p>
  </aside>;
}

function DeathRecord({ death }: { death: LiveDeathSummaryDto }) {
  const { corpse } = death;
  const causeRows = death.causes.slice(0, 3);
  const stackItems = corpse.contents.stacks;
  const uniques = corpse.contents.uniques;
  const noItems = stackItems.length === 0 && uniques.length === 0 && corpse.contents.gold === 0;
  return <div className="death-panel__record">
    <p className="death-panel__date">{t('ui.death.died_at', { date: formatDateTime(death.occurredAt) })}</p>
    <div className="death-panel__section">
      <h3>{t('ui.death.top_sources')}</h3>
      {causeRows.length === 0
        ? <p>{t('ui.death.sources_unavailable')}</p>
        : <ol className="death-panel__causes">{causeRows.map((cause) => <li key={`${cause.sourceId}:${cause.label}`}>{t('ui.death.source_line', { label: displayLabel(cause.label), damage: cause.damage })}</li>)}</ol>}
    </div>
    <div className="death-panel__section">
      <h3>{t('ui.death.xp_title')}</h3>
      <p>{t('ui.death.xp_line', {
        lost: death.xpLost, totalBefore: death.xpBefore.totalXp, totalAfter: death.xpAfter.totalXp,
        levelBefore: death.xpBefore.level, levelAfter: death.xpAfter.level,
        inLevelBefore: death.xpBefore.xpIntoLevel, inLevelAfter: death.xpAfter.xpIntoLevel,
      })}</p>
    </div>
    <div className="death-panel__section">
      <h3>{t('ui.death.corpse_title', { status: statusLabel(corpse.status) })}</h3>
      <p>{t('ui.death.corpse_place', { area: displayLabel(death.areaId), location: displayLabel(death.locationId) })}</p>
      <p>{t('ui.death.corpse_expiry', { date: formatDateTime(corpse.expiresAt) })}</p>
      <p>{corpse.status === 'active' ? t('ui.death.corpse_contents') : t('ui.death.corpse_recorded')}</p>
      {noItems ? <p className="muted">{t('ui.death.corpse_empty')}</p> : <ul className="death-panel__loot">
        {corpse.contents.gold > 0 && <li><span>{t('ui.common.gold')}</span><strong>{corpse.contents.gold}</strong></li>}
        {stackItems.map((item) => <li key={`stack:${item.item}`}><span>{displayLabel(item.item)}</span><strong>×{item.qty}</strong></li>)}
        {uniques.map((item) => <li key={`unique:${item.itemId}`}><span>{displayLabel(item.definition)}</span><strong>×1</strong></li>)}
      </ul>}
    </div>
    <div className="death-panel__recovery">
      {corpse.status === 'active' ? <>
        <h3>{t('ui.death.recovery_title')}</h3>
        <p>{t('ui.death.recovery_steps', { area: displayLabel(death.areaId), location: displayLabel(death.locationId) })}</p>
        <p>{t('ui.death.recovery_risk')}</p>
      </> : <p>{statusDetail(corpse.status)}</p>}
    </div>
  </div>;
}

function statusLabel(status: LiveDeathSummaryDto['corpse']['status']): string {
  switch (status) {
    case 'active': return t('ui.death.status_active');
    case 'recovered': return t('ui.death.status_recovered');
    case 'expired': return t('ui.death.status_expired');
    case 'invalidated': return t('ui.death.status_invalidated');
  }
}
function statusDetail(status: LiveDeathSummaryDto['corpse']['status']): string {
  switch (status) {
    case 'active': return t('ui.death.detail_active');
    case 'recovered': return t('ui.death.detail_recovered');
    case 'expired': return t('ui.death.detail_expired');
    case 'invalidated': return t('ui.death.detail_invalidated');
  }
}
function heroLabel(heroId: string, actorId?: string): string {
  if (actorId && heroId === actorId) return t('ui.common.you');
  return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(heroId) ? t('ui.common.party_member') : displayLabel(heroId);
}
function deathConsequenceLabel(value: string): string {
  if (value === 'live.death.run_bag_to_corpse') return t('ui.death.consequence_run_bag');
  if (value === 'live.death.xp_penalty') return t('ui.death.consequence_xp');
  return displayLabel(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
