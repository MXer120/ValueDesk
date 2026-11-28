/**
 * Macro on the Wealth page (owner 2026-11-28: "theres a macro element calendar & fed stuff", then "switch to too other
 * macro data not only fed in the same element"). What moves the funds on this page, from ValueDesk's own sources:
 *   one card with a switch: the Fed (the target range, the next FOMC decision, today's dollar yields from SoDEX's
 *   7-day APYs), inflation, jobs and growth (each the agency's own series through /api/vs/indicator: BLS, BEA, DOL,
 *   the Fed), and under every view the two market clocks the funds trade on (SoDEX's trading status)
 *   the economic calendar beside it (WealthCalendar.tsx)
 * The Fed's rate odds widget stays off (licence review 2026-10-28, macro/fomcFlag.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from './parts';
import { Icon, StatusPill } from '../bots/kit/kit';
import { ViewSeg } from './RangePicker';
import { WealthCalendar } from './WealthCalendar';
import { fmtValue, macroApi, type Indicator } from '../macro/api';
import { useAsync } from '../../hooks';
import { DASH } from '../../format';
import { pollEvery } from '../../exchange/visibility';
import { readTradingStatus, type TradingStatus } from '../../trading/wealth';
import { EARN_FUND } from '../../trading/wealthEarn';
import type { WealthState } from './useWealth';
import './wealthHero.css';

const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function until(t: number, now: number): string {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m >= 1440) return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}
const apyOf = (raw: string | undefined): number | null => (raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : null);

type View = 'fed' | 'inflation' | 'jobs' | 'growth';
const VIEWS: ReadonlyArray<readonly [View, string]> = [['fed', 'Fed'], ['inflation', 'Inflation'], ['jobs', 'Jobs'], ['growth', 'Growth']];
/** The series each view shows, as /api/vs/indicators names them, with the short name the tile uses. */
const SERIES: Readonly<Record<Exclude<View, 'fed'>, ReadonlyArray<readonly [id: string, label: string]>>> = {
  inflation: [['cpi_yy', 'CPI, y/y'], ['core_cpi_yy', 'Core CPI, y/y'], ['core_pce_yy', 'Core PCE, y/y'], ['ppi_yy', 'PPI, y/y']],
  jobs: [['payrolls', 'Nonfarm payrolls'], ['unemployment', 'Unemployment rate'], ['ahe_yy', 'Hourly earnings, y/y'], ['initial_claims', 'Jobless claims, weekly']],
  growth: [['gdp', 'Real GDP, annual rate'], ['retail_mm', 'Retail sales, m/m'], ['ip_mm', 'Industrial output, m/m'], ['durables_mm', 'Durable goods, m/m']],
};

/** A series read once per page view for ten minutes: switching back and forth asks nothing again. */
const seriesCache = new Map<string, { at: number; p: Promise<Indicator> }>();
function readSeries(id: string): Promise<Indicator> {
  const hit = seriesCache.get(id);
  if (hit && Date.now() - hit.at < 600_000) return hit.p;
  const p = macroApi.indicator(id, '1y');
  seriesCache.set(id, { at: Date.now(), p });
  p.catch(() => seriesCache.delete(id));
  return p;
}

/** Two clocks: a US ETF (vQQQ) and a China vault (UNITREE), read once a minute while the page is shown. */
function useClocks(): { us: TradingStatus | null; cn: TradingStatus | null } {
  const [s, setS] = useState<{ us: TradingStatus | null; cn: TradingStatus | null }>({ us: null, cn: null });
  useEffect(() => {
    let off = false;
    const read = () => void Promise.allSettled([readTradingStatus('vQQQ'), readTradingStatus('UNITREE')]).then(([a, b]) => {
      if (!off) setS({ us: a.status === 'fulfilled' ? a.value : null, cn: b.status === 'fulfilled' ? b.value : null });
    });
    read();
    const stop = pollEvery(60_000, read);
    return () => { off = true; stop(); };
  }, []);
  return s;
}

