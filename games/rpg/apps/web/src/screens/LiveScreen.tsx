import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveBossRiskDto, LiveCurrentResponseDto, LiveJson, LiveOptionsDto, LiveStartRequestDto, LiveViewDto } from '@rpg/protocol';
import type { ApiClient } from '../api/http.ts';
import type { LiveConnection } from '../app/services.ts';
import { currentLive, liveOptions, startLive } from '../live/api.ts';
import { LiveSession } from '../live/session.ts';
import type { LiveSessionClient, LiveSessionState } from '../live/session.ts';
import { DeathPanel, ProvisionalLiveRiskNotice } from './character/DeathPanel.tsx';
import { LiveCombat } from '../live/combat/LiveCombat.tsx';

type Props = {
  actorId: string;
  api: ApiClient;
  live: LiveConnection;
  canCommand: boolean;
  onCharacterRefresh: () => Promise<void>;
};

type LoadState = 'loading' | 'ready' | 'error';
type Notice = { readonly kind: 'pending' | 'confirmed' | 'rejected' | 'error'; readonly text: string } | null;
type Snapshot = {
  readonly phase?: string;
  readonly area?: string;
  readonly location?: string;
  readonly heroes?: readonly { readonly actorId: string; readonly hp: number | null; readonly maxHp: number; readonly present: boolean; readonly consumables: readonly { readonly item: string; readonly qty: number }[] }[];
  readonly groups?: readonly { readonly id: string; readonly enemies: readonly string[]; readonly boss: boolean; readonly defeated: boolean }[];
  readonly exits?: readonly { readonly id: string; readonly to: string; readonly open: boolean; readonly reasons: readonly string[]; readonly bossRoom: boolean; readonly visited: boolean }[];
  readonly hotspots?: readonly { readonly id: string; readonly type: string; readonly textKey: string; readonly done: boolean }[];
  readonly resources?: readonly { readonly nodeId: string; readonly resource: string; readonly gathered: boolean }[];
  readonly canReturn?: boolean;
  readonly runBag?: readonly { readonly actorId: string; readonly items: readonly { readonly item: string; readonly qty: number }[]; readonly gold: number; readonly uniques?: readonly { readonly itemId: string; readonly definition: string }[] }[];
};

