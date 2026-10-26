/**
 * One economic indicator in full (core PCE y/y, CPI m/m, payrolls...): its
 * latest figure beside the previous one, when it was last read and when the
 * next release is, its history as a chart and as a table. From FRED (the
 * St. Louis Fed's copy of BLS's and BEA's series), refreshed after each release.
 *
 *   IndicatorView     the body - in the Indicator widget (any indicator, picked
 *                     there) and in IndicatorModal (from a calendar event's card).
 */
import { useMemo } from 'react';
import { useAsync, useStored } from '../../hooks';
import { EmptyState } from '../EmptyState';
import { Modal } from '../Modal';
import { SeriesChart, rangeSpan, type ChartSeries } from '../datachart/SeriesChart';
import { macroApi, fmtValue, type IndicatorInfo } from './api';
import './macro.css';

const RANGES = [['1y', '1Y'], ['5y', '5Y'], ['10y', '10Y'], ['max', 'All']] as const;

function until(t: number): string {
  const m = Math.round((t - Date.now()) / 60_000);
  if (m <= 0) return 'due now';
  if (m >= 1440) return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}

export function IndicatorView({ id, range, setRange, compact = false }: { id: string; range: string; setRange: (r: string) => void; compact?: boolean }) {
  // The whole history, once: the range buttons only set how much of it is on
  // screen, and the wheel or a drag reaches the rest.
  const r = useAsync(() => macroApi.indicator(id, 'max'), [id], { pollMs: 10 * 60_000 });
  const d = r.data;
  // A change series (payrolls, m/m figures) reads as bars; a level or a 12-month rate as a line.
  const bars = !!d && (d.unit === 'k' || /_mm$|_qq$/.test(d.id));
  const series = useMemo<ChartSeries[]>(() => (d ? [{
    key: d.id,
    kind: bars ? 'bars' : 'line',
    color: bars ? '#00b481' : '#f7f7f7',
    negColor: '#ef4a3c',
    points: d.points,
    format: (v: number) => fmtValue(d.unit, v),
  }] : []), [d, bars]);

  if (r.error && !d) return <EmptyState icon="news" title="This indicator did not load" line={r.error} />;
  if (!d) return <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>;
  const up = d.latest && d.latest.prior !== null ? d.latest.value - d.latest.prior : null;

  return (
    <div className="mc__ind">
      <div className="mc__stats">
        <div><span>Actual{d.latest ? ` · ${d.latest.period}` : ''}</span><b className={up === null || up === 0 ? '' : up > 0 ? 'is-up' : 'is-down'}>{fmtValue(d.unit, d.latest?.value)}</b></div>
        <div><span>Forecast</span><b className="is-dim" title="Consensus forecasts are not published by the official sources">n/a</b></div>
        <div><span>Previous</span><b>{fmtValue(d.unit, d.latest?.prior)}</b></div>
        <div><span>Next release</span><b>{d.next ? until(d.next.time) : '—'}</b></div>
      </div>
      <div className="mc__bar">
        <span className="mc__kicker">Updated {new Date(d.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        <span className="mc__spacer" />
        <div className="mc__seg" role="radiogroup" aria-label="Range">
          {RANGES.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={range === v} className={range === v ? 'is-on' : ''} onClick={() => setRange(v)}>{label}</button>
          ))}
        </div>
      </div>
      <SeriesChart series={series} height={compact ? 160 : 240} span={rangeSpan(range)} />
      <table className="mc__table">
        <thead><tr><th>Period</th><th className="num">Actual</th><th className="num">Previous</th></tr></thead>
        <tbody>
          {d.table.slice(0, compact ? 8 : 24).map((row) => (
            <tr key={row.period}>
              <td>{row.period}</td>
              <td className="num">{fmtValue(d.unit, row.value)}</td>
              <td className="num mc__dim">{fmtValue(d.unit, row.prior)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mc__src">Source: <a href={d.source.href} target="_blank" rel="noopener noreferrer">{d.source.name} · {d.source.series}</a></p>
    </div>
  );
}

/** The Indicator widget: any indicator, picked in the widget and remembered per copy. */
export function IndicatorWidget({ instance }: { instance?: string }) {
  const ns = instance ? `.${instance}` : '';
  const [id, setId] = useStored<string>(`vs.indicator.id${ns}`, 'core_pce_yy');
  const [range, setRange] = useStored<string>(`vs.indicator.range${ns}`, '5y');
  const list = useAsync(() => macroApi.indicators(), [], {});
  const all: IndicatorInfo[] = list.data?.indicators ?? [];
  return (
    <div className="mc">
      <div className="mc__bar">
        <select className="mc__select" value={id} onChange={(e) => setId(e.target.value)} aria-label="Indicator">
          {(all.length ? all : [{ id, name: id } as IndicatorInfo]).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <IndicatorView id={id} range={range} setRange={setRange} compact />
    </div>
  );
}

/** From a calendar event's card: one indicator over the card. */
export function IndicatorModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [range, setRange] = useStored<string>('vs.indicator.modalRange', '5y');
  return (
    <Modal open title={title} onClose={onClose} size="lg" className="mc-modal">
      <IndicatorView id={id} range={range} setRange={setRange} />
    </Modal>
  );
}