function usClock(t: TradingStatus | null, marketStatus: string | undefined, now: number): { state: string; line: string; live: boolean } {
  if (!t) return { state: DASH, line: 'US ETFs on the order book', live: false };
  const next = t.nextChannelAt ? t.nextChannelAt * 1000 : null;
  if (t.channel === 'clob') {
    const after = marketStatus === 'AFTER_HOURS' ? 'After hours' : marketStatus === 'PRE_MARKET' ? 'Pre-market' : 'Open';
    return { state: after, line: next ? `Order book closes ${until(next, now)}` : 'Order book open', live: true };
  }
  return { state: 'Closed', line: next ? `Opens ${when(next)} (${until(next, now)})` : 'Order book closed', live: false };
}

/** China vaults: maker quotes during the session, else a batch priced at the next Shanghai open (01:30 UTC, measured). */
function cnClock(t: TradingStatus | null, now: number): { state: string; line: string; live: boolean } {
  if (!t) return { state: DASH, line: 'China vaults', live: false };
  if (t.channel === 'rfq') return { state: 'Session', line: 'Maker quotes: the price is locked when you click', live: true };
  if (t.channel === 'batch' && t.batch?.cutoffAt) {
    const priced = (t.batch.cutoffAt + 3600) * 1000;
    return { state: 'Batch', line: `Requests priced at the Shanghai open, ${when(priced)} (${until(priced, now)})`, live: false };
  }
  return { state: 'Closed', line: t.nextChannelAt ? `Opens ${when(t.nextChannelAt * 1000)}` : 'Closed', live: false };
}

