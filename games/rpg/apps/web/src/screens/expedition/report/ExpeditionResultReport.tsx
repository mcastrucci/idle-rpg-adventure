import type { ExpeditionResultReportDto } from '@rpg/protocol';
import type { ReactNode } from 'react';

import './expedition-result-report.css';

interface Props {
  readonly report: ExpeditionResultReportDto | null | undefined;
  readonly state: 'completed' | 'cancelled';
}

/** Player-facing view of the server's persisted report. It never derives settlement or reward values. */
export function ExpeditionResultReport({ report, state }: Props) {
  const title = state === 'cancelled' ? 'Expedition cancelled' : 'Expedition completed';
  if (!report || report.availability === 'legacy_unavailable') {
    return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
      <h2 id="expedition-result-title" className="screen__subtitle">{title}</h2>
      <p className="muted">This expedition has no saved result report. Its rewards, events, and final state are unavailable.</p>
    </section>;
  }

  if (report.availability === 'returned_escrow') {
    return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
      <h2 id="expedition-result-title" className="screen__subtitle">Expedition ended</h2>
      <p>{report.outcome === 'version_unavailable'
        ? 'The saved expedition version was unavailable. The server returned the escrow; no rewards or XP were settled.'
        : 'The server returned the expedition escrow. No rewards or XP were settled.'}</p>
      <dl className="expedition-result__facts">
        <Fact label="Effective duration" value={formatDuration(report.effectiveDurationMs)} />
        <Fact label="Final character state" value="Unavailable" />
      </dl>
    </section>;
  }

  const outcome = report.outcome ? humanize(report.outcome) : 'Unavailable';
  return <section className="expedition-result" role="region" aria-labelledby="expedition-result-title">
    <div className="expedition-result__header">
      <h2 id="expedition-result-title" className="screen__subtitle">{title}</h2>
      <span className="expedition-result__outcome">{outcome}</span>
    </div>
    {state === 'cancelled' && <p className="muted">This is a partial result settled through the server's revealed cutoff.</p>}
    <dl className="expedition-result__facts">
      <Fact label="Effective duration" value={formatDuration(report.effectiveDurationMs)} />
      <Fact label="Enemies defeated" value={formatCount(report.enemiesDefeated)} />
      <Fact label="XP earned" value={formatCount(report.xp.earned)} />
      <Fact label="XP penalty lost" value={formatCount(report.xp.penaltyLost)} />
      <Fact label="Net XP" value={formatSigned(report.xp.net)} />
      <Fact label="Gold earned" value={formatCount(report.gold.earned)} />
      <Fact label="Gold lost" value={formatCount(report.gold.lost)} />
      <Fact label="Gold secured" value={formatCount(report.gold.secured)} />
      <Fact label="Final health" value={formatPair(report.finalState.hp, report.finalState.maxHp)} />
      <Fact label="Final total XP" value={formatCount(report.finalState.xpTotal)} />
    </dl>
    <p className="expedition-result__xp-note">XP total before: {formatCount(report.xp.beforeTotal)} · after: {formatCount(report.xp.afterTotal)}</p>

    <ReportList title="Loot" unavailable={report.loot === null} empty="No loot recorded">
      {report.loot?.map((item) => <li key={item.item}>
        <strong>{humanize(item.item)}</strong>
        <span>Earned {item.earned} · lost {item.lost} · secured {item.secured}</span>
      </li>)}
    </ReportList>

    <ReportList title="Consumables" unavailable={report.consumables === null} empty="No consumables recorded">
      {report.consumables?.map((item) => <li key={item.item}>
        <strong>{humanize(item.item)}</strong>
        <span>Used {formatCount(item.used)} · returned {formatCount(item.returned)}</span>
      </li>)}
    </ReportList>

    <ReportList title="Notable events" unavailable={report.events === null} empty="No notable events recorded">
      {report.events?.map((event, index) => <li key={`${index}-${event}`}>{event}</li>)}
    </ReportList>

    {report.death && <section className="expedition-result__death" aria-labelledby="expedition-death-title">
      <h3 id="expedition-death-title">Death record</h3>
      {report.death.causes.length === 0 ? <p>No specific cause details were recorded.</p>
        : <ul>{report.death.causes.map((cause, index) => <li key={`${cause.key}-${index}`}>{describeCause(cause)}</li>)}</ul>}
      {report.death.suggestions.length > 0 && <>
        <h4>What may help next time</h4>
        <ul>{report.death.suggestions.map((suggestion, index) => <li key={`${index}-${suggestion}`}>{suggestion}</li>)}</ul>
      </>}
    </section>}
    {!report.death && report.outcome === 'failed' && <section className="expedition-result__death" aria-labelledby="expedition-death-title">
      <h3 id="expedition-death-title">Death record</h3>
      <p>Death cause details are not available in the saved report.</p>
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
    {unavailable ? <p className="muted">Not available in the saved report.</p>
      : hasChildren ? <ul>{children}</ul> : <p className="muted">{empty}</p>}
  </section>;
}

function humanize(value: string): string {
  const withoutNamespace = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return withoutNamespace.replaceAll('_', ' ').replaceAll('.', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describeCause(cause: NonNullable<ExpeditionResultReportDto['death']>['causes'][number]): string {
  const key = humanize(cause.key.replace(/^idle\.death\./, ''));
  const details = [cause.enemy && `Enemy: ${humanize(cause.enemy)}`, cause.skill && `Skill: ${humanize(cause.skill)}`,
    cause.amount !== undefined && `Damage: ${cause.amount}`, cause.count !== undefined && `Count: ${cause.count}`,
    cause.crit === true && 'Critical hit'].filter(Boolean);
  return details.length ? `${key} — ${details.join(' · ')}` : key;
}

function formatCount(value: number | null): string { return value === null ? 'Not available' : new Intl.NumberFormat().format(value); }
function formatSigned(value: number | null): string { return value === null ? 'Not available' : `${value > 0 ? '+' : ''}${new Intl.NumberFormat().format(value)}`; }
function formatPair(value: number | null, max: number | null): string { return value === null || max === null ? 'Not available' : `${value} / ${max}`; }
function formatDuration(value: number | null): string {
  if (value === null) return 'Not available';
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} sec` : `${seconds} sec`;
}
