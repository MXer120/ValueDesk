/**
 * /status - is ValueDesk up? Public, no wallet, no terms to accept first.
 *
 * One card: the headline (all operational, degraded, down), then each service -
 * the website, the data API, the copy & algo executor, the indexer - with its
 * state now and a bar for each of the last 90 UTC days (statusData.ts dayBar:
 * green up, amber degraded, orange some minutes down, red a tenth or more down,
 * grey no data). Read again every minute while the tab is visible.
 *
 * When the status service does not answer (server 1 down), the page says so and
 * shows what this browser could check itself: the executor's own health.
 */
import { useCallback, useEffect, useState } from 'react';
import { openFeedback } from '../feedback/FeedbackButton';
import {
  OVERALL_TEXT, SERVICE_LINE, STATE_TEXT, dayBar, fmtUptime, loadStatus, overallOf,
  type ServiceState, type StatusView,
} from './statusData';
import './status.css';

const REFRESH_MS = 60_000;

function useStatus(): { view: StatusView | null; loading: boolean; reload: () => void } {
  const [view, setView] = useState<StatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    void loadStatus().then((v) => {
      setView(v);
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    reload();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);
  return { view, loading, reload };
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function StatePill({ state }: { state: ServiceState }) {
  return (
    <span className={`st-pill is-${state}`}>
      <i aria-hidden="true" />
      {STATE_TEXT[state]}
    </span>
  );
}

export function StatusPage() {
  const { view, loading, reload } = useStatus();
  const now = Date.now();
  const overall = view?.kind === 'report' ? overallOf(view.report.services.map((s) => s.state)) : view ? 'outage' : null;

  return (
    <main className="st" aria-busy={loading}>
      <article className="st-card">
        <header className="st-head">
          <h1 className="st-title">Status</h1>
          <span className="st-updated">
            {view ? `Updated ${time(view.kind === 'report' ? view.report.at : view.at)}` : 'Checking…'}
            <button type="button" className="st-refresh" onClick={reload} disabled={loading} aria-label="Check again" title="Check again">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </span>
        </header>

        {overall && (
          <div className={`st-banner is-${view?.kind === 'unreachable' ? 'unreachable' : overall}`} role="status">
            <b>{view?.kind === 'unreachable' ? 'The status service is unreachable' : OVERALL_TEXT[overall]}</b>
            {view?.kind === 'unreachable' && (
              <span>
                It runs with the data API, so that is likely down too. Leaderboards, cohorts and news may not load. What your
                browser could check by itself is below.
              </span>
            )}
          </div>
        )}

        {view?.kind === 'report' && (
          <ul className="st-list">
            {view.report.services.map((s) => (
              <li key={s.id} className="st-svc">
                <div className="st-svc__head">
                  <div className="st-svc__name">
                    <b>{s.name}</b>
                    <small>{SERVICE_LINE[s.id]}</small>
                  </div>
                  <div className="st-svc__now">
                    <StatePill state={s.state} />
                    {s.latencyMs !== null && s.state !== 'unknown' && <small className="st-ms">{s.latencyMs} ms</small>}
                  </div>
                </div>
                <div className="st-bars" role="img" aria-label={`${s.name}: ${fmtUptime(s.uptime)} uptime over the last ${s.days.length} days`}>
                  {s.days.map((d) => {
                    const b = dayBar(d, now);
                    return <span key={d[0]} className={`st-bar is-${b.tone}`} title={b.title} />;
                  })}
                </div>
                <div className="st-scale" aria-hidden="true">
                  <span>{s.days.length} days ago</span>
                  <span className="st-scale__pct">{fmtUptime(s.uptime)} uptime</span>
                  <span>Today</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {view?.kind === 'unreachable' && (
          <ul className="st-list">
            <li className="st-svc">
              <div className="st-svc__head">
                <div className="st-svc__name"><b>Website</b><small>You are viewing it</small></div>
                <div className="st-svc__now"><StatePill state="up" /></div>
              </div>
            </li>
            <li className="st-svc">
              <div className="st-svc__head">
                <div className="st-svc__name"><b>Data API</b><small>{SERVICE_LINE.api}</small></div>
                <div className="st-svc__now"><StatePill state="down" /></div>
              </div>
            </li>
            <li className="st-svc">
              <div className="st-svc__head">
                <div className="st-svc__name">
                  <b>Copy &amp; algo executor</b>
                  <small>Checked from your browser at {time(view.executor.at)}</small>
                </div>
                <div className="st-svc__now">
                  <StatePill state={view.executor.state} />
                  {view.executor.ms !== null && view.executor.state !== 'down' && <small className="st-ms">{view.executor.ms} ms</small>}
                </div>
              </div>
            </li>
          </ul>
        )}

        <footer className="st-foot">
          <div className="st-legend" aria-hidden="true">
            <span><i className="st-bar is-up" />Up</span>
            <span><i className="st-bar is-degraded" />Degraded</span>
            <span><i className="st-bar is-partial" />Partly down</span>
            <span><i className="st-bar is-down" />Down</span>
            <span><i className="st-bar is-nodata" />No data</span>
          </div>
          <p>
            Checked every minute from our data server in France; a day is in UTC. Something broken that this page does not show?{' '}
            <button type="button" className="st-link" onClick={() => openFeedback()}>Send feedback</button>
          </p>
        </footer>
      </article>
    </main>
  );
}