/** A year of a series: a thin line, the last point marked; nothing drawn under two points. */
function Line({ points }: { points: ReadonlyArray<readonly [number, number]> }) {
  if (points.length < 2) return <span className="wh-ind__line" aria-hidden="true" />;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const W = 120;
  const H = 30;
  const xy = vs.map((v, i) => [(i / (vs.length - 1)) * W, H - 3 - ((v - lo) / span) * (H - 6)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const [lx, ly] = xy[xy.length - 1]!;
  return (
    <svg className="wh-ind__line" viewBox={`-3 0 ${W + 6} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2.6" />
    </svg>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The agency's period in the reader's dates: "September 2026" as "Sep 2026", "Week of 2026-10-31" as "31 Oct". */
function shortPeriod(period: string): string {
  const wk = /^Week of (\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (wk) return new Date(Date.UTC(+wk[1]!, +wk[2]! - 1, +wk[3]!)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const mo = /^([A-Z][a-z]+) (\d{4})$/.exec(period);
  const i = mo ? MONTHS.indexOf(mo[1]!) : -1;
  if (mo && i >= 0) return new Date(Date.UTC(+mo[2]!, i, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return period;
}

function SeriesView({ view, now }: { view: Exclude<View, 'fed'>; now: number }) {
  const list = SERIES[view];
  const read = useAsync(() => Promise.allSettled(list.map(([id]) => readSeries(id))), [view]);
  const rows = read.data;
  const sources = useMemo(() => [...new Set((rows ?? []).flatMap((r) => (r.status === 'fulfilled' ? [r.value.source.name] : [])))], [rows]);
  return (
    <>
      <div className="wh-inds">
        {list.map(([id, label], i) => {
          const r = rows?.[i];
          const s = r?.status === 'fulfilled' ? r.value : null;
          const latest = s?.latest ?? null;
          return (
            <div key={id} className="wh-ind" title={s ? `${s.name}, ${s.source.name}` : undefined}>
              <span className="wh-ind__n">{label}</span>
              <b className="wh-ind__v">{!rows ? <span className="wh-ind__bone" /> : latest ? fmtValue(s!.unit, latest.value) : DASH}</b>
              <small className="wh-ind__p">
                {latest ? <>{shortPeriod(latest.period)}{latest.prior !== null && <> · prior {fmtValue(s!.unit, latest.prior)}</>}</> : rows ? 'Not read' : ''}
              </small>
              <Line points={(s?.points ?? []).slice(-13)} />
              <small className="wh-ind__next" title={s?.next ? when(s.next.time) : undefined}>{s?.next && <><Icon name="clock" size={11} />{until(s.next.time, now)}</>}</small>
            </div>
          );
        })}
      </div>
      {sources.length > 0 && <p className="wh-macro__note">{`The agencies' own series: ${sources.join(', ')}. A year, monthly or weekly as published.`}</p>}
    </>
  );
}

function FedView({ w, now }: { w: WealthState; now: number }) {
  const upper = useAsync(() => readSeries('fed_upper'), []);
  const lower = useAsync(() => readSeries('fed_lower'), []);
  const up = upper.data?.latest?.value ?? null;
  const lo = lower.data?.latest?.value ?? null;
  const nextFomc = upper.data?.next?.time ?? null;
  const since = upper.data?.latest?.period ?? null;
  const earn = apyOf(w.quotes.get(EARN_FUND)?.apy7d);
  const boxx = apyOf(w.quotes.get('vBOXX')?.apy7d);
  return (
    <>
      <div className="wh-fed">
        <div className="wh-fed__rate">
          <span>Fed funds target</span>
          <b>{up !== null && lo !== null ? `${lo.toFixed(2)}–${up.toFixed(2)}%` : DASH}</b>
          {since && <small>{`Set ${new Date(`${since}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, Federal Reserve`}</small>}
        </div>
        <div className="wh-fed__next">
          <span>Next FOMC decision</span>
          <b>{nextFomc ? when(nextFomc) : DASH}</b>
          {nextFomc && <small>{until(nextFomc, now)}</small>}
        </div>
      </div>
      <div className="wh-yields" aria-label="Dollar yields now">
        <div><span>USDC Earn</span><b>{earn === null ? DASH : `${earn.toFixed(2)}%`}</b></div>
        <div><span>US Cash Yield</span><b>{boxx === null ? DASH : `${boxx.toFixed(2)}%`}</b></div>
        <div><span>Fed upper bound</span><b>{up === null ? DASH : `${up.toFixed(2)}%`}</b></div>
      </div>
      <p className="wh-macro__note">7-day APYs, SoDEX. Dollar yields follow the Fed’s rate; a cut lowers them.</p>
    </>
  );
}

export function WealthMacro({ w }: { w: WealthState }) {
  const [view, setView] = useState<View>('fed');
  const clocks = useClocks();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => pollEvery(30_000, () => setNow(Date.now())), []);
  const us = usClock(clocks.us, w.quotes.get('vQQQ')?.marketStatus, now);
  const cn = cnClock(clocks.cn, now);
  return (
    <div className="wh-macro">
      {/* Coming soon (owner 2026-11-28): the macro card stays drawn but blurred and out of reach. */}
      <div className="wh-soon">
      <div className="wh-soon__in" aria-hidden="true" {...{ inert: "" }}>
      <Card title="Macro" action={<ViewSeg value={view} options={VIEWS} onChange={setView} label="Macro data" />} className="wh-macro__rates">
        <div className="wh-macro__view" key={view}>
          {view === 'fed' ? <FedView w={w} now={now} /> : <SeriesView view={view} now={now} />}
        </div>
        <ul className="wh-clocks" aria-label="Market clocks">
          <li><span className={`wh-dot${us.live ? ' is-live' : ''}`} aria-hidden="true" /><b>US ETFs</b><em>{us.state}</em><small>{us.line}</small></li>
          <li><span className={`wh-dot${cn.live ? ' is-live' : ''}`} aria-hidden="true" /><b>China vaults</b><em>{cn.state}</em><small>{cn.line}</small></li>
        </ul>
      </Card>
      </div>
      <div className="tf wh-soon__veil"><StatusPill tone="brand" icon="clock">Coming soon</StatusPill><span>Macro data: rates, Fed and market clocks</span></div>
      </div>
      <WealthCalendar now={now} />
    </div>
  );
}
