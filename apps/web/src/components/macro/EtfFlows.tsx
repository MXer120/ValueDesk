/**
 * The ETF Flows widget: the US spot crypto ETFs' money in and out, from
 * SoSoValue - the latest day's net flow, the running total and the assets held,
 * each day's flow as a bar (in green, out red) with the running total over it,
 * and the funds, largest first. Asset (BTC, ETH, SOL...) and range are the
 * widget's own settings, per copy. Credited "Powered by SoSoValue".
 */
import { useMemo } from 'react';
import { useAsync, useStored } from '../../hooks';
import { EmptyState } from '../EmptyState';
import { CoinIcon } from '../CoinIcon';
import { PoweredBy } from '../news/PoweredBy';
import { SeriesChart, rangeSpan, type ChartSeries } from '../datachart/SeriesChart';
import { fmtUsd, macroApi } from './api';
import './macro.css';

const RANGES = [['1m', '1M'], ['3m', '3M'], ['1y', '1Y'], ['all', 'All']] as const;

export function EtfFlows({ instance }: { instance?: string }) {
  const ns = instance ? `.${instance}` : '';
  const [asset, setAsset] = useStored<string>(`vs.etf.asset${ns}`, 'BTC');
  const [range, setRange] = useStored<string>(`vs.etf.range${ns}`, '3m');
  // Every kept day, once per asset (the server reads SoSoValue the same way for
  // any range and only cuts its answer): the range sets how much is on screen.
  const r = useAsync(() => macroApi.etf(asset, 'all'), [asset], { pollMs: 30 * 60_000 });
  const d = r.data;
  const last = d?.days[d.days.length - 1];
  const series = useMemo<ChartSeries[]>(() => {
    if (!d) return [];
    const at = (date: string) => Date.parse(`${date}T00:00:00Z`);
    const out: ChartSeries[] = [{ key: 'flow', kind: 'bars', color: '#00b481', negColor: '#ef4a3c', points: d.days.map((x) => [at(x.date), x.netInflow] as [number, number]), format: (v) => fmtUsd(v) }];
    const cum = d.days.filter((x) => x.cumNetInflow !== null).map((x) => [at(x.date), x.cumNetInflow!] as [number, number]);
    if (cum.length > 1) out.push({ key: 'cum', kind: 'line', color: '#f7f7f7', points: cum, scale: 'left', format: (v) => fmtUsd(v, false), title: 'Total' });
    return out;
  }, [d]);

  return (
    <div className="mc">
      <div className="mc__bar">
        <div className="mc__seg" role="radiogroup" aria-label="Asset">
          {(d?.assets?.length ? d.assets : ['BTC', 'ETH', 'SOL']).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={asset === a} className={asset === a ? 'is-on' : ''} onClick={() => setAsset(a)}>
              <CoinIcon coin={a} size={12} />{a}
            </button>
          ))}
        </div>
        <span className="mc__spacer" />
        <div className="mc__seg" role="radiogroup" aria-label="Range">
          {RANGES.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={range === v} className={range === v ? 'is-on' : ''} onClick={() => setRange(v)}>{label}</button>
          ))}
        </div>
      </div>

      {r.error && !d ? <EmptyState icon="news" title="ETF flows did not load" line={r.error} />
        : !d ? <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Loading…</p>
        : (
          <>
            <div className="mc__stats">
              <div><span>Net flow{last ? ` · ${new Date(`${last.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : ''}</span><b className={last && last.netInflow > 0 ? 'is-up' : last && last.netInflow < 0 ? 'is-down' : ''}>{fmtUsd(last?.netInflow)}</b></div>
              <div><span>Total net inflow</span><b>{fmtUsd(last?.cumNetInflow)}</b></div>
              <div><span>Net assets</span><b>{fmtUsd(last?.totalNetAssets, false)}</b></div>
              <div><span>Traded</span><b>{fmtUsd(last?.valueTraded, false)}</b></div>
            </div>
            <SeriesChart series={series} height={190} span={rangeSpan(range)} />
            {d.funds.length > 0 && (
              <table className="mc__table">
                <thead><tr><th>Fund</th><th className="num">Net flow</th><th className="num">Net assets</th></tr></thead>
                <tbody>
                  {d.funds.slice(0, 14).map((f) => (
                    <tr key={f.ticker}>
                      <td><b>{f.ticker}</b> <span className="mc__dim">{f.name}</span></td>
                      <td className={`num ${f.netInflow && f.netInflow > 0 ? 'is-up' : f.netInflow && f.netInflow < 0 ? 'is-down' : ''}`}>{fmtUsd(f.netInflow)}</td>
                      <td className="num">{fmtUsd(f.netAssets, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      <div className="mc__credit"><PoweredBy /></div>
    </div>
  );
}
