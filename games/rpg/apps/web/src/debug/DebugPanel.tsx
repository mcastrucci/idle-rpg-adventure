import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { describeError } from '../app/useGameSession.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { ApiClient } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import { displayLabel } from '../content/labels.ts';
import { getInventory } from '../inventory/api.ts';
import { codeText, formatNumber, t, useLocale } from '../i18n/index.ts';
import {
  ADVANCE_STEPS_MS, advanceClockCommand, conquerAreaCommand, DEBUG_LIMITS, grantCommand, probeDebugClock, resetWorldCommand,
  sendDebugCommand, setProgressionCommand,
} from './api.ts';
import type { DebugClockDto } from './api.ts';
import type { PlaytestCapture } from './usePlaytestCapture.ts';

interface Props {
  readonly character: CharacterDto | null;
  readonly api: ApiClient;
  readonly clock: DebugClockDto;
  readonly onClose: () => void;
  /** Reloads the character, inventory and world views from the server. */
  readonly onChanged: () => void;
  readonly capture: PlaytestCapture;
  readonly onCaptureStart: () => void;
  readonly onCaptureFinish: () => void;
  readonly onCaptureClear: () => void;
}

interface Outcome { readonly ok: boolean; readonly code: string }
interface Choice { readonly id: string; readonly label: string }

const ADVANCE_LABELS: Readonly<Record<number, string>> = {
  [ADVANCE_STEPS_MS[0]]: 'ui.debug.advance_15m', [ADVANCE_STEPS_MS[1]]: 'ui.debug.advance_1h', [ADVANCE_STEPS_MS[2]]: 'ui.debug.advance_3h',
};

