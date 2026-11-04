import { useCallback, useEffect, useRef, useState } from 'react';
import { liveXpGainFromEvent } from '@rpg/protocol';
import type { LiveBossRiskDto, LiveCurrentResponseDto, LiveJson, LiveOptionsDto, LiveStartRequestDto, LiveViewDto, LiveXpGainDto } from '@rpg/protocol';
import type { ApiClient } from '../api/http.ts';
import type { LiveConnection } from '../app/services.ts';
import { currentLive, liveOptions, startLive } from '../live/api.ts';
import { LiveSession } from '../live/session.ts';
import type { LiveSessionClient, LiveSessionState } from '../live/session.ts';
import { displayLabel } from '../content/labels.ts';
import { codeText, t, useLocale } from '../i18n/index.ts';
import type { Params } from '../i18n/index.ts';
import { DeathPanel, ProvisionalLiveRiskNotice } from './character/DeathPanel.tsx';
import { LiveCombat } from '../live/combat/LiveCombat.tsx';
import { SceneViewport } from '../scene/SceneViewport.tsx';

type Props = {
  actorId: string;
  /** Optional area selected from the world map. The server's options remain authoritative. */
  initialAreaId?: string | undefined;
  api: ApiClient;
  live: LiveConnection;
  canCommand: boolean;
  onCharacterRefresh: () => Promise<void>;
};

type LoadState = 'loading' | 'ready' | 'error';
type XpNotice = { readonly key: string; readonly xp: number; readonly levelAfter?: number | undefined; readonly leveledUp: boolean } | null;
/** A status line stored as a catalog key plus params, so it is translated when rendered. */
type Notice = { readonly kind: 'pending' | 'confirmed' | 'rejected' | 'error'; readonly key: string; readonly params?: Params | undefined } | null;
/** A failure is either a stable code (shown through `ui.code.*`) or a catalog sentence. */
type LiveError = string | { readonly key: string; readonly params?: Params };
type StartError = { readonly code: string; readonly sameCommand: boolean };

function liveErrorText(error: LiveError): string {
  return typeof error === 'string' ? codeText(error) : t(error.key, error.params);
}
type Snapshot = {
  readonly phase?: string;
  readonly area?: string;
  readonly location?: string;
  readonly heroes?: readonly { readonly actorId: string; readonly level?: number; readonly xpIntoLevel?: number; readonly xpToNext?: number | null; readonly hp: number | null; readonly maxHp: number; readonly present: boolean; readonly consumables: readonly { readonly item: string; readonly qty: number }[] }[];
  readonly groups?: readonly { readonly id: string; readonly enemies: readonly string[]; readonly boss: boolean; readonly defeated: boolean }[];
  readonly exits?: readonly { readonly id: string; readonly to: string; readonly open: boolean; readonly reasons: readonly string[]; readonly bossRoom: boolean; readonly visited: boolean }[];
  readonly hotspots?: readonly { readonly id: string; readonly type: string; readonly textKey: string; readonly done: boolean }[];
  readonly resources?: readonly { readonly nodeId: string; readonly resource: string; readonly gathered: boolean }[];
  readonly canReturn?: boolean;
  readonly runBag?: readonly { readonly actorId: string; readonly items: readonly { readonly item: string; readonly qty: number }[]; readonly gold: number; readonly uniques?: readonly { readonly itemId: string; readonly definition: string }[] }[];
};

