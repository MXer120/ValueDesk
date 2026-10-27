/**
 * The News widget's Calendar (NewsFeed.tsx): what is scheduled to move markets
 * - the FOMC's decisions, CPI, the jobs report, GDP, PCE, PPI, JOLTS - from the
 * Federal Reserve, BLS and BEA themselves, with SoSoValue's macro calendar for
 * the rest (server valuedesk/calendar.ts).
 *
 * By day in the viewer's time, from three days back to six weeks ahead; the
 * next release says how long until it. Each opens its card (releases.tsx): the
 * official figures, empty until they land and filled the second they do, with
 * the publisher's page one click on. The
 * key releases show by default; the minor ones (PMIs, housing) on request.
 * The widget's header credits it: "Powered by SoSoValue & more".
 */
import { useMemo, useState } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi, type CalendarEvent } from '../../vsApi';
import { EmptyState } from '../EmptyState';
import { focusProps } from '../../chart/newsFocus';
import { EventCard, fmtField, hasResults, useReleaseResults } from './releases';
import { CalendarMark } from './newsSources';

const DAY = 86_400_000;
const IMPACT_LABEL: Record<CalendarEvent['importance'], string> = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
const SHORT_SOURCE: Record<CalendarEvent['source'], string> = { fed: 'Fed', bls: 'BLS', bea: 'BEA', sosovalue: 'SoSoValue' };

/** "in 3d 4h", "in 45m", "now". */
function until(t: number, now: number): string {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m >= 1440) return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}

/** The viewer's day a release falls on; an all-day one keeps its own date. */
const dayKey = (e: CalendarEvent) => {
  const d = new Date(e.time);
  return e.allDay ? `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}` : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function dayLabel(e: CalendarEvent, now: number): string {
  const d = new Date(e.time);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', ...(e.allDay ? { timeZone: 'UTC' } : {}) };
  const label = d.toLocaleDateString(undefined, opts);
  const today = new Date(now).toLocaleDateString(undefined, opts);
  const tomorrow = new Date(now + DAY).toLocaleDateString(undefined, opts);
  return label === today ? `Today · ${label}` : label === tomorrow ? `Tomorrow · ${label}` : label;
}

export function EconCalendar({ instance }: { instance?: string }) {
  const ns = instance ? `.${instance}` : '';
  const [minor, setMinor] = useStored<boolean>(`vs.news.cal.minor${ns}`, false);
  // A whole hour's window keeps the query (and its cache) the same between renders.
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const cal = useAsync(() => vsApi.calendar({ from: hour - 3 * DAY, to: hour + 45 * DAY }), [hour], { pollMs: 30 * 60_000 });
  const now = Date.now();
  const events = useMemo(() => (cal.data?.events ?? []).filter((e) => minor || e.importance !== 'low'), [cal.data, minor]);
  const next = events.find((e) => e.time > now);
  const results = useReleaseResults(events);
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; events: CalendarEvent[] }> = [];
    for (const e of events) {
      const key = dayKey(e);
      const last = out[out.length - 1];
      if (last?.key === key) last.events.push(e);
      else out.push({ key, label: dayLabel(e, now), events: [e] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  return (
    <>
      <div className="nw__filters nwc__bar">
        <span className="nwc__seg" role="radiogroup" aria-label="Which releases">
          <button type="button" role="radio" aria-checked={!minor} className={!minor ? 'is-on' : ''} onClick={() => setMinor(false)}>
            Key releases
          </button>
          <button type="button" role="radio" aria-checked={minor} className={minor ? 'is-on' : ''} onClick={() => setMinor(true)}>
            All
          </button>
        </span>
        {next && (
          <span className="nwc__next" title={next.title}>
            Next: <b>{next.short}</b> {until(next.time, now)}
          </span>
        )}
      </div>
      <div className="nw__list">
        {cal.error && !cal.data ? (
          <EmptyState icon="news" title="The calendar did not load" line={cal.error} />
        ) : !cal.data ? (
          <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>
        ) : days.length === 0 ? (
          <EmptyState icon="news" title="Nothing scheduled" line="No release in the next six weeks that the calendars publish." />
        ) : (
          <ol className="nwc__days">
            {days.map((d) => (
              <li key={d.key} className="nwc__day">
                <div className="nwc__date">{d.label}</div>
                <ol className="nwc__events">
                  {d.events.map((e) => (
                    <li key={e.id} {...focusProps({ id: e.id, title: '' })}>
                      <button
                        type="button"
                        className={`nwc__row nwc__row--${e.importance}${e.time < now ? ' is-past' : ''}${e === next ? ' is-next' : ''}${results[e.id]?.state === 'released' ? ' is-out' : ''}`}
                        onClick={() => setOpen(e)}
                        title={`${e.title} - ${IMPACT_LABEL[e.importance]}, ${cal.data!.sourceNames[e.source] ?? e.source}`}
                      >
                        <span className="nwc__time">{e.allDay ? 'Day' : new Date(e.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="nwc__impact" aria-label={IMPACT_LABEL[e.importance]}>
                          <i className="on" />
                          <i className={e.importance !== 'low' ? 'on' : ''} />
                          <i className={e.importance === 'high' ? 'on' : ''} />
                        </span>
                        <span className="nwc__short">{e.short}</span>
                        <span className="nwc__title">{e.title}</span>
                        {(() => {
                          const r = results[e.id];
                          const f = r?.state === 'released' ? r.fields.find((x) => x.value !== null) : undefined;
                          if (f) return <span className="nwc__val" title={`${f.label}${f.prior !== null ? `, previous ${fmtField(f, f.prior)}` : ''}`}>{fmtField(f, f.value)}</span>;
                          if (hasResults(e) && Math.abs(e.time - now) < 60_000 && r?.state !== 'released') return <span className="nwc__val is-wait">waiting…</span>;
                          return <span className="nwc__src">{e === next ? until(e.time, now) : <><CalendarMark source={e.source} />{SHORT_SOURCE[e.source]}</>}</span>;
                        })()}
                      </button>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </div>
      {open && <EventCard event={open} result={results[open.id]} sourceName={cal.data?.sourceNames[open.source]} onClose={() => setOpen(null)} />}
    </>
  );
}
