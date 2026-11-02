import type { EstimateRangeDto, ExpeditionEstimateDto } from '@rpg/protocol';

import { displayId } from '../../content/labels.ts';
import { formatBp } from '../../rules/describe.ts';

export type EstimateState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous: ExpeditionEstimateDto | null }
  | { readonly status: 'ready'; readonly estimate: ExpeditionEstimateDto }
  | { readonly status: 'error'; readonly error: string };

/** "p50 (p10–p90)": the median with its 80 % range; a single number when the range is flat. */
export function formatRange(range: EstimateRangeDto): string {
  return range.p10 === range.p90 ? String(range.p50) : `${range.p50} (${range.p10}–${range.p90})`;
}

/**
 * Estimate card (ui-mobile §2, concept §6.3): server Monte Carlo figures, always labelled as an estimate. The client
 * only displays them; nothing here is computed from game rules.
 */
export function EstimateCard({ state, onRetry }: { state: EstimateState; onRetry: () => void }) {
  const estimate = state.status === 'ready' ? state.estimate : state.status === 'loading' ? state.previous : null;
  return <section className="estimate-card" aria-labelledby="estimate-title" aria-busy={state.status === 'loading'}>
    <div className="estimate-card__head">
      <h3 id="estimate-title">Estimated outcome</h3>
      <span className="estimate-card__badge">Estimate</span>
    </div>
    {state.status === 'idle' && <p className="muted">Choose an activity to see an estimate.</p>}
    {state.status === 'loading' && <p className="muted" role="status">Estimating…</p>}
    {state.status === 'error' && <div role="alert"><p className="form__error">Could not estimate this expedition ({state.error}).</p>
      <button type="button" className="button button--secondary" onClick={onRetry}>Retry estimate</button></div>}
    {estimate && <div className={state.status === 'loading' ? 'estimate-card__body estimate-card__body--stale' : 'estimate-card__body'}>
      <dl className="estimate-card__grid">
        <div><dt>XP</dt><dd>{formatRange(estimate.xp)}</dd></div>
        <div><dt>Gold</dt><dd>{formatRange(estimate.gold)}</dd></div>
        {estimate.consumablesUsed.length === 0
          ? <div><dt>Potions</dt><dd>None brought</dd></div>
          : estimate.consumablesUsed.map((row) => <div key={row.item}><dt>{displayId(row.item)} used</dt><dd>{formatRange(row)}</dd></div>)}
        <div><dt>Death chance</dt><dd>{formatBp(estimate.outcomeRatesBp.died)}</dd></div>
        {estimate.outcomeRatesBp.retreated > 0 && <div><dt>Retreat chance</dt><dd>{formatBp(estimate.outcomeRatesBp.retreated)}</dd></div>}
      </dl>
      <p className="muted estimate-card__note">Estimate from {estimate.n} simulated runs: median with the likely range (10th–90th percentile). Not a guarantee; XP is before any death penalty.</p>
    </div>}
  </section>;
}