/** Interim DOM live adventure entry and scene surface. All scene facts come from the current host view. */
export function LiveScreen({ actorId, initialAreaId, api, live, canCommand, onCharacterRefresh }: Props) {
  useLocale();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [options, setOptions] = useState<LiveOptionsDto | null>(null);
  const [current, setCurrent] = useState<LiveCurrentResponseDto['current']>(null);
  const [currentError, setCurrentError] = useState<LiveError | null>(null);
  const [selectedArea, setSelectedArea] = useState('');
  const [selectedSupplies, setSelectedSupplies] = useState<Record<string, number>>({});
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<StartError | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [sessionState, setSessionState] = useState<LiveSessionState | null>(null);
  const [serverView, setServerView] = useState<LiveViewDto | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [xpNotice, setXpNotice] = useState<XpNotice>(null);
  const [risk, setRisk] = useState<LiveBossRiskDto | null>(null);
  const [riskExit, setRiskExit] = useState<string | null>(null);
  const [terminalOutcome, setTerminalOutcome] = useState<string | null>(null);
  const pendingStart = useRef<LiveStartRequestDto | null>(null);
  const pendingCommand = useRef<string | null>(null);
  const processedAck = useRef<string | null>(null);
  const riskRequestCursor = useRef<{ epoch: number; seq: number } | null>(null);
  const combatStartCursor = useRef<string | null>(null);
  const processedTerminal = useRef(false);
  const processedDeathSeq = useRef<string | null>(null);
  const processedXpCursor = useRef<{ epoch: number; seq: number } | null>(null);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const sessionSnapshotSeen = useRef(false);

  const refreshCurrent = useCallback(async (showError = false) => {
    const sequence = ++refreshSequence.current;
    try {
      const response = await currentLive(api, actorId);
      if (!mounted.current || sequence !== refreshSequence.current) return response.current;
      setCurrent(response.current);
      setCurrentError(null);
      // HTTP has no sequence cursor. After the socket has delivered its authoritative snapshot, never
      // let a slower GET roll the scene back to an older view.
      if (!sessionSnapshotSeen.current) setServerView(response.current?.view ?? null);
      return response.current;
    } catch (error) {
      if (mounted.current && sequence === refreshSequence.current && showError) {
        setCurrentError(errorMessage(error));
      }
      return undefined;
    }
  }, [api, actorId]);

  const load = useCallback(async () => {
    setLoadState('loading');
    setStartError(null);
    try {
      // Read the host first: the options route correctly rejects characters already in a live activity.
      const active = await currentLive(api, actorId);
      if (!mounted.current) return;
      setCurrent(active.current);
      setServerView(active.current?.view ?? null);
      sessionSnapshotSeen.current = false;
      setCurrentError(null);
      if (!active.current) {
        const serverOptions = await liveOptions(api, actorId);
        if (!mounted.current) return;
        setOptions(serverOptions);
        setSelectedArea((value) => serverOptions.areas.find((area) => area.id === initialAreaId)?.id
          ?? serverOptions.areas.find((area) => area.id === value)?.id ?? serverOptions.areas[0]?.id ?? '');
      }
      setLoadState('ready');
    } catch (error) {
      if (!mounted.current) return;
      setLoadState('error');
      setStartError({ code: errorMessage(error), sameCommand: false });
    }
  }, [api, actorId, initialAreaId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useEffect(() => {
    if (!current) { setSession(null); setSessionState(null); return; }
    sessionSnapshotSeen.current = false;
    if (!isSessionClient(live)) {
      setCurrentError({ key: 'ui.live.cannot_attach' });
      return;
    }
    const next = new LiveSession({ client: live, instanceId: current.instanceId, actorId });
    setSession(next);
    const unsubscribe = next.subscribe((state) => {
      if (state.view && state.baselineEpoch !== null && state.baselineSeq !== null) sessionSnapshotSeen.current = true;
      setSessionState(state);
    });
    return () => { unsubscribe(); next.dispose(); };
  }, [actorId, current?.instanceId, live]);

  useEffect(() => {
    if (!sessionState) return;
    const combatStart = [...sessionState.recentEvents].reverse().find((row) => row.source === 'game' && record(row.event)?.['type'] === 'combatStarted');
    const startKey = combatStart ? `${current?.instanceId ?? ''}:${combatStart.epoch}:${combatStart.seq}` : null;
    if (startKey && startKey !== combatStartCursor.current) {
      combatStartCursor.current = startKey;
      if (!pendingCommand.current) setNotice(null);
    }
    // The host sends a current view snapshot after commands. Use that sequenced socket baseline directly;
    // HTTP has no cursor and cannot safely reconcile every event without risking a rollback.
    const newestWarning = [...sessionState.recentEvents].reverse().find((row) => {
      const event = record(row.event);
      const cursor = riskRequestCursor.current;
      const newer = cursor !== null && (row.epoch > cursor.epoch || (row.epoch === cursor.epoch && row.seq > cursor.seq));
      return newer && event?.['type'] === 'bossRoomWarning' && event['exitId'] === riskExit;
    });
    if (newestWarning) {
      const event = record(newestWarning.event);
      if (event && 'risk' in event) {
        setRisk(event['risk'] as unknown as LiveBossRiskDto);
        riskRequestCursor.current = null;
      }
    }
    if (sessionState.lastAck && sessionState.lastAck.commandId === pendingCommand.current && processedAck.current !== sessionState.lastAck.commandId) {
      processedAck.current = sessionState.lastAck.commandId;
      if (sessionState.lastAck.status === 'rejected') {
        setNotice({ kind: 'rejected', key: 'ui.live.rejected', params: { reason: codeText(sessionState.lastAck.reason ?? 'unknown') } });
        pendingCommand.current = null;
      } else {
        setNotice({ kind: 'confirmed', key: 'ui.live.received' });
        pendingCommand.current = null;
      }
    }
    // XP is granted and persisted by the server at each victory, so the level/XP display and the character cache
    // refresh as soon as the reward event arrives (never inferred or computed in the browser).
    const xpCursor = processedXpCursor.current;
    let newestGain: { row: { epoch: number; seq: number }; gain: LiveXpGainDto } | null = null;
    let lastRow: { epoch: number; seq: number } | null = null;
    for (const row of sessionState.recentEvents) {
      if (xpCursor && (row.epoch < xpCursor.epoch || (row.epoch === xpCursor.epoch && row.seq <= xpCursor.seq))) continue;
      lastRow = row;
      if (row.source !== 'game') continue;
      const gain = liveXpGainFromEvent(row.event, actorId);
      if (gain) newestGain = { row, gain };
    }
    if (lastRow) processedXpCursor.current = { epoch: lastRow.epoch, seq: lastRow.seq };
    if (newestGain) {
      const { gain, row } = newestGain;
      setXpNotice({ key: `${row.epoch}:${row.seq}`, leveledUp: gain.leveledUp, xp: gain.xp, levelAfter: gain.levelAfter });
      void onCharacterRefresh().catch(() => {});
    }
    const deathRow = sessionState.recentEvents.find((row) => {
      const event = record(row.event);
      return event?.['type'] === 'heroDied' && event['actorId'] === actorId;
    });
    const deathSeq = deathRow ? `${deathRow.epoch}:${deathRow.seq}` : null;
    if (deathSeq !== null && processedDeathSeq.current !== deathSeq) {
      processedDeathSeq.current = deathSeq;
      void onCharacterRefresh().catch(() => {});
    }
    if (sessionState.closed && !processedTerminal.current) {
      processedTerminal.current = true;
      setTerminalOutcome(String(sessionState.closed.outcome));
      setCurrent(null);
      void onCharacterRefresh().catch(() => {});
    }
  }, [actorId, current?.instanceId, onCharacterRefresh, refreshCurrent, riskExit, sessionState]);

  const submit = useCallback((command: LiveJson): string => {
    if (!session || !canCommand) {
      setNotice({ kind: 'error', key: 'ui.live.reconnect' });
      return '';
    }
    const liveState = session.state;
    if (!liveState.attached) {
      setNotice({ kind: 'pending', key: 'ui.live.waiting_attach' });
      return '';
    }
    if (liveState.pendingCount > 0) {
      setNotice({ kind: 'pending', key: 'ui.live.wait_confirm' });
      return '';
    }
    try {
      const commandId = session.submit(command);
      pendingCommand.current = commandId;
      setNotice({ kind: 'pending', key: 'ui.live.waiting_confirmation' });
      return commandId;
    } catch (error) {
      setNotice({ kind: 'error', key: 'ui.live.error_code', params: { error: codeText(errorMessage(error)) } });
      return '';
    }
  }, [canCommand, session]);

  const begin = useCallback(async () => {
    if (!options || !canCommand || startBusy) return;
    let request = pendingStart.current;
    if (!request) {
      request = { commandId: crypto.randomUUID(), actorId, areaId: selectedArea,
        supplies: Object.entries(selectedSupplies).filter(([, qty]) => qty > 0).map(([item, qty]) => ({ item, qty })) };
      pendingStart.current = request;
    }
    setStartBusy(true);
    setStartError(null);
    try {
      const started = await startLive(api, request);
      pendingStart.current = null;
      // Starting the live activity is already confirmed even if refreshing the durable character fails.
      void onCharacterRefresh().catch(() => {});
      const fresh = await refreshCurrent(true);
      if (fresh === undefined) {
        setCurrentError({ key: 'ui.live.started_no_view', params: { id: started.instanceId } });
      }
    } catch (error) {
      setStartError({ code: errorMessage(error), sameCommand: true });
    } finally {
      if (mounted.current) setStartBusy(false);
    }
  }, [actorId, api, canCommand, onCharacterRefresh, options, refreshCurrent, selectedArea, selectedSupplies, startBusy]);

  const retryPending = useCallback(() => {
    if (!canCommand || !sessionState?.attached || !session) return;
    session.retryPending();
    setNotice({ kind: 'pending', key: 'ui.live.retrying' });
  }, [canCommand, session, sessionState?.attached]);

  const cancelRisk = useCallback(() => { setRisk(null); setRiskExit(null); riskRequestCursor.current = null; }, []);
  const newAdventure = useCallback(() => {
    setCurrent(null);
    setCurrentError(null);
    setServerView(null);
    setSession(null);
    setSessionState(null);
    setOptions(null);
    setSelectedSupplies({});
    setStartBusy(false);
    setStartError(null);
    setNotice(null);
    setRisk(null);
    setRiskExit(null);
    riskRequestCursor.current = null;
    setTerminalOutcome(null);
    pendingStart.current = null;
    pendingCommand.current = null;
    processedAck.current = null;
    combatStartCursor.current = null;
    processedTerminal.current = false;
    processedDeathSeq.current = null;
    processedXpCursor.current = null;
    setXpNotice(null);
    sessionSnapshotSeen.current = false;
    void load();
  }, [load]);
  const requestBossRisk = useCallback((exitId: string) => {
    const state = session?.state;
    setRisk(null);
    setRiskExit(exitId);
    riskRequestCursor.current = state && state.epoch !== null && state.seq !== null
      ? { epoch: state.epoch, seq: state.seq } : null;
    if (!submit({ type: 'enterBossRoom', exitId, confirm: false })) {
      setRiskExit(null);
      riskRequestCursor.current = null;
    }
  }, [session, submit]);
  const confirmRisk = useCallback(() => {
    const exitId = riskExit;
    if (!risk || !exitId || !canCommand) return;
    const commandId = submit({ type: 'enterBossRoom', exitId, confirm: true });
    if (commandId) cancelRisk();
  }, [canCommand, cancelRisk, risk, riskExit, submit]);

  const view = project(sessionState?.view ?? serverView);
  const exploring = view?.phase === 'exploring';
  const busy = (sessionState?.pendingCount ?? 0) > 0;
  const readyForActions = canCommand && Boolean(sessionState?.attached);
  const combatConnection = sessionState?.attached ? sessionState.connection
    : live.state.status === 'open' ? { ...live.state, status: 'connecting' as const } : live.state;

  return <section className="screen live-screen" aria-labelledby="live-screen-title">
    <a className="back-link" href="#/world">{t('ui.live.back')}</a>
    <div className="live-screen__heading">
      <h1 className="screen__title" id="live-screen-title">{t('ui.live.title')}</h1>
      <p className="screen__subtitle">{t('ui.live.subtitle')}</p>
    </div>

    {loadState === 'loading' && <p className="muted" role="status">{t('ui.live.loading')}</p>}
    {loadState === 'error' && <div role="alert"><p>{t('ui.live.load_failed', { error: startError ? codeText(startError.code) : '' })}</p><button type="button" className="button" onClick={() => void load()}>{t('ui.common.retry')}</button></div>}

    {loadState === 'ready' && !current && !currentError && !terminalOutcome && options && <EntryForm options={options} selectedArea={selectedArea}
      setSelectedArea={(area) => { pendingStart.current = null; setSelectedArea(area); }} supplies={selectedSupplies}
      setSupply={(item, qty) => { pendingStart.current = null; setSelectedSupplies((value) => ({ ...value, [item]: qty })); }}
      disabled={!canCommand || startBusy} busy={startBusy} error={startError ? `${codeText(startError.code)}${startError.sameCommand ? ` · ${t('ui.live.retry_same_note')}` : ''}` : null} onStart={() => void begin()} onRetry={() => void begin()} />}

    {current && <>
      <div className="live-screen__connection" role="status" aria-live="polite">
        {!canCommand && <span>{t('ui.live.connection_unavailable')}</span>}
        {sessionState?.attached && <span>{t('ui.live.connected')}</span>}
        {sessionState?.error && <span>{t('ui.live.session_error', { error: codeText(sessionState.error) })}</span>}
        {currentError && <span>{t('ui.live.host_view_error', { error: liveErrorText(currentError) })}</span>}
      </div>
      {view && <>
        {view.phase === 'combat' && <LiveCombat view={sessionState?.view ?? serverView ?? {}} events={sessionState?.recentEvents ?? sessionState?.events ?? []}
          actorId={actorId} pendingCommandIds={sessionState?.pendingCommandIds ?? []}
          connection={combatConnection} onSubmit={submit} />}

        <section className="live-scene" aria-labelledby="live-scene-title">
          <h2 id="live-scene-title">{view.location ? displayLabel(view.location) : t('ui.live.current_location')}</h2>
          <p className="live-scene__area">{t('ui.live.area', { area: view.area ? displayLabel(view.area) : t('ui.live.unknown') })}</p>
          <SceneViewport locationId={view.location} />
          <div className="live-scene__actors" aria-label={t('ui.live.party_status')}>
            {(view.heroes ?? []).map((hero) => <p key={hero.actorId}>
              <span>{hero.actorId === actorId ? t('ui.common.you') : isUuid(hero.actorId) ? t('ui.common.party_member') : displayLabel(hero.actorId)}</span>
              <span>{hero.present ? t('ui.live.hero_hp', { hp: hero.hp === null ? hero.maxHp : hero.hp ?? t('ui.live.unknown'), max: hero.maxHp }) : t('ui.live.not_present')}</span>
            </p>)}
            {(() => {
              const me = view.heroes?.find((hero) => hero.actorId === actorId);
              if (!me || me.level === undefined) return null;
              return <p className="live-scene__xp">
                <span>{t('ui.live.level', { level: me.level })}</span>
                <span>{me.xpToNext === null || me.xpToNext === undefined ? t('ui.live.max_level') : t('ui.live.xp_progress', { xp: me.xpIntoLevel ?? 0, next: me.xpToNext })}</span>
              </p>;
            })()}
          </div>
          {xpNotice && <p className={`live-xp-notice${xpNotice.leveledUp ? ' live-xp-notice--level-up' : ''}`} role="status" aria-live="polite">{xpNotice.leveledUp && xpNotice.levelAfter !== undefined ? t('ui.live.xp_level_up', { xp: xpNotice.xp, level: xpNotice.levelAfter }) : t('ui.live.xp_gain', { xp: xpNotice.xp })}</p>}
          {exploring && <div className="live-scene__actions">
            <h3>{t('ui.live.actions')}</h3>
            {(view.groups ?? []).filter((group) => !group.defeated).map((group) => <button key={group.id} className="button live-action" type="button"
              disabled={!readyForActions || busy} onClick={() => submit({ type: 'engage', groupId: group.id })}>
              {t(group.boss ? 'ui.live.engage_boss' : 'ui.live.engage', { enemies: group.enemies.map(displayLabel).join(', ') })}
            </button>)}
            {(view.exits ?? []).map((exit) => exit.bossRoom ? <button key={exit.id} className="button live-action" type="button"
              disabled={!readyForActions || busy || !exit.open || exit.visited}
              onClick={() => requestBossRisk(exit.id)}>
              {t(exit.open ? 'ui.live.boss_review' : 'ui.live.boss_locked', { to: displayLabel(exit.to) })}
              {!exit.open && exit.reasons.length > 0 && <small>{exit.reasons.map(displayLabel).join(', ')}</small>}
            </button> : <button key={exit.id} className="button live-action" type="button" disabled={!readyForActions || busy || !exit.open}
              onClick={() => submit({ type: 'travel', exitId: exit.id })}>
              {t(exit.open ? 'ui.live.travel' : 'ui.live.route_locked', { to: displayLabel(exit.to) })}
              {!exit.open && exit.reasons.length > 0 && <small>{exit.reasons.map(displayLabel).join(', ')}</small>}
            </button>)}
            {(view.hotspots ?? []).map((hotspot) => <button key={hotspot.id} className="button live-action" type="button"
              disabled={!readyForActions || busy || hotspot.done} onClick={() => submit({ type: 'interact', hotspotId: hotspot.id })}>
              {hotspot.id.startsWith('corpse:') ? t('ui.live.recover_corpse') : t('ui.live.interact', { name: displayLabel(hotspot.textKey) })}
              {hotspot.done && <small>{t('ui.live.already_done')}</small>}
            </button>)}
          </div>}
          {(view.groups?.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-groups-title">
            <h3 id="live-groups-title">{t('ui.live.groups')}</h3><ul>{view.groups?.map((group) => <li key={group.id}>{t('ui.live.group_line', { name: displayLabel(group.id.replace(/\/\d+$/, '')), state: group.defeated ? t('ui.live.defeated') : group.enemies.map(displayLabel).join(', ') })}</li>)}</ul>
          </section>}
          {(view.resources?.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-resources-title">
            <h3 id="live-resources-title">{t('ui.live.resources')}</h3>{view.resources?.map((resource) => <button className="button live-action" type="button" key={resource.nodeId}
              disabled={!exploring || !readyForActions || busy || resource.gathered} onClick={() => submit({ type: 'gather', nodeId: resource.nodeId })}>
              {displayLabel(resource.resource)} · {resource.gathered ? t('ui.live.gathered') : t('ui.live.gather')}
            </button>)}
          </section>}
          {exploring && (view.heroes?.find((hero) => hero.actorId === actorId)?.consumables.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-supplies-title">
            <h3 id="live-supplies-title">{t('ui.live.supplies')}</h3>
            {view.heroes?.find((hero) => hero.actorId === actorId)?.consumables.map((item) => <button className="button live-action" type="button" key={item.item}
              disabled={!readyForActions || busy || item.qty <= 0} onClick={() => submit({ type: 'useConsumable', itemId: item.item })}>
              {t('ui.live.use_stock', { name: displayLabel(item.item), qty: item.qty })}
            </button>)}
          </section>}
          <section className="live-scene__section" aria-labelledby="live-runbag-title">
            <h3 id="live-runbag-title">{t('ui.live.run_bag')}</h3>
            <RunBag bags={view.runBag ?? []} actorId={actorId} />
          </section>
          {exploring && <button type="button" className="button live-return" disabled={!readyForActions || busy || !view.canReturn}
            onClick={() => submit({ type: 'returnToSanctuary' })}>
            {view.canReturn ? t('ui.live.return') : t('ui.live.return_unavailable')}
          </button>}
        </section>
      </>}
      {sessionState?.pendingCount ? <div className="live-action-status" role="status" aria-live="polite">
        <p>{notice ? t(notice.key, notice.params) : t('ui.live.action_sent')}</p>
        {canCommand && sessionState.attached && <button type="button" className="button button--secondary" onClick={retryPending}>{t('ui.live.retry_pending')}</button>}
      </div> : notice && <p className={`live-action-status live-action-status--${notice.kind}`} role={notice.kind === 'rejected' || notice.kind === 'error' ? 'alert' : 'status'}>{t(notice.key, notice.params)}</p>}
    </>}

    {terminalOutcome !== null && <div className="live-terminal" role="status"><h2>{t('ui.live.ended', { outcome: codeText(terminalOutcome) })}</h2><p>{t('ui.live.ended_note')}</p>
      {!current && <button type="button" className="button" onClick={newAdventure}>{t('ui.live.new_adventure')}</button>}
    </div>}
    {risk && riskExit && <div className="live-risk-dialog-backdrop">
      <section className="live-risk-dialog" role="alertdialog" aria-modal="true" aria-labelledby="live-risk-dialog-title" aria-describedby="live-risk-dialog-description">
        <h2 id="live-risk-dialog-title">{t('ui.live.risk_title')}</h2>
        <p id="live-risk-dialog-description">{t('ui.live.risk_description')}</p>
        <ProvisionalLiveRiskNotice risk={risk} actorId={actorId} />
        <div className="live-risk-dialog__actions">
          <button type="button" className="button button--secondary" onClick={cancelRisk}>{t('ui.common.cancel')}</button>
          <button type="button" className="button" disabled={!readyForActions || busy} onClick={confirmRisk}>{t('ui.live.confirm_entry')}</button>
        </div>
      </section>
    </div>}
    {currentError && !current && terminalOutcome === null && <div role="alert"><p>{t('ui.live.attach_failed', { error: liveErrorText(currentError) })}</p><button type="button" className="button" onClick={() => void refreshCurrent(true)}>{t('ui.live.retry_connection')}</button></div>}
    <DeathPanel actorId={actorId} api={api} live={live} />
  </section>;
}

function EntryForm({ options, selectedArea, setSelectedArea, supplies, setSupply, disabled, busy, error, onStart, onRetry }: {
  options: LiveOptionsDto; selectedArea: string; setSelectedArea: (value: string) => void;
  supplies: Record<string, number>; setSupply: (item: string, qty: number) => void;
  disabled: boolean; busy: boolean; error: string | null; onStart: () => void; onRetry: () => void;
}) {
  return <section className="live-entry" aria-labelledby="live-entry-title">
    <h2 id="live-entry-title">{t('ui.live.entry_title')}</h2>
    <p>{t('ui.live.entry_intro')}</p>
    {options.areas.length === 0 ? <p className="muted">{t('ui.live.entry_no_areas')}</p> : <label className="live-entry__field">
      <span>{t('ui.live.entry_area')}</span><select value={selectedArea} disabled={disabled} onChange={(event) => setSelectedArea(event.currentTarget.value)}>
        {options.areas.map((area) => <option key={area.id} value={area.id}>{displayLabel(area.label)}</option>)}
      </select>
    </label>}
    {options.supplies.length > 0 && <fieldset className="live-entry__supplies" disabled={disabled}>
      <legend>{t('ui.live.entry_supplies')}</legend>
      {options.supplies.map((supply) => <label key={supply.item} className="live-entry__supply">
        <span>{displayLabel(supply.label)} <small>{t('ui.live.entry_available', { qty: supply.availableQty })}</small></span>
        <input aria-label={t('ui.live.entry_quantity', { name: displayLabel(supply.label) })} type="number" min="0" max={supply.availableQty} step="1"
          value={supplies[supply.item] ?? 0} onChange={(event) => setSupply(supply.item, clampInt(event.currentTarget.value, supply.availableQty))} />
      </label>)}
    </fieldset>}
    {error && <div role="alert"><p>{t('ui.live.entry_failed', { error })}</p><button type="button" className="button button--secondary" disabled={busy} onClick={onRetry}>{t('ui.live.entry_retry')}</button></div>}
    <button type="button" className="button live-entry__start" disabled={disabled || options.areas.length === 0 || !selectedArea} onClick={onStart}>
      {busy ? t('ui.live.entry_starting') : t('ui.live.entry_start')}
    </button>
    {disabled && <p className="muted">{t('ui.live.entry_reconnect')}</p>}
  </section>;
}

function RunBag({ bags, actorId }: { bags: Snapshot['runBag']; actorId: string }) {
  if (bags === undefined) return <p className="muted">{t('ui.live.bag_waiting')}</p>;
  const bag = bags?.find((value) => value.actorId === actorId);
  if (!bag) return <p>{t('ui.live.bag_empty')}</p>;
  const totalStacks = bag.items.reduce((sum, item) => sum + item.qty, 0);
  return <div><p>{t('ui.live.bag_summary', { items: totalStacks, gold: bag.gold, uniques: (bag.uniques ?? []).length })}</p>
    {(bag.items.length > 0 || (bag.uniques?.length ?? 0) > 0) && <ul>
      {bag.items.map((item) => <li key={item.item}>{displayLabel(item.item)} ×{item.qty}</li>)}
      {(bag.uniques ?? []).map((item) => <li key={item.itemId}>{displayLabel(item.definition)}</li>)}
    </ul>}
  </div>;
}

function project(value: LiveViewDto | null): Snapshot | null {
  if (!value) return null;
  const source = record(value);
  return source as unknown as Snapshot | null;
}
function isSessionClient(value: LiveConnection): value is LiveConnection & LiveSessionClient {
  return typeof value.sendFrame === 'function' && typeof value.subscribeFrames === 'function';
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function errorMessage(value: unknown): string {
  return value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code : value instanceof Error ? value.message : 'unknown error';
}
function clampInt(value: string, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, parsed)) : 0;
}
function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value); }
