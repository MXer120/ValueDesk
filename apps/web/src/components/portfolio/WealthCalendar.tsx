/**
 * The Wealth page's calendar (owner 2026-11-28: "dEsign calendar a bit better"). The News widget's data and release
 * cards (news/EconCalendar.tsx, releases.tsx: the Fed, BLS and BEA themselves, SoSoValue for the rest), drawn for this
 * page: the next release large with its countdown, then the days, each release a row with its time, its weight as
 * three dots, its short name as a pill and, once out, the figure. Two days back to four weeks ahead; key releases by
 * default, all on request. A row opens the release's card with the official figures.
 */
import { useMemo, useState } from 'react';
import { Card } from './parts';
import { ViewSeg } from './RangePicker';
import { EmptyState } from '../EmptyState';
import { EventCard, fmtField, hasResults, useReleaseResults } from '../news/releases';
import { CalendarMark } from '../news/newsSources';
import { useAsync, useStored } from '../../hooks';
import { vsApi, type CalendarEvent } from '../../vsApi';
import './wealthHero.css';

const DAY = 86_400_000;
/** "in 3d 4h", "in 45m", "now". */
function until(t: number, now: number): string {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m >= 1440) return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}
const WEIGHT: Record<CalendarEvent['importance'], string> = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
type Scope = 'key' | 'all';
const SCOPES: ReadonlyArray<readonly [Scope, string]> = [['key', 'Key'], ['all', 'All']];

const dayKey = (e: CalendarEvent) => {
  const d = new Date(e.time);
  return e.allDay ? `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}` : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
function dayLabel(e: CalendarEvent, now: number): { day: string; rel: string | null } {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', ...(e.allDay ? { timeZone: 'UTC' } : {}) };
  const day = new Date(e.time).toLocaleDateString(undefined, opts);
  const rel = day === new Date(now).toLocaleDateString(undefined, opts) ? 'Today'
    : day === new Date(now + DAY).toLocaleDateString(undefined, opts) ? 'Tomorrow'
    : day === new Date(now - DAY).toLocaleDateString(undefined, opts) ? 'Yesterday' : null;
  return { day, rel };
}
const timeOf = (e: CalendarEvent) => (e.allDay ? 'All day' : new Date(e.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));

function Weight({ w }: { w: CalendarEvent['importance'] }) {
  return (
    <span className={`wh-wt is-${w}`} role="img" aria-label={WEIGHT[w]}>
      <i className="on" /><i className={w !== 'low' ? 'on' : ''} /><i className={w === 'high' ? 'on' : ''} />
    </span>
  );
}

export function WealthCalendar({ now }: { now: number }) {
  const [scope, setScope] = useStored<Scope>('vs.wealth.cal.scope', 'key');
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const cal = useAsync(() => vsApi.calendar({ from: hour - 2 * DAY, to: hour + 28 * DAY }), [hour], { pollMs: 30 * 60_000 });
  const events = useMemo(() => (cal.data?.events ?? []).filter((e) => scope === 'all' || e.importance !== 'low'), [cal.data, scope]);
  const next = events.find((e) => e.time > now) ?? null;
  const results = useReleaseResults(events);
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const days = useMemo(() => {
    const out: Array<{ key: string; label: { day: string; rel: string | null }; events: CalendarEvent[] }> = [];
    for (const e of events) {
      const key = dayKey(e);
      const last = out[out.length - 1];
      if (last?.key === key) last.events.push(e);
      else out.push({ key, label: dayLabel(e, now), events: [e] });
    }
    return out;
    // The labels follow the hour; a re-render each 30 s needs no new grouping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, hour]);
  const sourceName = (e: CalendarEvent) => cal.data?.sourceNames[e.source] ?? e.source;

  return (
    <Card title="Calendar" action={<ViewSeg value={scope} options={SCOPES} onChange={setScope} label="Which releases" />} className="wh-macro__cal">
      {next && (
        <button type="button" className={`wh-next is-${next.importance}`} onClick={() => setOpen(next)}>
          <span className="wh-next__k">Next up</span>
          <span className="wh-next__t"><span className="wh-tag">{next.short}</span><b>{next.title}</b></span>
          <span className="wh-next__m"><Weight w={next.importance} /><span>{dayLabel(next, now).rel ?? dayLabel(next, now).day}</span><span>{timeOf(next)}</span><span className="wh-next__src"><CalendarMark source={next.source} />{sourceName(next)}</span></span>
          <span className="wh-next__in">{until(next.time, now)}</span>
        </button>
      )}
      <div className="wh-cal">
        {cal.error && !cal.data ? (
          <EmptyState icon="news" title="The calendar did not load" line={cal.error} />
        ) : !cal.data ? (
          <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>
        ) : days.length === 0 ? (
          <EmptyState icon="news" title="Nothing scheduled" line="No release in the next four weeks that the calendars publish." />
        ) : (
          <ol className="wh-days">
            {days.map((d) => (
              <li key={d.key}>
                <p className="wh-day">{d.label.rel && <b>{d.label.rel}</b>}{d.label.day}</p>
                <ol className="wh-evs">
                  {d.events.map((e) => {
                    const r = results[e.id];
                    const f = r?.state === 'released' ? r.fields.find((x) => x.value !== null) : undefined;
                    const past = e.time < now;
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          className={`wh-ev${past ? ' is-past' : ''}${e === next ? ' is-next' : ''}`}
                          onClick={() => setOpen(e)}
                          title={`${e.title}. ${WEIGHT[e.importance]}, ${sourceName(e)}`}
                        >
                          <span className="wh-ev__time">{timeOf(e)}</span>
                          <Weight w={e.importance} />
                          <span className="wh-tag">{e.short}</span>
                          <span className="wh-ev__title">{e.title}</span>
                          {f ? <span className="wh-ev__val" title={`${f.label}${f.prior !== null ? `, previous ${fmtField(f, f.prior)}` : ''}`}>{fmtField(f, f.value)}</span>
                            : past && hasResults(e) && now - e.time < 120_000 ? <span className="wh-ev__val is-wait">waiting…</span>
                            : !past ? <span className="wh-ev__in">{until(e.time, now)}</span>
                            : <span className="wh-ev__src"><CalendarMark source={e.source} /></span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </div>
      {open && <EventCard event={open} result={results[open.id]} sourceName={cal.data?.sourceNames[open.source]} onClose={() => setOpen(null)} />}
    </Card>
  );
}
