/**
 * Official results of the calendar's releases (server valuescan/releases.ts):
 * the FOMC's decision, CPI, the jobs report, PPI, GDP, PCE, JOLTS and the ECI,
 * read from the Fed's, BLS's and BEA's own pages the second they go up.
 *
 *   useReleaseResults  the results of a list of calendar events, polled every
 *                      second around a release (else every minute); a release
 *                      that lands while the page is open is announced once
 *                      (a toast, and a `vs:release` event the chart listens for).
 *   EventCard          one event: its fields with the actual and the previous
 *                      figure (empty until it lands), the countdown, the
 *                      release's first sentence and its official page; each
 *                      figure opens its history (macro/IndicatorView.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReleaseResult, ReleaseResultField } from '@sign/valuescan/releases.js';
import type { CalendarEvent } from '../../vsApi';
import { notify } from '../../toast';
import { useAsync } from '../../hooks';
import { Modal } from '../Modal';
import { IndicatorModal } from '../macro/IndicatorView';
import { macroApi } from '../macro/api';

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

export function EventCard({ event, result, onClose, sourceName }: {
  event: CalendarEvent;
  result: ReleaseResult | undefined;
  onClose: () => void;
  sourceName?: string;
}) {
  const [, tick] = useState(0);
  const [chart, setChart] = useState<{ id: string; title: string } | null>(null);
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
  const when = new Date(event.time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lag = released && result?.seenAt && result.releasedAt ? (result.seenAt - result.releasedAt) / 1000 : null;
  const host = (() => { try { return new URL(result?.href ?? event.href).hostname.replace(/^www\./, ''); } catch { return 'the source'; } })();

  return (
    <Modal open title={event.title} onClose={onClose} size="md" className="evc">
      <div className="evc__meta">
        <span className={`evc__state is-${released ? 'out' : waiting ? 'wait' : 'sched'}`}>
          {released ? 'Released' : waiting ? 'Waiting for the release…' : event.time > now ? `In ${countdown(event.time - now)}` : 'Not read yet'}
        </span>
        <span>{event.allDay ? new Date(event.time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : when}</span>
        <span>{sourceName ?? event.source.toUpperCase()}</span>
        {result?.period && <span>{result.period}</span>}
      </div>
      {fields.length > 0 ? (
        <table className="evc__table">
          <thead><tr><th>Figure</th><th className="num">Actual</th><th className="num">Previous</th><th aria-label="History" /></tr></thead>
          <tbody>
            {fields.map((f) => {
              const d = dir(f.value, f.prior);
              return (
                <tr key={f.key}>
                  <td>{f.label}{f.note && <small title={f.note}> · {f.note}</small>}</td>
                  <td className={`num evc__actual${f.value === null ? (waiting ? ' is-wait' : ' is-empty') : ''}${d ? ` is-${d}` : ''}`}>{fmtField(f, f.value)}</td>
                  <td className="num evc__prior">{fmtField(f, f.prior)}</td>
                  <td className="evc__hist">
                    {(() => {
                      const ind = indicatorOf(f.key);
                      return ind ? (
                        <button type="button" className="evc__chart" title={`${ind.name}: history, chart and table`} aria-label={`History of ${ind.name}`} onClick={() => setChart({ id: ind.id, title: ind.name })}>
                          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 13.5h12M3.5 11 6.5 7.5l2.5 2 4-5" /></svg>
                        </button>
                      ) : null;
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="evc__none">{event.detail ?? 'This calendar publishes the date only; there are no official figures to show here.'}</p>
      )}
      {result?.headline && <p className="evc__headline">{result.headline}</p>}
      {result?.priorPeriod && <p className="evc__foot">Previous: {result.priorPeriod}. Consensus forecasts are not published by the official sources.</p>}
      {lag !== null && lag >= 0 && <p className="evc__foot">Read from {host} {lag.toFixed(1)}s after the scheduled time.</p>}
      {chart && <IndicatorModal id={chart.id} title={chart.title} onClose={() => setChart(null)} />}
      <div className="evc__actions">
        <a className="fx-cta evc__open" href={result?.href ?? event.href} target="_blank" rel="noopener noreferrer">Open on {host}</a>
      </div>
    </Modal>
  );
}
