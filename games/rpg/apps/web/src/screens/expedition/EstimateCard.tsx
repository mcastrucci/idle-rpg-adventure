import type { EstimateRangeDto, ExpeditionEstimateDto } from '@rpg/protocol';

import { displayId } from '../../content/labels.ts';
import { codeText, t } from '../../i18n/index.ts';
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
      <h3 id="estimate-title">{t('ui.estimate.title')}</h3>
      <span className="estimate-card__badge">{t('ui.estimate.badge')}</span>
    </div>
    {state.status === 'idle' && <p className="muted">{t('ui.estimate.idle')}</p>}
    {state.status === 'loading' && <p className="muted" role="status">{t('ui.estimate.loading')}</p>}
    {state.status === 'error' && <div role="alert"><p className="form__error">{t('ui.estimate.failed', { error: codeText(state.error) })}</p>
      <button type="button" className="button button--secondary" onClick={onRetry}>{t('ui.estimate.retry')}</button></div>}
    {estimate && <div className={state.status === 'loading' ? 'estimate-card__body estimate-card__body--stale' : 'estimate-card__body'}>
      <dl className="estimate-card__grid">
        <div><dt>{t('ui.estimate.xp')}</dt><dd>{formatRange(estimate.xp)}</dd></div>
        <div><dt>{t('ui.common.gold')}</dt><dd>{formatRange(estimate.gold)}</dd></div>
        {estimate.consumablesUsed.length === 0
          ? <div><dt>{t('ui.estimate.potions')}</dt><dd>{t('ui.estimate.none_brought')}</dd></div>
          : estimate.consumablesUsed.map((row) => <div key={row.item}><dt>{t('ui.estimate.used', { name: displayId(row.item) })}</dt><dd>{formatRange(row)}</dd></div>)}
        <div><dt>{t('ui.estimate.death_chance')}</dt><dd>{formatBp(estimate.outcomeRatesBp.died)}</dd></div>
        {estimate.outcomeRatesBp.retreated > 0 && <div><dt>{t('ui.estimate.retreat_chance')}</dt><dd>{formatBp(estimate.outcomeRatesBp.retreated)}</dd></div>}
      </dl>
      <p className="muted estimate-card__note">{t('ui.estimate.note', { n: estimate.n })}</p>
    </div>}
  </section>;
}