/** Digits only; empty or malformed input is `null` so a button cannot send a made-up number. */
function parseInteger(text: string, min: number, max: number): number | null {
  if (!/^\d{1,16}$/.test(text.trim())) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** Staging "god mode" tools. Each action sends one fresh command and shows the server's code; nothing is computed here. */
export function DebugPanel({ character, api, clock: initialClock, onClose, onChanged, capture, onCaptureStart, onCaptureFinish, onCaptureClear }: Props) {
  useLocale();
  const actorId = character?.actorId ?? null;
  const [clock, setClock] = useState(initialClock);
  const [areas, setAreas] = useState<readonly Choice[]>([]);
  const [items, setItems] = useState<readonly Choice[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [area, setArea] = useState('');
  const [level, setLevel] = useState('');
  const [xp, setXp] = useState('0');
  const [gold, setGold] = useState('');
  const [item, setItem] = useState('');
  const [qty, setQty] = useState('1');

  useEffect(() => {
    if (!actorId) return;
    let cancelled = false;
    void api.getWorldView(actorId).then((view) => {
      if (!cancelled) setAreas(view.areas.map((entry) => ({ id: entry.id, label: displayLabel(entry.label) })));
    }).catch(() => { /* The pickers stay empty; the server remains the authority. */ });
    void getInventory(api, actorId).then((snapshot) => {
      if (!cancelled) setItems(snapshot.catalog.items.map((entry) => ({ id: entry.id, label: displayLabel(entry.nameKey ?? entry.id) })));
    }).catch(() => { /* Same as above. */ });
    return () => { cancelled = true; };
  }, [actorId, api]);

  const run = useCallback(async (request: CommandRequest<unknown>, afterwards?: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      await sendDebugCommand(api, request);
      setOutcome({ ok: true, code: 'ok' });
      if (afterwards) await afterwards();
      onChanged();
    } catch (error) {
      setOutcome({ ok: false, code: describeError(error) });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [api, onChanged]);

  const advance = (durationMs: number) => {
    void run(advanceClockCommand(durationMs), async () => {
      const next = await probeDebugClock(api);
      if (next) setClock(next);
    });
  };

  const levelValue = parseInteger(level, DEBUG_LIMITS.level.min, DEBUG_LIMITS.level.max);
  const xpValue = parseInteger(xp, DEBUG_LIMITS.xp.min, DEBUG_LIMITS.xp.max);
  const goldValue = parseInteger(gold, DEBUG_LIMITS.gold.min, DEBUG_LIMITS.gold.max);
  const qtyValue = parseInteger(qty, DEBUG_LIMITS.qty.min, DEBUG_LIMITS.qty.max);
  const disabled = busy || actorId === null;
  const submit = (action: () => void) => (event: FormEvent) => { event.preventDefault(); action(); };
  const captureJson = capture.exportJson;

  return (
    <section className="debug-panel" role="dialog" aria-modal="true" aria-labelledby="debug-title">
      <div className="debug-panel__head">
        <h2 id="debug-title" className="debug-panel__title">{t('ui.debug.title')}</h2>
        <button type="button" className="button button--secondary debug-panel__close" onClick={onClose}>{t('ui.common.close')}</button>
      </div>
      <p className="debug-panel__badge">{t('ui.debug.staging_only')}</p>
      {!actorId && <p className="muted">{t('ui.debug.need_character')}</p>}

      <div className="debug-panel__result" role="status" aria-live="polite">
        {outcome && (outcome.ok
          ? <span className="debug-panel__ok">{t('ui.debug.result_ok')}</span>
          : <span className="form__error">{t('ui.debug.result_error', { message: codeText(outcome.code), code: outcome.code })}</span>)}
      </div>

      <fieldset className="debug-group">
        <legend>{t('ui.debug.world_title')}</legend>
        <form className="form" onSubmit={submit(() => { if (actorId && area) void run(conquerAreaCommand(actorId, area)); })}>
          <label className="form__label" htmlFor="debug-area">{t('ui.debug.area')}</label>
          <select id="debug-area" className="form__input" value={area} onChange={(event) => setArea(event.target.value)}>
            <option value="">{t('ui.debug.choose')}</option>
            {areas.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <button type="submit" className="button" disabled={disabled || !area}>{t('ui.debug.conquer')}</button>
          <button type="button" className="button button--secondary" disabled={disabled || !area}
            onClick={() => { if (actorId && area) void run(resetWorldCommand(actorId, area)); }}>{t('ui.debug.reset_area')}</button>
          <button type="button" className="button button--secondary" disabled={disabled}
            onClick={() => { if (actorId) void run(resetWorldCommand(actorId)); }}>{t('ui.debug.reset_all')}</button>
        </form>
      </fieldset>

      <fieldset className="debug-group">
        <legend>{t('ui.debug.progression_title')}</legend>
        <form className="form" onSubmit={submit(() => { if (actorId && levelValue !== null && xpValue !== null) void run(setProgressionCommand(actorId, levelValue, xpValue)); })}>
          <label className="form__label" htmlFor="debug-level">{t('ui.debug.level', { min: DEBUG_LIMITS.level.min, max: formatNumber(DEBUG_LIMITS.level.max) })}</label>
          <input id="debug-level" className="form__input" type="number" inputMode="numeric" min={DEBUG_LIMITS.level.min} max={DEBUG_LIMITS.level.max}
            step={1} value={level} onChange={(event) => setLevel(event.target.value)} />
          <label className="form__label" htmlFor="debug-xp">{t('ui.debug.xp')}</label>
          <input id="debug-xp" className="form__input" type="number" inputMode="numeric" min={DEBUG_LIMITS.xp.min} max={DEBUG_LIMITS.xp.max}
            step={1} value={xp} onChange={(event) => setXp(event.target.value)} />
          <button type="submit" className="button" disabled={disabled || levelValue === null || xpValue === null}>{t('ui.debug.set_progression')}</button>
        </form>
      </fieldset>

      <fieldset className="debug-group">
        <legend>{t('ui.debug.grants_title')}</legend>
        <form className="form" onSubmit={submit(() => { if (actorId && goldValue !== null) void run(grantCommand(actorId, { gold: goldValue })); })}>
          <label className="form__label" htmlFor="debug-gold">{t('ui.debug.gold', { max: formatNumber(DEBUG_LIMITS.gold.max) })}</label>
          <input id="debug-gold" className="form__input" type="number" inputMode="numeric" min={DEBUG_LIMITS.gold.min} max={DEBUG_LIMITS.gold.max}
            step={1} value={gold} onChange={(event) => setGold(event.target.value)} />
          <button type="submit" className="button" disabled={disabled || goldValue === null}>{t('ui.debug.grant_gold')}</button>
        </form>
        <form className="form" onSubmit={submit(() => { if (actorId && item && qtyValue !== null) void run(grantCommand(actorId, { items: [{ item, qty: qtyValue }] })); })}>
          <label className="form__label" htmlFor="debug-item">{t('ui.debug.item')}</label>
          <select id="debug-item" className="form__input" value={item} onChange={(event) => setItem(event.target.value)}>
            <option value="">{t('ui.debug.choose')}</option>
            {items.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <label className="form__label" htmlFor="debug-qty">{t('ui.debug.qty', { max: formatNumber(DEBUG_LIMITS.qty.max) })}</label>
          <input id="debug-qty" className="form__input" type="number" inputMode="numeric" min={DEBUG_LIMITS.qty.min} max={DEBUG_LIMITS.qty.max}
            step={1} value={qty} onChange={(event) => setQty(event.target.value)} />
          <button type="submit" className="button" disabled={disabled || !item || qtyValue === null}>{t('ui.debug.grant_item')}</button>
        </form>
      </fieldset>

      <fieldset className="debug-group debug-group--clock">
        <legend>{t('ui.debug.clock_title')}</legend>
        <p className="debug-panel__warning" role="note">{t('ui.debug.clock_warning')}</p>
        <p className="muted">{t('ui.debug.clock_offset', { offset: formatDuration(clock.offsetMs) })}</p>
        <div className="debug-steps">
          {ADVANCE_STEPS_MS.map((step) => (
            <button key={step} type="button" className="button button--secondary" onClick={() => advance(step)}
              disabled={busy || step > clock.maxAdvanceMs || clock.offsetMs + step > clock.maxOffsetMs}>{t(ADVANCE_LABELS[step] ?? '')}</button>
          ))}
        </div>
      </fieldset>

      <fieldset className="debug-group">
        <legend>{t('ui.debug.capture_title')}</legend>
        <p className="muted">{t('ui.debug.capture_note')}</p>
        <p role="status">{t(`ui.debug.capture_${capture.status}`)}{capture.reason ? `: ${capture.reason}` : ''} · {capture.count}</p>
        {capture.status === 'idle' || capture.status === 'complete' || capture.status === 'incomplete'
          ? <button type="button" className="button" disabled={!actorId || busy} onClick={onCaptureStart}>{t('ui.debug.capture_start')}</button>
          : <button type="button" className="button button--secondary" disabled={capture.status !== 'recording'} onClick={onCaptureFinish}>{t('ui.debug.capture_finish')}</button>}
        {captureJson && <button type="button" className="button button--secondary" onClick={() => downloadCapture(captureJson)}>{t('ui.debug.capture_download')}</button>}
        {captureJson && <button type="button" className="button button--secondary" onClick={onCaptureClear}>{t('ui.debug.capture_clear')}</button>}
      </fieldset>
    </section>
  );
}

function downloadCapture(json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'matriarch-playtest-capture.json'; anchor.click();
  URL.revokeObjectURL(url);
}

/** `1 d 2 h 15 min` style duration built from the server's offset; formatting only. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [days ? `${days} ${t('ui.debug.unit_d')}` : '', hours ? `${hours} ${t('ui.debug.unit_h')}` : '', `${minutes} ${t('ui.debug.unit_min')}`];
  return parts.filter(Boolean).join(' ');
}
