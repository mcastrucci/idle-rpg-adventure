import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CSSProperties } from 'react';

import type { ExpeditionDto, ExpeditionOptionsDto, ExpeditionStartPayload } from '@rpg/protocol';
import { cancelExpeditionCommand, CommandUnconfirmedError, recoverUnavailableExpeditionCommand, startExpeditionCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { ApiClient } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { describeError } from '../app/useGameSession.ts';

interface Props {
  readonly character: CharacterDto | null;
  readonly canCommand: boolean;
  readonly api: ApiClient;
  readonly runCommand: <T,>(request: CommandRequest<T>) => Promise<T>;
  readonly refreshCharacter: () => Promise<void>;
}

const POLL_MS = 15_000;

export function ExpeditionScreen({ character, canCommand, api, runCommand, refreshCharacter }: Props) {
  const actorId = character?.actorId ?? null;
  const activeId = character?.activityState === 'expedition' ? character.activityId : null;
  const [options, setOptions] = useState<ExpeditionOptionsDto | null>(null);
  const [expedition, setExpedition] = useState<ExpeditionDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<CommandRequest<ExpeditionDto> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [areaId, setAreaId] = useState('');
  const [activityId, setActivityId] = useState('');
  const [durationMin, setDurationMin] = useState(30);
  const [paceBp, setPaceBp] = useState(10_000);
  const [belowHpBp, setBelowHpBp] = useState(0);
  const [onlyWhenNoHealing, setOnlyWhenNoHealing] = useState(false);
  const [consumableItem, setConsumableItem] = useState('');
  const [consumableQty, setConsumableQty] = useState(0);
  const [now, setNow] = useState(Date.now());

  const loadOptions = useCallback(async () => {
    if (!actorId) { setOptions(null); return; }
    setOptionsError(null);
    try {
      const value = await api.expeditionOptions(actorId);
      setOptions(value);
      const allowedAreas = value.areas.filter((area) => area.activities.some((activity) => activity.available));
      setAreaId((current) => allowedAreas.some((area) => area.areaId === current) ? current : allowedAreas[0]?.areaId ?? '');
      setDurationMin((current) => value.durationsMin.includes(current) ? current : value.durationsMin[0] ?? 0);
      setPaceBp((current) => Math.min(value.paceBp.max, Math.max(value.paceBp.min, current || value.paceBp.default)));
    } catch (failure) {
      setOptions(null);
      setOptionsError(describeError(failure));
    }
  }, [actorId, api]);

  const trackingId = activeId ?? (expedition?.state === 'running' ? expedition.id : null);
  const loadExpedition = useCallback(async () => {
    if (!trackingId) { setReadError(null); return; }
    setLoading(true);
    try {
      const value = await api.expedition(trackingId);
      setExpedition(value);
      setReadError(null);
      if (value.state !== 'running') { await refreshCharacter(); void loadOptions(); }
    } catch (failure) {
      setReadError(describeError(failure));
    } finally { setLoading(false); }
  }, [api, loadOptions, refreshCharacter, trackingId]);

  useEffect(() => { void loadOptions(); }, [loadOptions]);
  useEffect(() => { void loadExpedition(); }, [loadExpedition]);
  useEffect(() => { if (activeId && unconfirmed?.envelope.operation === 'expedition.start') setUnconfirmed(null); }, [activeId, unconfirmed]);
  useEffect(() => { if (expedition?.state !== 'running' && (unconfirmed?.envelope.operation === 'expedition.cancel' || unconfirmed?.envelope.operation === 'expedition.recoverUnavailable')) setUnconfirmed(null); }, [expedition, unconfirmed]);
  useEffect(() => {
    if (!trackingId) return;
    const timer = window.setInterval(() => { void loadExpedition(); }, POLL_MS);
    const onFocus = () => { void loadExpedition(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void loadExpedition(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [trackingId, loadExpedition]);
  useEffect(() => {
    if (expedition?.state !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expedition?.state]);

  const availableAreas = options?.areas.filter((area) => area.activities.some((activity) => activity.available)) ?? [];
  const selectedArea = availableAreas.find((area) => area.areaId === areaId) ?? null;
  const activities = selectedArea?.activities.filter((activity) => activity.available) ?? [];
  const selectedActivity = activities.find((activity) => activity.activityId === activityId) ?? activities[0];
  useEffect(() => { setActivityId((current) => activities.some((activity) => activity.activityId === current) ? current : activities[0]?.activityId ?? ''); }, [areaId, options]);
  const availableItem = options?.consumables.find((item) => item.item === consumableItem);
  const startEligible = Boolean(actorId && options && availableAreas.length && selectedArea && selectedActivity &&
    options.durationsMin.includes(durationMin) && paceBp >= options.paceBp.min && paceBp <= options.paceBp.max &&
    (!consumableItem || (availableItem && consumableQty > 0 && consumableQty <= availableItem.availableQty)) && !activeId && canCommand);
  const canStart = startEligible && !pending && (!unconfirmed || unconfirmed.envelope.operation === 'expedition.start');

  async function send(request: CommandRequest<ExpeditionDto>, action: 'start' | 'cancel' | 'recover') {
    setPending(true); setError(null);
    try {
      const result = await runCommand(request);
      setUnconfirmed(null);
      setExpedition(result);
      setCancelOpen(false);
      try { await refreshCharacter(); } catch (failure) { setReadError(describeError(failure)); }
      void loadOptions();
    } catch (failure) {
      if (failure instanceof CommandUnconfirmedError) {
        setUnconfirmed(request);
        try { await refreshCharacter(); } catch { /* Keep the same idempotent request available for retry. */ }
        if (action !== 'start') void loadExpedition();
      }
      else setUnconfirmed(null);
      setError(describeError(failure));
    } finally { setPending(false); }
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!actorId || !selectedArea || !selectedActivity || !canStart) return;
    const payload: ExpeditionStartPayload = {
      actorId,
      request: { areaId: selectedArea.areaId, activityId: selectedActivity.activityId, durationMin, paceBp },
      config: { consumables: consumableItem && consumableQty > 0 ? [{ item: consumableItem, qty: consumableQty }] : [], retreat: { belowHpBp, onlyWhenNoHealing } },
    };
    void send(unconfirmed ?? startExpeditionCommand(payload), 'start');
  }

  const currentExpedition = expedition && (!activeId || expedition.id === activeId) ? expedition : null;
  const elapsed = currentExpedition?.state === 'running'
    ? Math.min(1, Math.max(0, (now - currentExpedition.startsAtMs) / Math.max(1, currentExpedition.plannedEndsAtMs - currentExpedition.startsAtMs))) : 0;
  const ringStyle = useMemo(() => ({ '--expedition-progress': `${elapsed * 100}%` } as CSSProperties), [elapsed]);

  return (
    <section className="screen" aria-labelledby="expedition-title">
      <h1 id="expedition-title" className="screen__title">Expeditions</h1>
      {!character && <p className="muted">Create a character before starting an expedition.</p>}
      {optionsError && <p className="form__error" role="alert">Could not load available expeditions ({optionsError}).</p>}
      {options && availableAreas.length === 0 && <p className="muted">No conquered expedition activities are available yet. Clear an area first to unlock activities here.</p>}
      {currentExpedition?.state === 'running' && <RunningExpedition expedition={currentExpedition} progress={elapsed} style={ringStyle} onCancel={() => setCancelOpen(true)}
        onRecover={() => currentExpedition.recoveryAvailable && void send(unconfirmed?.envelope.operation === 'expedition.recoverUnavailable' ? unconfirmed : recoverUnavailableExpeditionCommand(currentExpedition.id), 'recover')}
        canCancel={canCommand && !pending && (!unconfirmed || (currentExpedition.recoveryAvailable === true && unconfirmed.envelope.operation === 'expedition.recoverUnavailable'))}
        retryRecovery={unconfirmed?.envelope.operation === 'expedition.recoverUnavailable'} loading={loading} />}
      {currentExpedition && currentExpedition.state !== 'running' && <CompletedExpedition expedition={currentExpedition} />}
      {readError && <p className="form__error" role="alert">Could not refresh expedition status ({readError}).</p>}
      {trackingId && <button type="button" className="button button--secondary" disabled={loading} onClick={() => void loadExpedition()}>{loading ? 'Refreshing…' : 'Refresh status'}</button>}
      {character && !activeId && <form className="form expedition-form" onSubmit={start}>
        <h2 className="screen__subtitle">Start an expedition</h2>
        {!options && !optionsError && <p className="muted">Checking conquered activities…</p>}
        {options && availableAreas.length > 0 && <>
          <label className="form__label" htmlFor="expedition-area">Conquered area</label>
          <select id="expedition-area" className="form__input" value={areaId} onChange={(event) => setAreaId(event.target.value)} disabled={pending || unconfirmed !== null}>
            {availableAreas.map((area) => <option key={area.areaId} value={area.areaId}>{label(area.areaId)}</option>)}
          </select>
          <label className="form__label" htmlFor="expedition-activity">Activity</label>
          <select id="expedition-activity" className="form__input" value={selectedActivity?.activityId ?? ''} onChange={(event) => setActivityId(event.target.value)} disabled={pending || unconfirmed !== null}>
            {activities.map((activity) => <option key={activity.activityId} value={activity.activityId}>{label(activity.activityId)}</option>)}
          </select>
          <label className="form__label" htmlFor="expedition-duration">Duration</label>
          <select id="expedition-duration" className="form__input" value={durationMin} onChange={(event) => setDurationMin(Number(event.target.value))} disabled={pending || unconfirmed !== null}>
            {options.durationsMin.map((duration) => <option key={duration} value={duration}>{duration} minutes</option>)}
          </select>
          {options.paceBp.min === options.paceBp.max
            ? <p className="muted">Pace: Normal</p>
            : <><label className="form__label" htmlFor="expedition-pace">Pace (%)</label>
              <input id="expedition-pace" className="form__input" type="number" min={options.paceBp.min / 100} max={options.paceBp.max / 100} step="1" value={paceBp / 100} onChange={(event) => setPaceBp(Math.round(Number(event.target.value) * 100))} disabled={pending || unconfirmed !== null} /></>}
          {options.consumables.length > 0 && <>
            <label className="form__label" htmlFor="expedition-consumable">Consumable (optional)</label>
            <select id="expedition-consumable" className="form__input" value={consumableItem} onChange={(event) => { setConsumableItem(event.target.value); setConsumableQty(0); }} disabled={pending || unconfirmed !== null}>
              <option value="">None</option>{options.consumables.map((item) => <option key={item.item} value={item.item}>{label(item.item)} ({item.availableQty})</option>)}
            </select>
            {consumableItem && <>
              <label className="form__label" htmlFor="expedition-consumable-qty">Quantity</label>
              <input id="expedition-consumable-qty" className="form__input" type="number" min="0" max={availableItem?.availableQty ?? 0} step="1" value={consumableQty} onChange={(event) => setConsumableQty(Number(event.target.value))} disabled={pending || unconfirmed !== null} />
            </>}
          </>}
          <label className="form__label" htmlFor="expedition-retreat">Retreat below health (%)</label>
          <input id="expedition-retreat" className="form__input" type="number" min="0" max="100" step="1" value={belowHpBp / 100} onChange={(event) => setBelowHpBp(Math.round(Number(event.target.value) * 100))} disabled={pending || unconfirmed !== null} />
          <label className="expedition-check"><input type="checkbox" checked={onlyWhenNoHealing} onChange={(event) => setOnlyWhenNoHealing(event.target.checked)} disabled={pending || unconfirmed !== null} /> Retreat only when no healing remains</label>
          {error && <p className="form__error" role="alert">Could not start expedition ({error}).</p>}
          <button className="button" type="submit" disabled={!canStart}>{pending ? 'Starting…' : unconfirmed ? 'Retry start' : 'Start expedition'}</button>
        </>}
      </form>}
      {error && currentExpedition?.state === 'running' && <p className="form__error" role="alert">Could not {currentExpedition.recoveryAvailable ? 'return consumables and end the expedition' : 'cancel the expedition'} ({error}).</p>}
      {cancelOpen && currentExpedition?.state === 'running' && <CancelDialog expedition={currentExpedition} pending={pending} canCommand={canCommand} onClose={() => setCancelOpen(false)} onConfirm={() => void send(unconfirmed ?? cancelExpeditionCommand(currentExpedition.id), 'cancel')} />}
    </section>
  );
}

function RunningExpedition({ expedition, progress, style, canCancel, retryRecovery, loading, onCancel, onRecover }: { expedition: ExpeditionDto; progress: number; style: CSSProperties; canCancel: boolean; retryRecovery: boolean; loading: boolean; onCancel: () => void; onRecover: () => void }) {
  return <section className="expedition-card" aria-labelledby="expedition-running-title">
    <div className="expedition-card__top"><div className="progress-ring" style={style} role="img" aria-label={`${Math.floor(progress * 100)} percent of planned time elapsed`}><span>{Math.floor(progress * 100)}%</span></div>
      <div><h2 id="expedition-running-title" className="screen__subtitle">{label(expedition.activityId)}</h2><p className="muted">{label(expedition.areaId)} · Running</p><p className="muted">{expedition.progress.revealed} revealed segments</p></div></div>
    <div className="expedition-feed"><h3>Revealed events</h3>{expedition.segments.length === 0 ? <p className="muted">No events revealed yet.</p> : <ol>{expedition.segments.flatMap((segment) => segment.events.map((event, index) => <li key={`${segment.index}-${index}`}>{eventText(event)}</li>))}</ol>}</div>
    {expedition.recoveryAvailable
      ? <><p className="muted" role="status">This expedition's saved rules are no longer available. Returning its escrow will end it without rewards or XP.</p>
        <button className="button" type="button" disabled={!canCancel || loading} onClick={onRecover}>{retryRecovery ? 'Retry return and end expedition' : 'Return consumables and end expedition'}</button></>
      : <button className="button button--secondary" type="button" disabled={!canCancel || loading} onClick={onCancel}>Cancel expedition</button>}
  </section>;
}

function CancelDialog({ expedition, pending, canCommand, onClose, onConfirm }: { expedition: ExpeditionDto; pending: boolean; canCommand: boolean; onClose: () => void; onConfirm: () => void }) {
  const preview = expedition.cancelPreview;
  return <div className="dialog-backdrop"><section className="expedition-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
    <h2 id="cancel-title">Cancel expedition?</h2>
    {preview ? <>
      {preview.converted ? <p>This expedition has already finished. Cancel will return the completed result.</p> : <p>Preview uses revealed progress. Unrevealed progress and rewards will be discarded; amounts stay hidden.</p>}
      <h3>Rewards kept</h3><ul>{preview.rewards.length ? preview.rewards.map((reward, index) => <li key={index}>{assetName(reward.asset)}: {reward.qty}</li>) : <li>None</li>}</ul>
      <h3>Progress kept</h3><ul>{preview.keptProgress.length ? preview.keptProgress.map((progress) => <li key={progress.actorId}>XP earned: {progress.xpEarned}{progress.died ? ' · character fell' : ''}{progress.deathPenaltyApplied ? ' · death penalty applies' : ''}</li>) : <li>No progress yet</li>}</ul>
      <h3>Consumables</h3><p>Used: {formatItems(preview.consumablesUsed)} · Returned: {formatItems(preview.consumablesReturned)}</p>
    </> : <p>Loading cancellation preview…</p>}
    <div className="expedition-dialog__actions"><button type="button" className="button button--secondary" onClick={onClose} disabled={pending}>Keep running</button><button type="button" className="button" onClick={onConfirm} disabled={!canCommand || pending || !preview}>{pending ? 'Cancelling…' : 'Confirm cancel'}</button></div>
  </section></div>;
}

function CompletedExpedition({ expedition }: { expedition: ExpeditionDto }) {
  const escrowReturned = isEscrowReturnedReport(expedition.terminalReport);
  if (escrowReturned) return <section className="expedition-card" aria-labelledby="expedition-result-title"><h2 id="expedition-result-title" className="screen__subtitle">Expedition ended</h2>
    <p>{label(expedition.activityId)} · {label(expedition.areaId)}</p><p>Consumables returned. No rewards or XP were awarded.</p></section>;
  return <section className="expedition-card" aria-labelledby="expedition-result-title"><h2 id="expedition-result-title" className="screen__subtitle">{expedition.state === 'completed' ? 'Expedition completed' : 'Expedition cancelled'}</h2>
    <p>{label(expedition.activityId)} · {label(expedition.areaId)}</p><p className="muted">Outcome: {typeof expedition.outcome === 'string' ? label(expedition.outcome) : eventText(expedition.outcome ?? null)}</p>
    {expedition.summary && <div className="expedition-feed"><h3>Summary</h3><ul>{summaryFacts(expedition.summary, expedition.actorId).map((fact) => <li key={fact}>{fact}</li>)}</ul></div>}
    <p className="muted">{expedition.progress.revealed} revealed segments</p></section>;
}

function isEscrowReturnedReport(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['kind'] === 'escrow_returned';
}

function label(id: string): string {
  const value = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
function assetName(asset: unknown): string {
  if (typeof asset === 'string') return label(asset);
  if (asset !== null && typeof asset === 'object') {
    const row = asset as Record<string, unknown>;
    const name = row['item'] ?? row['currency'] ?? row['itemId'];
    if (typeof name === 'string') return label(name);
  }
  return eventText(asset);
}
function formatItems(items: readonly { item: string; qty: number }[]): string { return items.length ? items.map(({ item, qty }) => `${label(item)} ×${qty}`).join(', ') : 'none'; }
function eventText(value: unknown): string {
  if (value === null) return 'Pending';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(eventText).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const type = record['type'];
    if (record['text'] !== undefined || record['message'] !== undefined) return String(record['text'] ?? record['message']);
    if (type === 'encounter') return `Encounter: ${String(record['result'] ?? 'resolved')}`;
    if (type === 'kill') return `Defeated ${label(String(record['enemy'] ?? 'enemy'))} (+${String(record['xp'] ?? 0)} XP)`;
    if (type === 'loot') return `Found ${label(String(record['item'] ?? 'item'))} ×${String(record['qty'] ?? 0)}`;
    if (type === 'gold') return `Found ${String(record['qty'] ?? 0)} gold`;
    if (type === 'consumable') return `Used ${label(String(record['item'] ?? 'consumable'))} ×${String(record['qty'] ?? 0)}`;
    if (type === 'hp') return `Health: ${String(record['hp'] ?? '?')}/${String(record['maxHp'] ?? '?')}`;
    if (type === 'death') return 'Character fell';
    if (type === 'retreat') return `Retreated: ${label(String(record['reason'] ?? 'unknown'))}`;
    return type === undefined ? 'Event' : label(String(type));
  }
  return 'Event';
}

function summaryFacts(value: unknown, actorId: string): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [eventText(value)];
  const report = value as Record<string, unknown>;
  const facts: string[] = [];
  if (Number.isFinite(report['segments'])) facts.push(`${report['segments']} revealed segments`);
  if (Number.isFinite(report['encounters'])) facts.push(`${report['encounters']} encounters, ${String(report['victories'] ?? 0)} victories`);
  if (Number.isFinite(report['gold']) && Number(report['gold']) > 0) facts.push(`Gross gold found: ${report['gold']}`);
  facts.push(...namedCounts(report['xp'], 'XP', actorId));
  facts.push(...namedCounts(report['kills'], 'kills'));
  facts.push(...namedCounts(report['loot'], 'loot'));
  facts.push(...namedCounts(report['consumablesUsed'], 'used'));
  if (report['retreat']) facts.push(`Retreated: ${label(String(report['retreat']))}`);
  if (report['deathLog'] && typeof report['deathLog'] === 'object') {
    const death = report['deathLog'] as Record<string, unknown>;
    facts.push(`Death revealed: ${death['actorId'] === actorId ? 'your character' : label(String(death['actorId'] ?? 'character'))}, segment ${String(death['encounter'] ?? '?')}`);
    if (Array.isArray(death['causes'])) facts.push(...death['causes'].flatMap((cause) => {
      if (cause === null || typeof cause !== 'object') return [];
      const key = (cause as Record<string, unknown>)['key'];
      return typeof key === 'string' ? [label(key.replace(/^idle\.death\./, '').replaceAll('.', '_'))] : [];
    }));
  }
  if (report['outcome'] === 'failed') facts.push('Totals above are before death losses: 50% of the expedition bag is lost (loss rounded down), and the fallen character’s XP penalty applies.');
  return facts.length ? facts : ['No rewards or encounters recorded'];
}
function namedCounts(value: unknown, unit: string, actorId?: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter(([, count]) => Number.isFinite(count) && Number(count) > 0)
    .map(([name, count]) => unit === 'XP'
      ? `${name === actorId ? 'Character' : label(name)}: ${count} gross XP before penalties`
      : unit === 'loot' ? `Gross loot found: ${label(name)} ×${count}` : `${label(name)}: ${count} ${unit}`);
}
