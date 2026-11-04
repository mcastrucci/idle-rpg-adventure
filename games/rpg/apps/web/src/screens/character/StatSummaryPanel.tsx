import { useEffect, useState } from 'react';
import type { InventorySnapshotDto, StatSummaryDto, StatSummaryRowDto } from '@rpg/protocol';

import type { ApiClient } from '../../api/http.ts';
import type { CharacterDto } from '../../api/types.ts';
import { displayLabel } from '../../content/labels.ts';
import { getInventory } from '../../inventory/api.ts';
import { isImprovement, summaryChange, summaryLabel, summaryValue } from '../../character/statSummary.ts';

type State = { readonly phase: 'loading' } | { readonly phase: 'error' } | { readonly phase: 'unavailable' } |
  { readonly phase: 'ready'; readonly summary: StatSummaryDto };

/**
 * Base / gear / total per stat, with a per-item breakdown on tap. Read-only server projection (`statSummary` of the
 * inventory snapshot): the totals are computed by the same helper as the combat snapshot, so the client never
 * re-derives them and cannot drift from what combat uses.
 */
export function StatSummaryPanel({ character, api }: { character: CharacterDto; api: ApiClient }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    void getInventory(api, character.actorId).then((snapshot: InventorySnapshotDto) => {
      if (!cancelled) setState(snapshot.statSummary ? { phase: 'ready', summary: snapshot.statSummary } : { phase: 'unavailable' });
    }).catch(() => {
      if (!cancelled) setState({ phase: 'error' });
    });
    return () => { cancelled = true; };
  }, [api, character.actorId, character.version, character.level, attempt]);

  return (
    <section className="character-section" aria-labelledby="stat-summary-title">
      <h2 id="stat-summary-title" className="screen__subtitle">Stat summary</h2>
      {state.phase === 'loading' && <p className="muted" role="status">Loading stats…</p>}
      {state.phase === 'error' && (
        <div role="alert">
          <p>Could not load the stat summary.</p>
          <button type="button" className="button button--secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      )}
      {state.phase === 'unavailable' && <p className="muted">The stat summary is unavailable while equipped gear has unsupported rolls.</p>}
      {state.phase === 'ready' && <SummaryTable summary={state.summary} />}
    </section>
  );
}

function SummaryTable({ summary }: { summary: StatSummaryDto }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const itemName = (itemId: string): string => {
    const item = summary.items.find((entry) => entry.itemId === itemId);
    return item ? displayLabel(item.nameKey ?? item.definition) : 'Unknown item';
  };
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  return (
    <>
      <p className="muted character-note">
        Level {summary.level}.{' '}
        {summary.items.length === 0 ? 'No gear equipped.' : `Gear: ${summary.items.map((item) => displayLabel(item.nameKey ?? item.definition)).join(', ')}.`}
        {' '}Totals match what combat uses. Provisional formulas.
      </p>
      <table className="stat-summary">
        <caption className="visually-hidden">Base, gear and total value of each stat</caption>
        <thead>
          <tr><th scope="col">Stat</th><th scope="col">Base</th><th scope="col">Gear</th><th scope="col">Total</th></tr>
        </thead>
        <tbody>
          {summary.rows.map((row) => (
            <StatRow key={row.key} row={row} expanded={open.has(row.key)} onToggle={() => toggle(row.key)} itemName={itemName} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function StatRow({ row, expanded, onToggle, itemName }: {
  row: StatSummaryRowDto; expanded: boolean; onToggle: () => void; itemName: (itemId: string) => string;
}) {
  const label = summaryLabel(row.key);
  const expandable = row.contributions.length > 0;
  const tone = row.equipment === 0 ? '' : isImprovement(row.key, row.equipment) ? ' delta--up' : ' delta--down';
  const detailId = `stat-summary-${row.key}`;
  return (
    <>
      <tr data-stat={row.key}>
        <th scope="row">
          {expandable ? (
            <button type="button" className="stat-summary__toggle" aria-expanded={expanded} aria-controls={detailId}
              aria-label={`${label}: base ${summaryValue(row.key, row.base)}, gear ${summaryChange(row.key, row.equipment)}, total ${summaryValue(row.key, row.total)}. Gear breakdown`}
              onClick={onToggle}>
              <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {label}
            </button>
          ) : label}
        </th>
        <td>{summaryValue(row.key, row.base)}</td>
        <td className={`delta${tone}`}>{summaryChange(row.key, row.equipment)}</td>
        <td className="stat-summary__total">{summaryValue(row.key, row.total)}</td>
      </tr>
      {expandable && expanded && (
        <tr className="stat-summary__detail" id={detailId}>
          <td colSpan={4}>
            <ul aria-label={`${label} from gear`}>
              {row.contributions.map((entry) => (
                <li key={entry.itemId}>
                  <span>{itemName(entry.itemId)}</span>
                  <span className={`delta${isImprovement(row.key, entry.value) ? ' delta--up' : ' delta--down'}`}>{summaryChange(row.key, entry.value)}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
