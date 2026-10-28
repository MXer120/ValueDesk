/**
 * /status - is ValueDesk up? Public, no wallet, no terms to accept first.
 *
 * One card, the way common status pages are laid out:
 *   - the headline with its icon: a check (all operational), a warning (degraded or
 *     partly down), an X (a service down, or this page's own service unreachable),
 *     maintenance in blue;
 *   - incidents and maintenance behind a Current | Past switch (Current first):
 *     current is each open incident, maintenance in progress and maintenance to
 *     come, with its timeline; past is one slim row each for the last 90 days,
 *     opened in place for its timeline. A link to one (#notice-<id>) opens its list
 *     and the row;
 *   - each service - the website, the data API, the copy & algo executor, the
 *     indexer - with its state now and a bar for each of the last 90 UTC days
 *     (green up, amber degraded, orange partly down, red down, blue maintenance,
 *     grey no data). Each bar tells its day on hover, focus (arrow keys move along
 *     the days) or a tap: the date, the uptime, the minutes down or degraded and
 *     that day's incidents and maintenance.
 * Everything the owner wrote is shown as text (React escapes it), never as markup.
 * Read again every minute while the tab is visible.
 *
 * When the status service does not answer (server 1 down), the page says so and
 * shows what this browser could check itself: the executor's own health.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { openFeedback } from '../feedback/FeedbackButton';
import {
  OVERALL_SHOWN_TEXT, SERVICE_LINE, SHOWN_TEXT, STAGE_TEXT, componentNames, dayDetail, fmtUptime, fmtUtc, heroTone, loadStatus,
  noticeDuration, noticeKindText, noticePhase, noticeTimes, overallShown, shownState, splitNotices,
  type DayDetail, type HeroTone, type Notice, type NoticePhase, type ShownState, type StatusView,
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

/** A notice's colour: its impact, or maintenance. */
const toneOf = (n: Notice): string => (n.kind === 'incident' ? n.impact ?? 'minor' : 'maintenance');

/** A notice's updates, newest first, on a line. */
function Timeline({ n }: { n: Notice }) {
  return (
    <ol className="st-timeline">
      {[...n.updates].reverse().map((u, i) => (
        <li key={`${u.at}-${i}`}>
          <b>{STAGE_TEXT[u.stage]}</b>
          <time dateTime={new Date(u.at).toISOString()}>{fmtUtc(u.at)}</time>
          {u.text && <span className="st-timeline__text">{u.text}</span>}
        </li>
      ))}
    </ol>
  );
}

/** One current incident or maintenance: what, where, when, and its updates, newest first. */
export function NoticeCard({ n, now, open = false }: { n: Notice; now: number; open?: boolean }) {
  const phase = noticePhase(n, now);
  return (
    <article id={`notice-${n.id}`} className={`st-notice is-${toneOf(n)}${open ? ' is-open' : ''}`}>
      <header className="st-notice__head">
        <i className="st-dot" aria-hidden="true" />
        <b className="st-notice__title">{n.title}</b>
        <span className={`st-phase is-${phase}`}>{PHASE_TEXT[phase]}</span>
      </header>
      <p className="st-notice__meta">
        <span className="st-chip">{noticeKindText(n)}</span>
        <span>{componentNames(n)} · {noticeTimes(n, now)}</span>
      </p>
      <Timeline n={n} />
    </article>
  );
}

/** One past incident or maintenance: a slim row - what, when, how long - that opens in place for its timeline. */
export function NoticeRow({ n, now, open, onToggle }: { n: Notice; now: number; open: boolean; onToggle: (id: number) => void }) {
  const bodyId = useId();
  return (
    <li id={`notice-${n.id}`} className={`st-row is-${toneOf(n)}${open ? ' is-open' : ''}`}>
      <button type="button" className="st-row__bar" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(n.id)}>
        <i className="st-dot" aria-hidden="true" />
        <span className="st-row__title">{n.title}</span>
        <span className="st-row__kind">{noticeKindText(n)}</span>
        <time className="st-row__when" dateTime={new Date(n.startsAt).toISOString()}>{fmtUtc(n.startsAt).replace(/ UTC$/, '')}</time>
        <span className="st-row__dur">{noticeDuration(n, now)}</span>
        <svg className="st-row__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className="st-row__body">
          <p className="st-notice__meta">
            <span>{componentNames(n)} · {noticeTimes(n, now)}</span>
          </p>
          <Timeline n={n} />
        </div>
      )}
    </li>
  );
}

const HERO_ICON: Record<HeroTone, string> = {
  ok: 'M6 10.4l2.7 2.7L14 7.6',
  warn: 'M10 6.6v4.1M10 13.4v.1',
  down: 'M7 7l6 6M13 7l-6 6',
  maintenance: 'M10 6.4V10l2.4 1.6',
  unknown: 'M6.8 10h6.4',
};

