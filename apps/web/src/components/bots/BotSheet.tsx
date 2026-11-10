/**
 * One bot in its own window, in the Settings shell (as a running algo's, RunningWindow.tsx):
 *
 *   Overview   what it did: volume, net PnL, fees, cost per $1M, what it holds; volume and PnL over time;
 *              where the money went (SoDEX's fee, ValueDesk's, the spread and the price); its orders now
 *   Trades     every fill: time, side, price, size, value
 *   Activity   every order, fill, hold and change, newest first
 *
 * Its controls sit on the overview: pause / resume, edit, stop, and delete once it has ended.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { FINAL_STATUSES, type AlgoEvent, type AlgoView } from '@copy-engine';
import { DASH, fmtDateTime, fmtQty, fmtTime, fmtUsd, signClass } from '../../format';
import { Modal } from '../Modal';
import { isLight, useTheme } from '../../theme';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';
import { BotIcon } from './BotIcon';
import { STRATEGY_INFO, strategyOf } from '../../bots/presets';
import { useBotEvents } from '../../bots/useBots';
import { botName, fmtPnl, statusWords } from './botWords';

type Sec = 'overview' | 'trades' | 'activity';
const SECS: Record<Sec, { label: string; lede: string; icon: ReactNode }> = {
  overview: { label: 'Overview', lede: 'What it traded, what it cost and what it earned, at the price now.', icon: <path d="M3 14l4-5 3 3 5-7" /> },
  trades: { label: 'Trades', lede: 'Every fill, newest first. Every order rests on the book: each fill pays the maker fee.', icon: <path d="M4 5h12M4 10h12M4 15h8" /> },
  activity: { label: 'Activity', lede: 'Every order, fill, hold and change, newest first.', icon: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.5" /></> },
};

const SecIcon = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/** Volume per interval (bars, right axis) and net PnL (line, left axis) from the bot's book. */
/** `light`: the line is the page's ink, not near-white (it vanished on the light theme, 2026-11-10). */
export function botSeries(v: AlgoView, light = isLight()): ChartSeries[] {
  const pts = v.algo.book?.series ?? [];
  const bars: Array<[number, number]> = [];
  const pnl: Array<[number, number]> = [];
  let prev = 0;
  for (const [t, vol, net] of pts) {
    bars.push([t, Math.max(0, vol - prev)]);
    pnl.push([t, net]);
    prev = vol;
  }
  // The figures now, as the last point (the series samples every few minutes).
  if (v.bot && (!pts.length || Date.now() - pts[pts.length - 1]![0] > 60_000) && !FINAL_STATUSES.has(v.algo.status)) {
    bars.push([Date.now(), Math.max(0, v.bot.volume - prev)]);
    pnl.push([Date.now(), v.bot.netPnl]);
  }
  return [
    { key: 'vol', kind: 'bars', color: '#5b6b80', points: bars, format: (x) => fmtUsd(x, 0), title: 'Volume' },
    { key: 'pnl', kind: 'line', color: light ? '#1d2127' : '#f7f7f7', negColor: '#ef4a3c', points: pnl, scale: 'left', format: (x) => fmtUsd(x, 2), title: 'Net PnL' },
  ];
}

function Kpi({ k, v, cls, hint }: { k: string; v: ReactNode; cls?: string; hint?: string }) {
  return (
    <div className="bots-kpi" title={hint}>
      <span className="bots-kpi__k">{k}</span>
      <span className={`bots-kpi__v ${cls ?? ''}`}>{v}</span>
    </div>
  );
}

