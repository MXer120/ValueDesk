/**
 * Official results of the calendar's releases (server valuescan/releases.ts):
 * the FOMC's decision, CPI, the jobs report, PPI, GDP, PCE, JOLTS and the ECI,
 * read from the Fed's, BLS's and BEA's own pages the second they go up.
 *
 *   useReleaseResults  the results of a list of calendar events, polled every
 *                      second around a release (else every minute); a release
 *                      that lands while the page is open is announced once
 *                      (a toast, and a `vs:release` event the chart listens for).
 *   EventCard          one event: a tile per figure - the actual, the previous
 *                      (from the history when the release gives none) and the
 *                      change - the countdown, and, shown by default, the
 *                      history of the figure picked (the first one charted),
 *                      the release marked on it; the full history and table
 *                      one click away (macro/IndicatorView.tsx); the release's
 *                      first sentence and its official page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReleaseResult, ReleaseResultField } from '@sign/valuescan/releases.js';
import type { CalendarEvent } from '../../vsApi';
import { notify } from '../../toast';
import { useAsync, useStored } from '../../hooks';
import { Modal } from '../Modal';
import { IndicatorModal } from '../macro/IndicatorView';
import { fmtValue, macroApi } from '../macro/api';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';

export type { ReleaseResult };

/** Events with official results: the Fed's, BLS's and BEA's (SoSoValue's have none). */
export const hasResults = (e: Pick<CalendarEvent, 'source'>) => e.source === 'fed' || e.source === 'bls' || e.source === 'bea';

const HOT_BEFORE = 60_000;
const HOT_AFTER = 20 * 60_000;
export const RELEASE_EVENT = 'vs:release';
/** Releases already announced (or already out when first seen), for every widget on the page at once. */
const announced = new Set<string>();