/** The headline's icon: a disc in the state's colour (a triangle for a warning) with its sign. */
function HeroIcon({ tone }: { tone: HeroTone }) {
  return (
    <svg className="st-hero__icon" viewBox="0 0 20 20" width="36" height="36" aria-hidden="true">
      {tone === 'warn' ? <path className="st-hero__shape" d="M10 2.2 18.4 17H1.6Z" strokeLinejoin="round" /> : <circle className="st-hero__shape" cx="10" cy="10" r="8.6" />}
      <path className="st-hero__sign" d={HERO_ICON[tone]} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform={tone === 'warn' ? 'translate(0 1.2)' : undefined} />
    </svg>
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

type NoticeTab = 'current' | 'past';

/** The headline: icon, state, which services it is about, and when it was last checked. */
function Hero({ view, loading, reload, states, services }: {
  view: StatusView | null; loading: boolean; reload: () => void; states: ShownState[]; services: { name: string }[];
}) {
  const unreachable = view?.kind === 'unreachable';
  const overall = view?.kind === 'report' ? overallShown(states) : null;
  const tone: HeroTone = !view ? 'unknown' : heroTone(unreachable ? 'unreachable' : overall!);
  const affected = services
    .map((s, i) => ({ name: s.name, state: states[i] }))
    .filter((s): s is { name: string; state: ShownState } => !!s.state && s.state !== 'up' && s.state !== 'unknown');
  return (
    <header className={`st-hero is-${tone}`}>
      <HeroIcon tone={tone} />
      <div className="st-hero__text" role="status">
        <h1 className="st-hero__title">
          {!view ? 'Checking…' : unreachable ? 'The status service is unreachable' : OVERALL_SHOWN_TEXT[overall!]}
        </h1>
        {unreachable ? (
          <p className="st-hero__line">
            It runs with the data API, so that is likely down too: leaderboards, cohorts and news may not load. What your
            browser could check by itself is below.
          </p>
        ) : affected.length > 0 ? (
          <p className="st-hero__line">{affected.map((s) => `${s.name}: ${SHOWN_TEXT[s.state]}`).join(' · ')}</p>
        ) : null}
      </div>
      <span className="st-updated">
        {view ? `Updated ${time(view.kind === 'report' ? view.report.at : view.at)}` : ''}
        <button type="button" className="st-refresh" onClick={reload} disabled={loading} aria-label="Check again" title="Check again">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
    </header>
  );
}

/**
 * Incidents and maintenance: Current (the default) or Past, one list at a time. With
 * `scrollTo` it lands on that notice once drawn (a link to it: drawn again with a new key).
 */
export function NoticeLists({ notices, now, initialTab = 'current', initialOpen = null, scrollTo = null }: {
  notices: readonly Notice[]; now: number; initialTab?: NoticeTab; initialOpen?: number | null; scrollTo?: number | null;
}) {
  const { current, past } = splitNotices(notices, now);
  const [tab, setTab] = useState<NoticeTab>(initialTab);
  const [openId, setOpenId] = useState<number | null>(initialOpen);
  useEffect(() => {
    if (scrollTo !== null) document.getElementById(`notice-${scrollTo}`)?.scrollIntoView({ block: 'start' });
    // Once, as drawn: a later link remounts this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tabs: Array<{ id: NoticeTab; label: string; count: number }> = [
    { id: 'current', label: 'Current', count: current.length },
    { id: 'past', label: 'Past', count: past.length },
  ];
  return (
    <section className="st-notices" aria-labelledby="st-notices">
      <div className="st-notices__head">
        <h2 id="st-notices" className="st-h2">Incidents and maintenance</h2>
        <div className="segmented st-seg" role="tablist" aria-label="Incidents and maintenance">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count > 0 && <span className="st-seg__n">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" aria-label={tab === 'current' ? 'Current' : 'Past'}>
        {tab === 'current'
          ? current.length
            ? <div className="st-open">{current.map((n) => <NoticeCard key={n.id} n={n} now={now} open={noticePhase(n, now) !== 'upcoming'} />)}</div>
            : <p className="st-none">No incidents or maintenance right now.</p>
          : past.length
            ? (
              <ul className="st-rows">
                {past.map((n) => <NoticeRow key={n.id} n={n} now={now} open={openId === n.id} onToggle={(id) => setOpenId((o) => (o === id ? null : id))} />)}
              </ul>
            )
            : <p className="st-none">None in the last 90 days.</p>}
      </div>
    </section>
  );
}

export function StatusPage() {
  const { view, loading, reload } = useStatus();
  const now = Date.now();
  const report = view?.kind === 'report' ? view.report : null;
  const notices = report?.notices ?? [];
  const states = report ? report.services.map((s) => shownState(s.state, s.id, notices, now)) : [];

  // A link to one notice (the app's banner, the feed) opens its list - and, for a past
  // one, its row - and lands on it once it is drawn.
  const [target, setTarget] = useState<{ key: number; tab: NoticeTab; open: number | null; scrollTo: number | null }>({ key: 0, tab: 'current', open: null, scrollTo: null });
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !report) return;
    linked.current = true;
    const m = /^notice-(\d+)$/.exec(window.location.hash.slice(1));
    if (!m) return;
    const id = Number(m[1]);
    const inPast = splitNotices(report.notices ?? [], Date.now()).past.some((n) => n.id === id);
    setTarget({ key: 1, tab: inPast ? 'past' : 'current', open: inPast ? id : null, scrollTo: id });
  }, [report]);

  return (
    <main className="st" aria-busy={loading}>
      <article className="st-card">
        <Hero view={view} loading={loading} reload={reload} states={states} services={report?.services ?? []} />

        {report && (
          <NoticeLists key={target.key} notices={notices} now={now} initialTab={target.tab} initialOpen={target.open} scrollTo={target.scrollTo} />
        )}

        {report && (
          <ul className="st-list" aria-label="Services">
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
          <ul className="st-list" aria-label="Services">
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