/** Interim DOM live adventure entry and scene surface. All scene facts come from the current host view. */
export function LiveScreen({ actorId, api, live, canCommand, onCharacterRefresh }: Props) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [options, setOptions] = useState<LiveOptionsDto | null>(null);
  const [current, setCurrent] = useState<LiveCurrentResponseDto['current']>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState('');
  const [selectedSupplies, setSelectedSupplies] = useState<Record<string, number>>({});
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [sessionState, setSessionState] = useState<LiveSessionState | null>(null);
  const [serverView, setServerView] = useState<LiveViewDto | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [risk, setRisk] = useState<LiveBossRiskDto | null>(null);
  const [riskExit, setRiskExit] = useState<string | null>(null);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const pendingStart = useRef<LiveStartRequestDto | null>(null);
  const pendingCommand = useRef<string | null>(null);
  const processedAck = useRef<string | null>(null);
  const refreshedCursor = useRef<string | null>(null);
  const processedTerminal = useRef(false);
  const processedDeathSeq = useRef<string | null>(null);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);

  const refreshCurrent = useCallback(async (showError = false) => {
    const sequence = ++refreshSequence.current;
    try {
      const response = await currentLive(api, actorId);
      if (!mounted.current || sequence !== refreshSequence.current) return response.current;
      setCurrent(response.current);
      setCurrentError(null);
      setServerView(response.current?.view ?? null);
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
      setCurrentError(null);
      if (!active.current) {
        const serverOptions = await liveOptions(api, actorId);
        if (!mounted.current) return;
        setOptions(serverOptions);
        setSelectedArea((value) => value || serverOptions.areas[0]?.id || '');
      }
      setLoadState('ready');
    } catch (error) {
      if (!mounted.current) return;
      setLoadState('error');
      setStartError(errorMessage(error));
    }
  }, [api, actorId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useEffect(() => {
    if (!current) { setSession(null); setSessionState(null); return; }
    if (!isSessionClient(live)) {
      setCurrentError('The live socket cannot attach to this adventure.');
      return;
    }
    const next = new LiveSession({ client: live, instanceId: current.instanceId, actorId });
    setSession(next);
    const unsubscribe = next.subscribe(setSessionState);
    return () => { unsubscribe(); next.dispose(); };
  }, [actorId, current?.instanceId, live]);

  useEffect(() => {
    if (!sessionState) return;
    // The socket supplies events and combat telemetry. The host view remains the only scene/outcome projection.
    const cursor = sessionState.epoch === null || sessionState.seq === null ? null : `${sessionState.epoch}:${sessionState.seq}`;
    if (cursor !== null && refreshedCursor.current !== cursor) {
      refreshedCursor.current = cursor;
      void refreshCurrent();
    }
    const newestWarning = [...sessionState.events].reverse().find((row) => {
      const event = record(row.event);
      return event?.['type'] === 'bossRoomWarning' && typeof event['exitId'] === 'string';
    });
    if (newestWarning) {
      const event = record(newestWarning.event);
      if (event && event['exitId'] === riskExit && 'risk' in event) setRisk(event['risk'] as unknown as LiveBossRiskDto);
    }
    if (sessionState.lastAck && sessionState.lastAck.commandId === pendingCommand.current && processedAck.current !== sessionState.lastAck.commandId) {
      processedAck.current = sessionState.lastAck.commandId;
      if (sessionState.lastAck.status === 'rejected') {
        setNotice({ kind: 'rejected', text: `The server rejected that action (${sessionState.lastAck.reason ?? 'unknown'}).` });
        pendingCommand.current = null;
      } else {
        setNotice({ kind: 'pending', text: 'The server accepted the action. Refreshing the authoritative scene…' });
        void refreshCurrent(true).then((fresh) => {
          if (fresh !== undefined && mounted.current) {
            setNotice({ kind: 'confirmed', text: 'The server confirmed the action and refreshed the scene.' });
            pendingCommand.current = null;
          } else if (mounted.current) setNotice({ kind: 'pending', text: 'The server acknowledged the action; waiting for the current host view.' });
        });
      }
    }
    const deathRow = sessionState.events.find((row) => {
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
      setTerminalMessage(`Adventure ended: ${sessionState.closed.outcome}.`);
      void refreshCurrent();
      void onCharacterRefresh().catch(() => {});
    }
  }, [actorId, onCharacterRefresh, refreshCurrent, riskExit, sessionState]);

  const submit = useCallback((command: LiveJson): string => {
    if (!session || !canCommand) {
      setNotice({ kind: 'error', text: 'Reconnect before sending a live action.' });
      return '';
    }
    if (!sessionState?.attached) {
      setNotice({ kind: 'pending', text: 'Waiting for the server to attach this live adventure.' });
      return '';
    }
    if (sessionState.pendingCount > 0) {
      setNotice({ kind: 'pending', text: 'Wait for the server to confirm the current action before sending another.' });
      return '';
    }
    try {
      const commandId = session.submit(command);
      pendingCommand.current = commandId;
      setNotice({ kind: 'pending', text: 'Waiting for server confirmation…' });
      return commandId;
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
      return '';
    }
  }, [canCommand, session, sessionState?.attached]);

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
      const fresh = await refreshCurrent(true);
      if (fresh === undefined) {
        setCurrentError(`Adventure ${started.instanceId} started, but its current view is not available yet. Retry to attach.`);
      }
    } catch (error) {
      setStartError(`${errorMessage(error)} · Retrying keeps the same start command ID.`);
    } finally {
      if (mounted.current) setStartBusy(false);
    }
  }, [actorId, api, canCommand, options, refreshCurrent, selectedArea, selectedSupplies, startBusy]);

  const retryPending = useCallback(() => {
    if (!canCommand || !sessionState?.attached || !session) return;
    session.retryPending();
    setNotice({ kind: 'pending', text: 'Retrying the unconfirmed action with its original command ID…' });
  }, [canCommand, session, sessionState?.attached]);

  const cancelRisk = useCallback(() => { setRisk(null); setRiskExit(null); }, []);
  const confirmRisk = useCallback(() => {
    const exitId = riskExit;
    if (!risk || !exitId || !canCommand) return;
    const commandId = submit({ type: 'enterBossRoom', exitId, confirm: true });
    if (commandId) cancelRisk();
  }, [canCommand, cancelRisk, risk, riskExit, submit]);

  const view = project(serverView ?? sessionState?.view ?? null);
  const exploring = view?.phase === 'exploring';
  const busy = (sessionState?.pendingCount ?? 0) > 0;
  const readyForActions = canCommand && Boolean(sessionState?.attached);
  const combatConnection = sessionState?.attached ? sessionState.connection
    : live.state.status === 'open' ? { ...live.state, status: 'connecting' as const } : live.state;

  return <section className="screen live-screen" aria-labelledby="live-screen-title">
    <div className="live-screen__heading">
      <h1 className="screen__title" id="live-screen-title">Live adventure</h1>
      <p className="screen__subtitle">Server-run exploration · actions need an active connection</p>
    </div>

    {loadState === 'loading' && <p className="muted" role="status">Loading live options…</p>}
    {loadState === 'error' && <div role="alert"><p>Could not load live adventure data ({startError}).</p><button type="button" className="button" onClick={() => void load()}>Retry</button></div>}

    {loadState === 'ready' && !current && !currentError && !terminalMessage && options && <EntryForm options={options} selectedArea={selectedArea}
      setSelectedArea={(area) => { pendingStart.current = null; setSelectedArea(area); }} supplies={selectedSupplies}
      setSupply={(item, qty) => { pendingStart.current = null; setSelectedSupplies((value) => ({ ...value, [item]: qty })); }}
      disabled={!canCommand || startBusy} busy={startBusy} error={startError} onStart={() => void begin()} onRetry={() => void begin()} />}

    {current && <>
      <div className="live-screen__connection" role="status" aria-live="polite">
        {!canCommand && <span>Connection unavailable. New actions are disabled; unconfirmed actions remain queued.</span>}
        {sessionState?.attached && <span>Connected to live adventure</span>}
        {sessionState?.error && <span>Live session: {sessionState.error}</span>}
        {currentError && <span>Current host view: {currentError}</span>}
      </div>
      {view && <>
        {view.phase === 'combat' && <LiveCombat view={serverView ?? sessionState?.view ?? {}} events={sessionState?.events ?? []}
          actorId={actorId} pendingCommandIds={sessionState?.pendingCommandIds ?? []} lastAck={sessionState?.lastAck ?? null}
          connection={combatConnection} onSubmit={submit} />}

        <section className="live-scene" aria-labelledby="live-scene-title">
          <h2 id="live-scene-title">{view.location ?? 'Current location'}</h2>
          <p className="live-scene__area">Area: {view.area ?? 'Unknown'}</p>
          <div className="live-scene__actors" aria-label="Party status">
            {(view.heroes ?? []).map((hero) => <p key={hero.actorId}>
              <span>{hero.actorId === actorId ? 'You' : hero.actorId}</span>
              <span>{hero.present ? `${hero.hp ?? 'Unknown'} / ${hero.maxHp} HP` : 'Not present'}</span>
            </p>)}
          </div>
          {exploring && <div className="live-scene__actions">
            <h3>Actions</h3>
            {(view.groups ?? []).filter((group) => !group.defeated).map((group) => <button key={group.id} className="button live-action" type="button"
              disabled={!readyForActions || busy} onClick={() => submit({ type: 'engage', groupId: group.id })}>
              Engage {group.boss ? 'boss ' : ''}group: {group.enemies.join(', ')}
            </button>)}
            {(view.exits ?? []).map((exit) => exit.bossRoom ? <button key={exit.id} className="button live-action" type="button"
              disabled={!readyForActions || busy || !exit.open || exit.visited}
              onClick={() => { setRiskExit(exit.id); submit({ type: 'enterBossRoom', exitId: exit.id, confirm: false }); }}>
              {exit.open ? `Review boss room risk: ${exit.to}` : `Locked boss room: ${exit.to}`}
              {!exit.open && exit.reasons.length > 0 && <small>{exit.reasons.join(', ')}</small>}
            </button> : <button key={exit.id} className="button live-action" type="button" disabled={!readyForActions || busy || !exit.open}
              onClick={() => submit({ type: 'travel', exitId: exit.id })}>
              {exit.open ? `Travel to ${exit.to}` : `Locked route to ${exit.to}`}
              {!exit.open && exit.reasons.length > 0 && <small>{exit.reasons.join(', ')}</small>}
            </button>)}
            {(view.hotspots ?? []).map((hotspot) => <button key={hotspot.id} className="button live-action" type="button"
              disabled={!readyForActions || busy || hotspot.done} onClick={() => submit({ type: 'interact', hotspotId: hotspot.id })}>
              {hotspot.id.startsWith('corpse:') ? 'Recover your corpse' : `Interact: ${hotspot.textKey}`}
              {hotspot.done && <small>Already completed</small>}
            </button>)}
          </div>}
          {(view.groups?.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-groups-title">
            <h3 id="live-groups-title">Groups</h3><ul>{view.groups?.map((group) => <li key={group.id}>{group.id}: {group.defeated ? 'defeated' : group.enemies.join(', ')}</li>)}</ul>
          </section>}
          {(view.resources?.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-resources-title">
            <h3 id="live-resources-title">Resources</h3>{view.resources?.map((resource) => <button className="button live-action" type="button" key={resource.nodeId}
              disabled={!exploring || !readyForActions || busy || resource.gathered} onClick={() => submit({ type: 'gather', nodeId: resource.nodeId })}>
              {resource.resource} · {resource.gathered ? 'gathered' : 'Gather resource'}
            </button>)}
          </section>}
          {exploring && (view.heroes?.find((hero) => hero.actorId === actorId)?.consumables.length ?? 0) > 0 && <section className="live-scene__section" aria-labelledby="live-supplies-title">
            <h3 id="live-supplies-title">Live supplies</h3>
            {view.heroes?.find((hero) => hero.actorId === actorId)?.consumables.map((item) => <button className="button live-action" type="button" key={item.item}
              disabled={!readyForActions || busy || item.qty <= 0} onClick={() => submit({ type: 'useConsumable', itemId: item.item })}>
              Use {item.item} · stock {item.qty}
            </button>)}
          </section>}
          <section className="live-scene__section" aria-labelledby="live-runbag-title">
            <h3 id="live-runbag-title">Run bag</h3>
            <RunBag bags={view.runBag ?? []} actorId={actorId} />
          </section>
          {exploring && <button type="button" className="button live-return" disabled={!readyForActions || busy || !view.canReturn}
            onClick={() => submit({ type: 'returnToSanctuary' })}>
            {view.canReturn ? 'Return to Sanctuary' : 'Return unavailable here'}
          </button>}
        </section>
      </>}
      {sessionState?.pendingCount ? <div className="live-action-status" role="status" aria-live="polite">
        <p>{notice?.text ?? 'Action sent; waiting for server confirmation.'}</p>
        {canCommand && sessionState.attached && <button type="button" className="button button--secondary" onClick={retryPending}>Retry pending action</button>}
      </div> : notice && <p className={`live-action-status live-action-status--${notice.kind}`} role={notice.kind === 'rejected' || notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    </>}

    {terminalMessage && <div className="live-terminal" role="status"><h2>{terminalMessage}</h2><p>Your durable character and death record are refreshed below.</p></div>}
    {risk && riskExit && <div className="live-risk-dialog-backdrop">
      <section className="live-risk-dialog" role="alertdialog" aria-modal="true" aria-labelledby="live-risk-dialog-title" aria-describedby="live-risk-dialog-description">
        <h2 id="live-risk-dialog-title">Boss room risk</h2>
        <p id="live-risk-dialog-description">The server sent this risk summary. Review it before explicitly entering.</p>
        <ProvisionalLiveRiskNotice risk={risk} />
        <div className="live-risk-dialog__actions">
          <button type="button" className="button button--secondary" onClick={cancelRisk}>Cancel</button>
          <button type="button" className="button" disabled={!readyForActions || busy} onClick={confirmRisk}>Confirm entry</button>
        </div>
      </section>
    </div>}
    {currentError && !current && !terminalMessage && <div role="alert"><p>Could not attach to the live adventure ({currentError}).</p><button type="button" className="button" onClick={() => void refreshCurrent(true)}>Retry connection</button></div>}
    <DeathPanel actorId={actorId} api={api} live={live} />
  </section>;
}

function EntryForm({ options, selectedArea, setSelectedArea, supplies, setSupply, disabled, busy, error, onStart, onRetry }: {
  options: LiveOptionsDto; selectedArea: string; setSelectedArea: (value: string) => void;
  supplies: Record<string, number>; setSupply: (item: string, qty: number) => void;
  disabled: boolean; busy: boolean; error: string | null; onStart: () => void; onRetry: () => void;
}) {
  return <section className="live-entry" aria-labelledby="live-entry-title">
    <h2 id="live-entry-title">Start a solo adventure</h2>
    <p>Choose an available area and supplies. The server sets your starting location and adventure state.</p>
    {options.areas.length === 0 ? <p className="muted">No live areas are currently available.</p> : <label className="live-entry__field">
      <span>Area</span><select value={selectedArea} disabled={disabled} onChange={(event) => setSelectedArea(event.currentTarget.value)}>
        {options.areas.map((area) => <option key={area.id} value={area.id}>{area.label}</option>)}
      </select>
    </label>}
    {options.supplies.length > 0 && <fieldset className="live-entry__supplies" disabled={disabled}>
      <legend>Supplies</legend>
      {options.supplies.map((supply) => <label key={supply.item} className="live-entry__supply">
        <span>{supply.label} <small>Available: {supply.availableQty}</small></span>
        <input aria-label={`${supply.label} quantity`} type="number" min="0" max={supply.availableQty} step="1"
          value={supplies[supply.item] ?? 0} onChange={(event) => setSupply(supply.item, clampInt(event.currentTarget.value, supply.availableQty))} />
      </label>)}
    </fieldset>}
    {error && <div role="alert"><p>Could not start or resume ({error}).</p><button type="button" className="button button--secondary" disabled={busy} onClick={onRetry}>Retry same start</button></div>}
    <button type="button" className="button live-entry__start" disabled={disabled || options.areas.length === 0 || !selectedArea} onClick={onStart}>
      {busy ? 'Starting adventure…' : 'Start live adventure'}
    </button>
    {disabled && <p className="muted">Reconnect before starting an adventure.</p>}
  </section>;
}

function RunBag({ bags, actorId }: { bags: Snapshot['runBag']; actorId: string }) {
  const bag = bags?.find((value) => value.actorId === actorId);
  if (!bag) return <p className="muted">No run bag projection yet.</p>;
  const totalStacks = bag.items.reduce((sum, item) => sum + item.qty, 0);
  return <div><p>{totalStacks} item(s) · {bag.gold} gold · {(bag.uniques ?? []).length} unique item(s)</p>
    {(bag.items.length > 0 || (bag.uniques?.length ?? 0) > 0) && <ul>
      {bag.items.map((item) => <li key={item.item}>{item.item} ×{item.qty}</li>)}
      {(bag.uniques ?? []).map((item) => <li key={item.itemId}>{item.definition}</li>)}
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