/** Results for these events; polled fast while one is about to land or just landed. */
export function useReleaseResults(events: readonly CalendarEvent[]): Record<string, ReleaseResult> {
  const [results, setResults] = useState<Record<string, ReleaseResult>>({});
  const ids = events.filter(hasResults).map((e) => e.id).slice(0, 50);
  const key = ids.join(',');
  const times = useRef(new Map<string, number>());
  for (const e of events) times.current.set(e.id, e.time);

  useEffect(() => {
    if (!ids.length) return;
    let stop = false;
    let timer = 0;
    let first = true;
    const run = async () => {
      let hot = false;
      try {
        const r = await fetch(`/api/vs/calendar/results?ids=${encodeURIComponent(key)}`);
        const j = (await r.json()) as { ok?: boolean; results?: Record<string, ReleaseResult> };
        if (!stop && j.ok && j.results) {
          const now = Date.now();
          for (const res of Object.values(j.results)) {
            if (res.state !== 'released') continue;
            // Announce a release seen while this page was open - not the ones already out on load.
            if (!first && !announced.has(res.id)) {
              announced.add(res.id);
              window.dispatchEvent(new CustomEvent(RELEASE_EVENT, { detail: res }));
              notify('info', `${res.period ?? 'Release'}: ${summary(res)}`);
            } else announced.add(res.id);
          }
          setResults((prev) => ({ ...prev, ...j.results }));
          for (const id of ids) {
            const t = times.current.get(id) ?? 0;
            const res = j.results[id];
            if (now > t - HOT_BEFORE && now < t + HOT_AFTER && res?.state !== 'released') hot = true;
          }
        }
      } catch { /* the next round tries again */ }
      first = false;
      if (!stop) timer = window.setTimeout(run, hot ? 1000 : 60_000);
    };
    void run();
    return () => { stop = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return results;
}

/** A field's figure as shown: "0.3%", "+177k", "3.75–4.00%", "Hold". */
export function fmtField(f: Pick<ReleaseResultField, 'unit'>, v: string | null): string {
  if (v === null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return f.unit === '%' && /\d/.test(v) && !v.endsWith('%') ? `${v}%` : v;
  if (f.unit === 'k') return `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}k`;
  if (f.unit === 'bp') return `${n > 0 ? '+' : ''}${n} bp`;
  if (f.unit === '%') return `${v}%`;
  return v;
}

/** The first two figures in a line: "CPI m/m 0.3% · CPI y/y 2.9%". */
export function summary(r: ReleaseResult, n = 2): string {
  return r.fields.filter((f) => f.value !== null).slice(0, n).map((f) => `${f.label} ${fmtField(f, f.value)}`).join(' · ') || 'released';
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s % 60}s`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Which way a figure moved against the previous one, for its colour. */
function dir(v: string | null, p: string | null): 'up' | 'down' | null {
  const a = Number(v);
  const b = Number(p);
  return v !== null && p !== null && Number.isFinite(a) && Number.isFinite(b) && a !== b ? (a > b ? 'up' : 'down') : null;
}

/** A release's period as the history names it: "Q2 2026 (third estimate)" is the history's "Q2 2026". */
const basePeriod = (p: string | null | undefined) => (p ?? '').replace(/\s*\(.*\)\s*$/, '').trim();

const RANGES = [['1y', '1Y'], ['5y', '5Y'], ['10y', '10Y'], ['max', 'All']] as const;

/**
 * One figure's history in the card, shown by default: the chart (bars for a
 * change, a line for a level or a rate), the release's own period marked on it
 * when the history has it, a range switch, and a line saying how far the history
 * reaches when it is behind the release (FRED publishes after the agency).
 */
function EventChart({ ind, period, onFull }: { ind: { id: string; name: string }; period: string | null; onFull: () => void }) {
  const [range, setRange] = useStored<string>('vs.event.range', '5y');
  const r = useAsync(() => macroApi.indicator(ind.id, range), [ind.id, range], { pollMs: 10 * 60_000 });
  const d = r.data;
  const bars = !!d && (d.unit === 'k' || /_mm$|_qq$/.test(d.id));
  const want = basePeriod(period);
  const series = useMemo<ChartSeries[]>(() => {
    if (!d) return [];
    // The table runs newest first, the points oldest first: the same observations.
    const pts = [...d.points].sort((x, y) => x[0] - y[0]);
    const i = want ? d.table.findIndex((t) => t.period === want) : -1;
    const at = i >= 0 && d.table.length === pts.length ? pts[pts.length - 1 - i] : undefined;
    return [{
      key: d.id,
      kind: bars ? 'bars' : 'line',
      color: bars ? '#00b481' : '#f7f7f7',
      negColor: '#ef4a3c',
      points: d.points,
      format: (v: number) => fmtValue(d.unit, v),
      ...(at ? { mark: { time: at[0], text: 'This release', color: '#ffb547' } } : {}),
    }];
  }, [d, bars, want]);

  return (
    <div className="evc__graph">
      <div className="evc__graphbar">
        <span className="evc__graphtitle">{ind.name}</span>
        <span className="mc__spacer" />
        <div className="mc__seg" role="radiogroup" aria-label="Range">
          {RANGES.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={range === v} className={range === v ? 'is-on' : ''} onClick={() => setRange(v)}>{label}</button>
          ))}
        </div>
      </div>
      {r.error && !d ? (
        <p className="evc__none">The history did not load: {r.error}</p>
      ) : !d ? (
        <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading the history…</p>
      ) : (
        <>
          <SeriesChart series={series} height={230} />
          <p className="evc__foot">
            {want && d.latest && basePeriod(d.latest.period) !== want && !d.table.some((t) => t.period === want)
              ? `History through ${d.latest.period}; ${want} is added once ${d.source.name} publishes it. `
              : ''}
            Source: <a href={d.source.href} target="_blank" rel="noopener noreferrer">{d.source.name} · {d.source.series}</a>
            {' · '}
            <button type="button" className="evc__link" onClick={onFull}>Full history and table</button>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The previous figure of each field, from the history when the release did not
 * give one: for a release that is out, the figure before its period; for one
 * still to come, the latest figure out.
 */
function usePriors(fields: ReleaseResultField[], indOf: (key: string) => { id: string } | null, period: string | null): Record<string, number | null> {
  const want = basePeriod(period);
  const ids = fields.filter((f) => f.prior === null && indOf(f.key)).map((f) => `${f.key}:${indOf(f.key)!.id}`);
  const r = useAsync(
    async () => {
      const out: Record<string, number | null> = {};
      await Promise.all(ids.map(async (pair) => {
        const [key, id] = pair.split(':') as [string, string];
        const d = await macroApi.indicator(id, '1y');
        // In the history: its row carries the one before. Not in it yet (still to come,
        // or FRED not caught up): the previous figure is the latest one out.
        const row = want ? d.table.find((t) => t.period === want) : undefined;
        out[key] = row ? row.prior : d.latest?.value ?? null;
      }));
      return out;
    },
    [ids.join(','), want],
    { enabled: ids.length > 0 },
  );
  return r.data ?? {};
}

/**
 * An event with no official card (SoSoValue's) whose figures are indicators the
 * server has (CalendarEvent.indicators): a tile per indicator with its latest
 * reading - the release before this one while it is still to come - the one
 * before it and the change, a click charting it.
 */
function IndicatorFigures({ ids, pick, onPick }: { ids: string[]; pick: string | null; onPick: (id: string) => void }) {
  const r = useAsync(() => Promise.all(ids.map((id) => macroApi.indicator(id, '1y').catch(() => null))), [ids.join(',')], { pollMs: 10 * 60_000 });
  if (!r.data) return <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading the figures…</p>;
  const got = r.data.filter((d): d is NonNullable<typeof d> => !!d && !!d.latest);
  if (!got.length) return <p className="evc__none">The figures did not load{r.error ? `: ${r.error}` : '.'}</p>;
  return (
    <div className="evc__figs">
      {got.map((d) => {
        const { value, prior, period } = d.latest!;
        const delta = prior !== null ? value - prior : null;
        const dp = d.unit === 'k' || d.unit === 'K' ? 0 : d.unit === 'M' ? 2 : 1;
        return (
          <button key={d.id} type="button" onClick={() => onPick(d.id)} aria-pressed={pick === d.id} title={`Show the ${d.name} history`} className={`evc__fig is-pick${pick === d.id ? ' is-on' : ''}`}>
            <span className="evc__figlabel">{d.name}<small> · {period}</small></span>
            <b className={`evc__figval${delta ? ` is-${delta > 0 ? 'up' : 'down'}` : ''}`}>{fmtValue(d.unit, value, dp)}</b>
            <span className="evc__figprev">
              Prev <b>{fmtValue(d.unit, prior, dp)}</b>
              {delta !== null && Math.abs(delta) >= 10 ** -dp / 2 && (
                <em className={delta > 0 ? 'is-up' : 'is-down'}>{delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(dp)}{d.unit === 'k' || d.unit === 'K' ? 'k' : d.unit === '%' ? ' pp' : d.unit}</em>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function EventCard({ event, result, onClose, sourceName }: {
  event: CalendarEvent;
  result: ReleaseResult | undefined;
  onClose: () => void;
  sourceName?: string;
}) {
  const [, tick] = useState(0);
  const [full, setFull] = useState<{ id: string; title: string } | null>(null);
  const catalog = useAsync(() => macroApi.indicators(), [], {});
  /** The indicator a figure of this event is: the calendar kind and the release field. */
  const indicatorOf = (key: string) => catalog.data?.indicators.find((x) => x.kind === event.short && x.field === key) ?? null;
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const now = Date.now();
  const released = result?.state === 'released';
  const waiting = !released && now >= event.time - HOT_BEFORE && now < event.time + HOT_AFTER;
  const fields: ReleaseResultField[] = result?.fields ?? (event.fields ?? []).map((f) => ({ ...f, value: null, prior: null }));
  const charted = fields.filter((f) => indicatorOf(f.key));
  const [pick, setPick] = useState<string | null>(null);
  const shown = charted.find((f) => f.key === pick) ?? charted[0] ?? null;
  const own = fields.length === 0 ? (event.indicators ?? []) : [];
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const ownShown = own.length ? catalog.data?.indicators.find((x) => x.id === (ownPick && own.includes(ownPick) ? ownPick : own[0])) ?? null : null;
  const shownInd = shown ? indicatorOf(shown.key) : ownShown;
  const priors = usePriors(fields, indicatorOf, result?.period ?? null);
  const when = new Date(event.time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lag = released && result?.seenAt && result.releasedAt ? (result.seenAt - result.releasedAt) / 1000 : null;
  const host = (() => { try { return new URL(result?.href ?? event.href).hostname.replace(/^www\./, ''); } catch { return 'the source'; } })();

  return (
    <Modal open title={event.title} onClose={onClose} size="lg" className="evc">
      <div className="evc__meta">
        <span className={`evc__state is-${released ? 'out' : waiting ? 'wait' : 'sched'}`}>
          {released ? 'Released' : waiting ? 'Waiting for the release…' : event.time > now ? `In ${countdown(event.time - now)}` : 'Not read yet'}
        </span>
        <span>{event.allDay ? new Date(event.time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : when}</span>
        <span className="evc__dot" aria-hidden="true" />
        <span>{sourceName ?? event.source.toUpperCase()}</span>
        {result?.period && <><span className="evc__dot" aria-hidden="true" /><span>{result.period}</span></>}
      </div>

      {fields.length > 0 ? (
        <div className="evc__figs">
          {fields.map((f) => {
            const prior = f.prior ?? (priors[f.key] != null ? String(priors[f.key]) : null);
            const d = dir(f.value, prior);
            const delta = f.value !== null && prior !== null && Number.isFinite(Number(f.value)) && Number.isFinite(Number(prior)) ? Number(f.value) - Number(prior) : null;
            const can = !!indicatorOf(f.key);
            const on = shown?.key === f.key;
            const Tag = can ? 'button' : 'div';
            return (
              <Tag
                key={f.key}
                {...(can ? { type: 'button' as const, onClick: () => setPick(f.key), 'aria-pressed': on, title: `Show the ${f.label} history` } : {})}
                className={`evc__fig${can ? ' is-pick' : ''}${on ? ' is-on' : ''}`}
              >
                <span className="evc__figlabel">{f.label}{f.note && <small title={f.note}> · {f.note}</small>}</span>
                <b className={`evc__figval${f.value === null ? (waiting ? ' is-wait' : ' is-empty') : ''}${d ? ` is-${d}` : ''}`}>{fmtField(f, f.value)}</b>
                <span className="evc__figprev">
                  Prev <b>{fmtField(f, prior)}</b>
                  {delta !== null && delta !== 0 && (
                    <em className={delta > 0 ? 'is-up' : 'is-down'}>{delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(f.unit === 'k' ? 0 : 1)}{f.unit === 'k' ? 'k' : f.unit === '%' ? ' pp' : ''}</em>
                  )}
                </span>
              </Tag>
            );
          })}
        </div>
      ) : own.length ? (
        <IndicatorFigures ids={own} pick={ownShown?.id ?? null} onPick={setOwnPick} />
      ) : (
        <p className="evc__none">{event.detail ?? (/ISM|PMI/i.test(event.title)
          ? 'This calendar publishes the date only, and this survey\'s history is not freely published, so there is no chart for it.'
          : 'This calendar publishes the date only; there are no official figures to show here.')}</p>
      )}

      {shownInd && <EventChart key={shownInd.id} ind={shownInd} period={result?.period ?? null} onFull={() => setFull({ id: shownInd.id, title: shownInd.name })} />}

      {result?.headline && <p className="evc__headline">{result.headline}</p>}
      <p className="evc__foot">
        {result?.priorPeriod ? `Previous: ${result.priorPeriod}. ` : ''}
        Consensus forecasts are not published by the official sources.
        {lag !== null && lag >= 0 ? ` Read from ${host} ${lag.toFixed(1)}s after the scheduled time.` : ''}
      </p>
      {full && <IndicatorModal id={full.id} title={full.title} onClose={() => setFull(null)} />}
      <div className="evc__actions">
        <a className="fx-cta evc__open" href={result?.href ?? event.href} target="_blank" rel="noopener noreferrer">Open on {host}</a>
      </div>
    </Modal>
  );
}
