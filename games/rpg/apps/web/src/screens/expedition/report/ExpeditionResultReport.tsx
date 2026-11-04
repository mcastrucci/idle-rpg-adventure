import type { ExpeditionResultReportDto } from '@rpg/protocol';
import type { ReactNode } from 'react';

import { labelOrHumanized } from '../../../content/labels.ts';
import { formatNumber, t } from '../../../i18n/index.ts';
import { eventLine, renderReportCode, suggestionLine } from './serverText.ts';

import './expedition-result-report.css';

interface Props {
  readonly report: ExpeditionResultReportDto | null | undefined;
  readonly state: 'completed' | 'cancelled';
}

/** Player-facing view of the server's persisted report. It never derives settlement or reward values. */
export function ExpeditionResultReport({ report, state }: Props) {
  const title = state === 'cancelled' ? t('ui.report.title_cancelled') : t('ui.report.title_completed');
  if (!report || report.availability === 'legacy_unavailable') {
    return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
      <h2 id="expedition-result-title" className="screen__subtitle">{title}</h2>
      <p className="muted">{t('ui.report.legacy')}</p>
    </section>;
  }

  if (report.availability === 'returned_escrow') {
    return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
      <h2 id="expedition-result-title" className="screen__subtitle">{t('ui.report.title_ended')}</h2>
      <p>{report.outcome === 'version_unavailable' ? t('ui.report.escrow_version') : t('ui.report.escrow_returned')}</p>
      <dl className="expedition-result__facts">
        <Fact label={t('ui.report.fact_duration')} value={formatDuration(report.effectiveDurationMs)} />
        <Fact label={t('ui.report.fact_final_state')} value={t('ui.report.unavailable')} />
      </dl>
    </section>;
  }

  const outcome = report.outcome ? outcomeLabel(report.outcome) : t('ui.report.unavailable');
  return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
    <div className="expedition-result__header">
      <h2 id="expedition-result-title" className="screen__subtitle">{title}</h2>
      <span className="expedition-result__outcome">{outcome}</span>
    </div>
    {state === 'cancelled' && <p className="muted">{t('ui.report.partial')}</p>}
    <dl className="expedition-result__facts">
      <Fact label={t('ui.report.fact_duration')} value={formatDuration(report.effectiveDurationMs)} />
      <Fact label={t('ui.report.fact_enemies')} value={formatCount(report.enemiesDefeated)} />
      <Fact label={t('ui.report.fact_xp_earned')} value={formatCount(report.xp.earned)} />
      <Fact label={t('ui.report.fact_xp_penalty')} value={formatCount(report.xp.penaltyLost)} />
      <Fact label={t('ui.report.fact_xp_net')} value={formatSigned(report.xp.net)} />
      <Fact label={t('ui.report.fact_gold_earned')} value={formatCount(report.gold.earned)} />
      <Fact label={t('ui.report.fact_gold_lost')} value={formatCount(report.gold.lost)} />
      <Fact label={t('ui.report.fact_gold_secured')} value={formatCount(report.gold.secured)} />
      <Fact label={t('ui.report.fact_health')} value={formatPair(report.finalState.hp, report.finalState.maxHp)} />
      <Fact label={t('ui.report.fact_total_xp')} value={formatCount(report.finalState.xpTotal)} />
    </dl>
    <p className="expedition-result__xp-note">{t('ui.report.xp_note', { before: formatCount(report.xp.beforeTotal), after: formatCount(report.xp.afterTotal) })}</p>

    <ReportList title={t('ui.report.loot')} unavailable={report.loot === null} empty={t('ui.report.loot_empty')}>
      {report.loot?.map((item) => <li key={item.item}>
        <strong>{labelOrHumanized(item.item)}</strong>
        <span>{t('ui.report.loot_line', { earned: item.earned, lost: item.lost, secured: item.secured })}</span>
      </li>)}
    </ReportList>

    <ReportList title={t('ui.report.consumables')} unavailable={report.consumables === null} empty={t('ui.report.consumables_empty')}>
      {report.consumables?.map((item) => <li key={item.item}>
        <strong>{labelOrHumanized(item.item)}</strong>
        <span>{t('ui.report.consumable_line', { used: formatCount(item.used), returned: formatCount(item.returned) })}</span>
      </li>)}
    </ReportList>

    <ReportList title={t('ui.report.events')} unavailable={report.events === null} empty={t('ui.report.events_empty')}>
      {report.events?.map((event, index) => <li key={`${index}-${event}`}>{eventLine(event, report.eventCodes?.[index])}</li>)}
    </ReportList>

    {report.death && <section className="expedition-result__death" aria-labelledby="expedition-death-title">
      <h3 id="expedition-death-title">{t('ui.report.death_title')}</h3>
      {report.death.causes.length === 0 ? <p>{t('ui.report.death_no_causes')}</p>
        : <ul>{report.death.causes.map((cause, index) => <li key={`${cause.key}-${index}`}>{describeCause(cause)}</li>)}</ul>}
      {report.death.suggestions.length > 0 && <>
        <h4>{t('ui.report.death_suggestions')}</h4>
        <ul>{report.death.suggestions.map((suggestion, index) => <li key={`${index}-${suggestion}`}>{suggestionLine(suggestion, report.death?.suggestionCodes?.[index])}</li>)}</ul>
      </>}
    </section>}
    {!report.death && report.outcome === 'failed' && <section className="expedition-result__death" aria-labelledby="expedition-death-title">
      <h3 id="expedition-death-title">{t('ui.report.death_title')}</h3>
      <p>{t('ui.report.death_unavailable')}</p>
    </section>}
  </section>;
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ReportList({ title, unavailable, empty, children }: {
  readonly title: string;
  readonly unavailable: boolean;
  readonly empty: string;
  readonly children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : children !== null && children !== undefined;
  return <section className="expedition-result__list" aria-label={title}>
    <h3>{title}</h3>
    {unavailable ? <p className="muted">{t('ui.report.not_in_report')}</p>
      : hasChildren ? <ul>{children}</ul> : <p className="muted">{empty}</p>}
  </section>;
}

const OUTCOME_KEYS: Readonly<Record<string, string>> = {
  completed: 'ui.report.outcome.completed',
  retreated: 'ui.report.outcome.retreated',
  failed: 'ui.report.outcome.failed',
  cancelled: 'ui.report.outcome.cancelled',
  version_unavailable: 'ui.report.outcome.version_unavailable',
};

function outcomeLabel(outcome: string): string {
  const key = OUTCOME_KEYS[outcome];
  return key === undefined ? labelOrHumanized(outcome) : t(key);
}

function describeCause(cause: NonNullable<ExpeditionResultReportDto['death']>['causes'][number]): string {
  // A known cause code renders as a full sentence with its fields as params; otherwise fall back to name + detail list.
  const params: Record<string, string | number> = {};
  for (const name of ['enemy', 'skill', 'amount', 'count'] as const) {
    const value = cause[name];
    if (value !== undefined) params[name] = value;
  }
  const sentence = renderReportCode({ code: cause.key, params });
  if (sentence !== undefined) return cause.crit === true ? `${sentence} (${t('ui.report.cause_crit')})` : sentence;
  const key = labelOrHumanized(cause.key.replace(/^idle\.death\./, '').replaceAll('.', ' '));
  const details = [cause.enemy && t('ui.report.cause_enemy', { name: labelOrHumanized(cause.enemy) }),
    cause.skill && t('ui.report.cause_skill', { name: labelOrHumanized(cause.skill) }),
    cause.amount !== undefined && t('ui.report.cause_damage', { amount: cause.amount }),
    cause.count !== undefined && t('ui.report.cause_count', { count: cause.count }),
    cause.crit === true && t('ui.report.cause_crit')].filter(Boolean);
  return details.length ? `${key} — ${details.join(' · ')}` : key;
}

function formatCount(value: number | null): string { return value === null ? t('ui.common.not_available') : formatNumber(value); }
function formatSigned(value: number | null): string { return value === null ? t('ui.common.not_available') : `${value > 0 ? '+' : ''}${formatNumber(value)}`; }
function formatPair(value: number | null, max: number | null): string { return value === null || max === null ? t('ui.common.not_available') : `${value} / ${max}`; }
function formatDuration(value: number | null): string {
  if (value === null) return t('ui.common.not_available');
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? t('ui.report.duration_min_sec', { minutes, seconds }) : t('ui.report.duration_sec', { seconds });
}