export function Overview({ v, actions }: { v: AlgoView; actions: ReactNode }) {
  const b = v.bot;
  const light = useTheme() === 'light';
  const series = useMemo(() => botSeries(v, light), [v, light]);
  const fees = b ? b.tradeFees + b.builderFees : 0;
  // A point every 5 minutes (bots.ts BOT_SAMPLE_MS): three make a chart worth drawing.
  const hasData = (v.algo.book?.series.length ?? 0) >= 3;
  return (
    <>
      <div className="algo-st__top">
        <span className="algo-st__status">{statusWords(v)}</span>
        <span className="algo-st__ctl">{actions}</span>
      </div>
      <div className="bots-kpis">
        <Kpi k="Volume" v={b ? fmtUsd(b.volume, 2) : DASH} />
        <Kpi k="Net PnL" v={b ? fmtPnl(b.netPnl) : DASH} cls={signClass(b?.netPnl)} hint="After every fee, with what it holds valued at the price now." />
        <Kpi k="Fees paid" v={b ? fmtUsd(fees, 2) : DASH} />
        <Kpi k="Cost per $1M" v={b?.costPerMillion !== null && b?.costPerMillion !== undefined ? (b.costPerMillion < 0 ? `earns ${fmtUsd(-b.costPerMillion, 0)}` : fmtUsd(b.costPerMillion, 0)) : DASH} cls={b && b.costPerMillion !== null && b.costPerMillion < 0 ? 'pos' : ''} hint="Net PnL per $1M traded, with the sign turned: what the volume cost after what it earned." />
        <Kpi k="Holding" v={b ? fmtUsd(b.inventoryUsd, 2) : DASH} hint="What it holds from its own fills, at the price now." />
      </div>
      <figure className="bots-chart">
        {hasData ? <SeriesChart series={series} height={210} daily={false} /> : <p className="oe-hint bots-chart__wait">The chart starts after its first 15 minutes: volume as bars, net PnL as the line, one point every 5 minutes.</p>}
        <figcaption><span className="bots-key is-vol" />Volume per interval<span className="bots-key is-pnl" />Net PnL</figcaption>
      </figure>
      <div className="bots-split">
        <section className="bots-box">
          <h4>Where the money went</h4>
          <dl className="bots-ledger">
            <dt>Spread and price</dt><dd className={signClass(b?.grossPnl)}>{b ? fmtPnl(b.grossPnl) : DASH}</dd>
            <dt>SoDEX trading fees</dt><dd>{b ? `−${fmtUsd(b.tradeFees, 2)}` : DASH}</dd>
            <dt>ValueDesk fee</dt><dd>{b ? `−${fmtUsd(b.builderFees, 2)}` : DASH}</dd>
            <dt className="is-total">Net PnL</dt><dd className={`is-total ${signClass(b?.netPnl)}`}>{b ? fmtPnl(b.netPnl) : DASH}</dd>
          </dl>
          <p className="bots-fine">{b ? `${b.fills} fills, ${Math.round(b.makerShare * 100)}% resting (maker). Fees are estimated at SoDEX's maker rate and your bot fee; SoDEX's own trades list the exact ones.` : ''}</p>
        </section>
        <section className="bots-box">
          <h4>On the book now</h4>
          {b && b.orders.length ? (
            <table className="bots-mini">
              <thead><tr><th>Side</th><th>Price</th><th>Size</th></tr></thead>
              <tbody>
                {[...b.orders].sort((x, y) => y.price - x.price).slice(0, 12).map((o) => (
                  <tr key={`${o.tag}-${o.price}`}>
                    <td><span className={`bots-side is-${o.side}`}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                    <td>{fmtUsd(o.price)}</td>
                    <td>{fmtQty(o.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="oe-hint">{FINAL_STATUSES.has(v.algo.status) ? 'Nothing: it has ended.' : b?.closing ? 'Closing what it holds.' : 'No order resting right now.'}</p>
          )}
        </section>
      </div>
    </>
  );
}

export function Trades({ events }: { events: AlgoEvent[] | null }) {
  const fills = (events ?? []).filter((e) => e.kind === 'fill' && e.price !== null && e.qty !== null);
  if (!events) return <p className="oe-hint">Reading its trades…</p>;
  if (!fills.length) return <p className="oe-hint">No fill yet. Its orders rest at the best price and fill when the market trades into them.</p>;
  return (
    <div className="algo-pvw__tablewrap">
      <table className="algo-pvw__table bots-trades">
        <thead><tr><th>Time</th><th>Side</th><th>Price</th><th>Size</th><th>Value</th></tr></thead>
        <tbody>
          {fills.map((e) => (
            <tr key={e.id}>
              <td>{fmtDateTime(e.at)}</td>
              <td><span className={`bots-side is-${e.side ?? 'buy'}`}>{e.side === 'sell' ? 'Sell' : 'Buy'}</span></td>
              <td>{fmtUsd(e.price!)}</td>
              <td>{fmtQty(e.qty!)}</td>
              <td>{fmtUsd(e.price! * e.qty!, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KIND_WORD: Record<AlgoEvent['kind'], string> = { status: 'Status', order: 'Order', fill: 'Fill', cancel: 'Cancel', skip: 'Skip', error: 'Error', info: 'Info' };

export function Activity({ events, error }: { events: AlgoEvent[] | null; error: string | null }) {
  if (error && !events) return <p className="fx-note fx-note--err">{error}</p>;
  if (!events) return <p className="oe-hint">Reading its log…</p>;
  if (!events.length) return <p className="oe-hint">Nothing yet.</p>;
  return (
    <ol className="bots-log">
      {events.map((e) => (
        <li key={e.id}>
          <time>{fmtTime(e.at)}</time>
          <span className={`bots-logk is-${e.kind}`}>{KIND_WORD[e.kind]}</span>
          <span className="bots-logt">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function BotSheet({ v, open, onClose, actions }: { v: AlgoView; open: boolean; onClose: () => void; actions: ReactNode }) {
  const [sec, setSec] = useState<Sec>('overview');
  const strategy = strategyOf(v.algo.spec) ?? 'maker';
  const { events, error } = useBotEvents(v.algo.id, open && sec !== 'overview');
  const name = botName(v);
  const cur = SECS[sec];
  return (
    <Modal open={open} onClose={onClose} title={name} size="lg" className={`stg algo-sheet bots-sheet${v.algo.spec.paper ? ' is-paper' : ''}`}>
      <div className="stg__body">
        <nav className="stg__nav" aria-label={`${name} sections`}>
          <div className="stg__brand"><BotIcon strategy={strategy} size={22} /><span>{name}</span></div>
          <span className="bots-navsub">{STRATEGY_INFO[strategy].name} · {v.algo.spec.symbol}</span>
          {v.algo.spec.paper && <span className="algo-practice algo-practice--nav">Practice · no real orders</span>}
          <span className="stg__rule" aria-hidden="true" />
          <div className="stg__tabs">
            {(Object.keys(SECS) as Sec[]).map((id) => (
              <button key={id} type="button" className={`stg__tab${sec === id ? ' is-on' : ''}`} aria-current={sec === id ? 'page' : undefined} onClick={() => setSec(id)}>
                <SecIcon size={17}>{SECS[id].icon}</SecIcon>
                <span>{SECS[id].label}</span>
              </button>
            ))}
          </div>
          <span className="bots-navfoot">Started {fmtDateTime(v.algo.startedAt ?? v.algo.createdAt)}</span>
        </nav>
        <div className="stg__pane" key={sec}>
          <div className="stg__panehead"><SecIcon size={22}>{cur.icon}</SecIcon><h3>{cur.label}</h3></div>
          <p className="stg__lede">{cur.lede}</p>
          {sec === 'overview' && <Overview v={v} actions={actions} />}
          {sec === 'trades' && <Trades events={events} />}
          {sec === 'activity' && <Activity events={events} error={error} />}
        </div>
      </div>
    </Modal>
  );
}
