/**
 * /status - is ValueDesk up? Public, no wallet, no terms to accept first.
 *
 * One card, the way common status pages are laid out:
 *   - the headline (all operational, degraded, down, maintenance) - or, while one is
 *     open, each open incident and maintenance in progress with its latest update;
 *   - scheduled maintenance still to come;
 *   - each service - the website, the data API, the copy & algo executor, the
 *     indexer - with its state now and a bar for each of the last 90 UTC days
 *     (green up, amber degraded, orange partly down, red down, blue maintenance,
 *     grey no data). Each bar tells its day on hover, focus (arrow keys move along
 *     the days) or a tap: the date, the uptime, the minutes down or degraded and
 *     that day's incidents and maintenance;
 *   - the incidents and maintenance of the last 90 days, each with its timeline.
 * Everything the owner wrote is shown as text (React escapes it), never as markup.
 * Read again every minute while the tab is visible.
 *
 * When the status service does not answer (server 1 down), the page says so and
 * shows what this browser could check itself: the executor's own health.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { openFeedback } from '../feedback/FeedbackButton';
import {
  OVERALL_SHOWN_TEXT, SERVICE_LINE, SHOWN_TEXT, STAGE_TEXT, componentNames, dayDetail, fmtUptime, fmtUtc, loadStatus,
  noticeKindText, noticeLive, noticePhase, noticeTimes, overallShown, shownState,
  type DayDetail, type Notice, type NoticePhase, type ShownState, type StatusView,
} from './statusData';
import './status.css';

const REFRESH_MS = 60_000;
const FEED_URL = '/api/vs/status/feed';

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

function StatePill({ state }: { state: ShownState }) {
  return (
    <span className={`st-pill is-${state}`}>
      <i aria-hidden="true" />
      {SHOWN_TEXT[state]}
    </span>
  );
}

const PHASE_TEXT: Record<NoticePhase, string> = {
  active: 'Open',
  resolved: 'Resolved',
  upcoming: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
};

/** One incident or maintenance: what, where, when, and its updates, newest first. */
export function NoticeCard({ n, now, open = false }: { n: Notice; now: number; open?: boolean }) {
  const phase = noticePhase(n, now);
  return (
    <article id={`notice-${n.id}`} className={`st-notice is-${n.kind === 'incident' ? n.impact : 'maintenance'}${open ? ' is-open' : ''}`}>
      <header className="st-notice__head">
        <b className="st-notice__title">{n.title}</b>
        <span className="st-chip">{noticeKindText(n)}</span>
        <span className={`st-notice__phase is-${phase}`}>{PHASE_TEXT[phase]}</span>
      </header>
      <p className="st-notice__meta">
        {componentNames(n)} · {noticeTimes(n, now)}
      </p>
      <ol className="st-timeline">
        {[...n.updates].reverse().map((u, i) => (
          <li key={`${u.at}-${i}`}>
            <b>{STAGE_TEXT[u.stage]}</b>
            {u.text && <span className="st-timeline__text">{u.text}</span>}
            <time dateTime={new Date(u.at).toISOString()}>{fmtUtc(u.at)}</time>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** The tooltip of one day bar. */
export function DayTip({ d, id, index, count }: { d: DayDetail; id?: string; index: number; count: number }) {
  // Kept inside the card near either end: anchored to the bar's side, not its middle.
  const edge = index < count * 0.15 ? 'is-start' : index > count * 0.85 ? 'is-end' : '';
  return (
    <div id={id} role="tooltip" aria-live="polite" className={`st-tip ${edge}`} style={{ left: `${((index + 0.5) / count) * 100}%` }}>
      <b>{d.date}</b>
      <span>{[d.uptime ?? 'No data', ...d.facts].join(' · ')}</span>
      {d.notices.map((x) => (
        <span key={x.id} className="st-tip__notice">
          <i aria-hidden="true" className={x.label === 'Maintenance' ? 'is-maintenance' : 'is-incident'} />
          <span>
            {x.label}: {x.title}
            <small>{x.times}</small>
          </span>
        </span>
      ))}
    </div>
  );
}

/** A service's 90 day bars, each with its day in a tooltip: hover, keyboard (arrows) or a tap. */
function DayBars({ days, label }: { days: DayDetail[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const last = days.length - 1;

  // A tap elsewhere closes the tooltip a tap opened.
  useEffect(() => {
    if (active === null) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [active]);

  const indexAt = (e: ReactPointerEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    return el ? Number(el.dataset.i) : null;
  };
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    const s = step[e.key];
    if (s === undefined) return;
    e.preventDefault();
    setActive((a) => Math.min(last, Math.max(0, (a ?? last) + s)));
  };

  return (
    <div className="st-bars-wrap" ref={wrap}>
      <div
        className="st-bars"
        role="group"
        tabIndex={0}
        aria-label={`${label}. Use the arrow keys to read each day.`}
        aria-describedby={active !== null ? tipId : undefined}
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse') return;
          const i = indexAt(e);
          if (i !== null) setActive(i);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse' && !e.currentTarget.matches(':focus-visible')) setActive(null);
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return;
          const i = indexAt(e);
          setActive((a) => (i === null || a === i ? null : i));
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) setActive((a) => a ?? last);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        {days.map((d, i) => (
          <span key={d.day} data-i={i} className={`st-bar is-${d.tone}${i === active ? ' is-active' : ''}`} />
        ))}
      </div>
      {active !== null && days[active] && <DayTip d={days[active]!} id={tipId} index={active} count={days.length} />}
    </div>
  );
}

export function StatusPage() {
  const { view, loading, reload } = useStatus();
  const now = Date.now();
  const report = view?.kind === 'report' ? view.report : null;
  const notices = report?.notices ?? [];
  const open = notices.filter((n) => noticeLive(n, now)).sort((a, b) => (a.kind === b.kind ? b.startsAt - a.startsAt : a.kind === 'incident' ? -1 : 1));
  const upcoming = notices.filter((n) => noticePhase(n, now) === 'upcoming').sort((a, b) => a.startsAt - b.startsAt);
  const past = notices.filter((n) => !open.includes(n) && !upcoming.includes(n));
  const states = report ? report.services.map((s) => shownState(s.state, s.id, notices, now)) : [];
  const overall = report ? overallShown(states) : view ? 'outage' : null;

  // A link to one notice (the app's banner, the feed) lands on it once it is drawn.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !report) return;
    scrolled.current = true;
    const id = window.location.hash.slice(1);
    if (/^notice-\d+$/.test(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [report]);

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

        {overall && !open.length && (
          <div className={`st-banner is-${view?.kind === 'unreachable' ? 'unreachable' : overall}`} role="status">
            <b>{view?.kind === 'unreachable' ? 'The status service is unreachable' : OVERALL_SHOWN_TEXT[overall]}</b>
            {view?.kind === 'unreachable' && (
              <span>
                It runs with the data API, so that is likely down too. Leaderboards, cohorts and news may not load. What your
                browser could check by itself is below.
              </span>
            )}
          </div>
        )}

        {open.length > 0 && (
          <section className="st-open" aria-label="Open incidents and maintenance">
            {open.map((n) => <NoticeCard key={n.id} n={n} now={now} open />)}
          </section>
        )}

        {upcoming.length > 0 && (
          <section className="st-section" aria-labelledby="st-upcoming">
            <h2 id="st-upcoming" className="st-h2">Scheduled maintenance</h2>
            {upcoming.map((n) => <NoticeCard key={n.id} n={n} now={now} />)}
          </section>
        )}

        {report && (
          <ul className="st-list">
            {report.services.map((s, i) => {
              const shown = states[i] ?? s.state;
              const days = s.days.map((d) => dayDetail(d, s.id, notices, now));
              return (
                <li key={s.id} className="st-svc">
                  <div className="st-svc__head">
                    <div className="st-svc__name">
                      <b>{s.name}</b>
                      <small>{SERVICE_LINE[s.id]}</small>
                    </div>
                    <div className="st-svc__now">
                      <StatePill state={shown} />
                      {s.latencyMs !== null && s.state !== 'unknown' && <small className="st-ms">{s.latencyMs} ms</small>}
                    </div>
                  </div>
                  <DayBars days={days} label={`${s.name}: ${fmtUptime(s.uptime)} uptime over the last ${s.days.length} days`} />
                  <div className="st-scale" aria-hidden="true">
                    <span>{s.days.length} days ago</span>
                    <span className="st-scale__pct">{fmtUptime(s.uptime)} uptime</span>
                    <span>Today</span>
                  </div>
                </li>
              );
            })}
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

        {report && (
          <section className="st-section st-past" aria-labelledby="st-past">
            <h2 id="st-past" className="st-h2">Past incidents and maintenance</h2>
            {past.length ? past.map((n) => <NoticeCard key={n.id} n={n} now={now} />) : <p className="st-none">None in the last 90 days.</p>}
          </section>
        )}

        <footer className="st-foot">
          <div className="st-legend" aria-hidden="true">
            <span><i className="st-bar is-up" />Up</span>
            <span><i className="st-bar is-degraded" />Degraded</span>
            <span><i className="st-bar is-partial" />Partly down</span>
            <span><i className="st-bar is-down" />Down</span>
            <span><i className="st-bar is-maintenance" />Maintenance</span>
            <span><i className="st-bar is-nodata" />No data</span>
          </div>
          <p>
            Checked every minute. Days and times are in UTC. Follow updates with the{' '}
            <a className="st-link" href={FEED_URL}>feed</a>. Something broken that this page does not show?{' '}
            <button type="button" className="st-link" onClick={() => openFeedback()}>Send feedback</button>
          </p>
        </footer>
      </article>
    </main>
  );
}
