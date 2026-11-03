/**
 * WHO TRADED (owner 2026-11-01: "Make it possible to get the following trade info & more for each
 * candle & every timeframe across all supported platforms ... Use our own design & optimize UX").
 *
 * A panel beside the chart, so the chart stays in view (owner 2026-11-03). One candle of the chart's
 * interval - picked on the chart (click it while the panel is open, or right-click "Who traded this
 * candle"; it is lit there) or stepped here - broken down by wallet over the chosen platforms:
 *   - the summary: traded, the takers' buy/sell split, wallets, the top three's share, fills, VWAP;
 *   - a ranked table: lean (net bought, net sold, round trip), share, volume, buy/sell bias,
 *     fills, average buy and sell price, net size, taker share;
 *   - a wallet's fills in the candle (click a row): side, taker or maker, price, size, value,
 *     counterparty, time to the millisecond - a virtual list, so a hundred thousand rows scroll.
 * Data: the venues' public prints with both parties, kept by the indexer (server flow/). Nothing
 * here is estimated; a window before the recording began says so instead of showing zeros.
 * No wallet names: the owner's rule (server valuedesk/labels.ts) - an identicon and the address.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FlowWindow, FlowWindowRow, WalletFillsBody } from '@sign/flow/read.js';
import type { FlowRole, FlowSide, FlowSort } from '@sign/flow/codec.js';
import { vsApi, VENUE_LABEL, type Venue } from '../../vsApi';
import { usePolled } from '../explore/cohorts/parts';
import { fmtCount, fmtPx, fmtUsdExact, fmtUsdShort } from '../explore/model';
import { fmtNum } from '../../numStyle';
import { DASH, MINUS } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { Identicon } from '../Identicon';
import { PlatformSelect } from '../PlatformSelect';
import { copyText } from '../accountTables/IdCell';
import { coinOfSymbol } from '../../chart/liqMap';
import { candleAt, candleCount, flowSpan, stepCandle, windowText, type CandleWindow } from './flowWindow';
import { EmptyState } from '../EmptyState';
import { ViewPop } from '../ViewPop';
import { Section, Seg as ViewSeg } from '../accountTables/FilterBar';
import { useStored } from '../../hooks';
import '../leaderboard/LeaderboardPage.css';
import './TradeFlow.css';

/** Every platform whose prints name both parties (server indexer/streams.ts). */
export const FLOW_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
const PAGE = 100;
const MAX_ROWS = 500;
const FILL_ROW_H = 30;
/** Below this height the view is a short panel (thin summary). */
const SHORT_PX = 440;

/** "1H", "4H"; minutes and the long units as the chart spells them ("1m", "1D", "1M"). */
const ivLabel = (i: string) => (i.endsWith('h') ? i.toUpperCase() : i);
const pct = (v: number, dp = 0) => `${fmtNum(v * 100, { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`;
const fmtSz = (v: number) => fmtNum(v, { maximumSignificantDigits: 6 });
const signed = (v: number, f: (x: number) => string) => (v > 0 ? `+${f(v)}` : v < 0 ? `${MINUS}${f(-v)}` : f(0));
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);
const whoOf = (w: { address: string | null; key: string }) => w.address ?? w.key;
const clock = (t: number) => {
  const d = new Date(t);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
};

/** A CSV file from rows of cells, saved by the browser. */
function saveCsv(name: string, rows: Array<Array<string | number>>): void {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿', rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
}

// --- small parts --------------------------------------------------------------------------------

/** Net bought, net sold, round trip, nothing: an arrow, two arrows, a dash. */
function LeanIcon({ lean }: { lean: FlowWindowRow['lean'] }) {
  const title = lean === 'long' ? 'Net buyer' : lean === 'short' ? 'Net seller' : lean === 'round' ? 'Round trip: bought and sold about the same' : 'No fills';
  return (
    <span className={`tfl-lean is-${lean}`} title={title} aria-label={title}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {lean === 'long' && <path d="M3 9 9 3M4.5 3H9v4.5" />}
        {lean === 'short' && <path d="M3 3l6 6M9 4.5V9H4.5" />}
        {lean === 'round' && <path d="M2.5 4.5h7l-2-2M9.5 7.5h-7l2 2" />}
        {lean === 'flat' && <path d="M3 6h6" />}
      </svg>
    </span>
  );
}

/** Buy share against sell share, green against red, with its figures either side. */
function SplitBar({ buy, sell, buyLabel, sellLabel }: { buy: number; sell: number; buyLabel: string; sellLabel: string }) {
  const total = buy + sell;
  const b = total > 0 ? buy / total : 0.5;
  return (
    <div className="tfl-split">
      <div className={`tfl-split__bar${total > 0 ? '' : ' is-empty'}`} role="img" aria-label={total > 0 ? `${buyLabel} ${pct(b)}, ${sellLabel} ${pct(1 - b)}` : 'No volume'}>
        <i className="is-buy" style={{ width: `${b * 100}%` }} />
        <i className="is-sell" style={{ width: `${(1 - b) * 100}%` }} />
      </div>
      <div className="tfl-split__legend">
        <span><b className="pos">{buyLabel}</b> {total > 0 ? pct(b) : DASH}{total > 0 && <> <span className="tfl-dim" title={fmtUsdExact(buy)}>{fmtUsdShort(buy)}</span></>}</span>
        <span>{total > 0 && <><span className="tfl-dim" title={fmtUsdExact(sell)}>{fmtUsdShort(sell)}</span> </>}{total > 0 ? pct(1 - b) : DASH} <b className="neg">{sellLabel}</b></span>
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="tfl-stat" title={title}>
      <span className="tfl-stat__l">{label}</span>
      <span className="tfl-stat__v">{value}</span>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="lbp-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? 'is-on' : ''} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="tfl-icobtn" onClick={onClick} disabled={disabled} title="Download as CSV" aria-label="Download as CSV">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 12.5h10" />
      </svg>
      <span>CSV</span>
    </button>
  );
}

function Wallet({ w, size = 18 }: { w: { venue: Venue; address: string | null; key: string }; size?: number }) {
  const id = whoOf(w);
  return (
    <span className="tfl-who" title={`${VENUE_LABEL[w.venue]} · ${w.address ?? `account ${w.key}`}`}>
      <Identicon seed={id} size={size} />
      <span className="tfl-who__a">{w.address ? short(w.address) : `#${w.key}`}</span>
      <VenueLogo venue={w.venue} size={12} />
    </span>
  );
}

// --- the view -----------------------------------------------------------------------------------

export interface TradeFlowProps {
  /** The chart's symbol (any venue's spelling: BTC-USD, vBTC_vUSDC): its coin is read. */
  symbol: string;
  /** spot or perps (the chart's engine). */
  spot: boolean;
  /** The chart's interval, and a time inside the candle picked on it (null: the last closed candle). */
  interval: string;
  at: number | null;
  /** The other end of a range of candles (a time inside its last or first candle), null for one candle. */
  end: number | null;
  /** Pick other candles (a time inside the first, and the other end or null): the chart outlines them too. */
  onPick: (at: number, end: number | null) => void;
  onClose: () => void;
}

/** How a range is made, said where the pointer is: a touch screen has no modifier keys. */
const RANGE_TIP = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  ? 'Long-press another candle for a range'
  : `Shift-drag or ${typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}-click for a range`;

const ChevL = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const ChevR = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;

const CSV_HEAD = ['venue', 'wallet', 'lean', 'share', 'volume_usd', 'bought_usd', 'sold_usd', 'bought', 'sold', 'net', 'fills_buy', 'fills_sell', 'avg_buy', 'avg_sell', 'taker_share'];

export function TradeFlowView({ symbol, spot, interval, at, end, onPick, onClose }: TradeFlowProps) {
  const coin = coinOfSymbol(symbol);
  // The chart's candle: picked there, or stepped here; the chart's interval changing re-cuts it.
  const win = useMemo(() => flowSpan(interval, at, end), [interval, at, end]);
  const count = useMemo(() => candleCount(interval, win), [interval, win]);
  /** Prev / next move the whole range by its own length. */
  const step = (dir: -1 | 1) => {
    const first = stepCandle(interval, candleAt(interval, win.from), dir * count);
    onPick(first.from, count > 1 ? stepCandle(interval, candleAt(interval, win.to - 1), dir * count).from : null);
  };
  const offered: Venue[] = spot ? ['sodex'] : [...FLOW_VENUES];
  const [venues, setVenues] = useState<Venue[]>(offered);
  const [role, setRole] = useState<FlowRole>('all');
  const [side, setSide] = useState<FlowSide>('all');
  const [sort, setSort] = useState<FlowSort>('volume');
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<FlowWindowRow | null>(null);
  /** Shown large, over the page (a chart card is often too short for a table). */
  const [big, setBig] = useState(false);
  // A short panel (the trade page's chart card is ~300 px): the summary goes thin.
  const rootRef = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setShort(el.clientHeight > 0 && el.clientHeight < SHORT_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [big]);
  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [big]);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setOpen(null); setLimit(PAGE); }, [coin, win.from, win.to, venues.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const latest = candleAt(interval, now);
  const live = win.to > now;

  const kind = spot ? 'spot' as const : 'perp' as const;
  const key = `${coin}|${kind}|${venues.join(',')}|${win.from}|${win.to}|${role}|${side}|${sort}|${limit}|${query}`;
  const fetcher = useCallback(
    (s: AbortSignal) => vsApi.flow({ coin, venues, kind, from: win.from, to: win.to, role, side, sort, limit, ...(query.length >= 3 ? { q: query } : {}) }, s),
    [key], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // A candle still forming is read again every 15 s (the recorder's flush); a closed one once.
  const r = usePolled<FlowWindow>(key, fetcher, live ? 15_000 : 0);
  // The previous candle's answer while this one loads is not this candle's: skeletons, not "No trades".
  const d = r.stale ? null : r.data;
  const [cols, setCols] = useStored<string[]>('flow.cols', DEFAULT_COLS);
  const shownCols = COLS.filter((c) => !c.opt || cols.includes(c.key));
  const before = !!d && d.since !== null && d.to <= d.since;
  const csv = () => d && saveCsv(`who-traded-${coin}-${new Date(win.from).toISOString().slice(0, 16).replace(':', '')}.csv`, [
    CSV_HEAD,
    ...d.rows.map((x) => [x.venue, whoOf(x), x.lean, x.share, x.vol, x.buyNtl, x.sellNtl, x.buySz, x.sellSz, x.net, x.buyN, x.sellN, x.buyPx ?? '', x.sellPx ?? '', x.takerShare ?? '']),
  ]);

  const view = (
    <div ref={rootRef} className={`tfl${big ? ' tfl--big' : ''}${short ? ' is-short' : ''}`} role={big ? 'dialog' : undefined} aria-label={big ? `Who traded ${coin}` : undefined}>
      <div className="tfl-bar">
        <div className="tfl-title">
          <CoinIcon coin={coin} size={18} />
          <b>Who traded <span className="tfl-title__coin">{coin}</span></b>
        </div>
        <div className="tfl-bar__end">
          <PlatformSelect options={offered} value={venues} onChange={setVenues} align="end" />
          <button type="button" className="tfl-icobtn tfl-expand" onClick={() => setBig((b) => !b)} aria-label={big ? 'Back beside the chart' : 'Expand'} title={big ? 'Back beside the chart (Esc)' : 'Expand'}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {big ? <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2 2M9.5 9.5 14 14" /> : <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5 7 7M13.5 13.5 9 9" />}
            </svg>
          </button>
          <button type="button" className="tfl-icobtn" onClick={() => { setBig(false); onClose(); }} aria-label="Close Who traded" title="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </div>

      {/* The candle: the chart's interval and the one picked there, stepped here. */}
      <div className="tfl-candle">
        <button type="button" className="tfl-icobtn" aria-label={count > 1 ? 'Previous range' : 'Previous candle'} title={count > 1 ? `The ${count} candles before` : 'Previous candle'} onClick={() => step(-1)}><ChevL /></button>
        <div className="tfl-candle__when" aria-live="polite">
          <span className="tfl-candle__top">
            <span className="tfl-pill is-pick" title={count > 1 ? `${fmtCount(count)} candles of the chart's timeframe` : "The chart's timeframe"}>{count > 1 ? `${fmtCount(count)} × ${ivLabel(interval)}` : ivLabel(interval)}</span>
            {live && <span className="tfl-pill is-live">Forming</span>}
            {count > 1
              ? <button type="button" className="tfl-candle__one" onClick={() => onPick(win.from, null)} title="Back to the first candle alone">One candle</button>
              : !live && <span className="tfl-candle__tip">{RANGE_TIP}</span>}
          </span>
          <b>{windowText(win)}</b>
        </div>
        <button type="button" className="tfl-icobtn" aria-label={count > 1 ? 'Next range' : 'Next candle'} title={count > 1 ? `The ${count} candles after` : 'Next candle'} disabled={live} onClick={() => step(1)}><ChevR /></button>
        <button type="button" className={`tfl-latest${win.from === latest.from ? ' is-on' : ''}`} onClick={() => onPick(latest.from, null)} title="The candle still forming">Live</button>
      </div>

      <div className={`tfl-scroll${open ? ' is-wallet' : ''}`}>
        {open ? (
          <WalletView coin={coin} kind={kind} venues={venues} win={win} row={open} live={live} onBack={() => setOpen(null)} />
        ) : (
          <div className="tfl-body">
            <Summary d={d && !before && d.markets.length ? d : null} role={role} loading={r.loading && !d} />
            <Partial d={d} />
            <div className="tfl-filters">
              <label className="lbp-search tfl-search">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" strokeLinecap="round" /></svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a wallet or account id" aria-label="Find a wallet" spellCheck={false} />
              </label>
              <TableView cols={cols} onCols={setCols} role={role} onRole={setRole} side={side} onSide={setSide} sort={sort} onSort={setSort} />
              <CsvButton disabled={!d?.rows.length} onClick={csv} />
            </div>
            <Table
              d={d} coin={coin} cols={shownCols} sort={sort} onSort={setSort} loading={r.loading} error={r.error} onOpen={setOpen}
              empty={<TableEmpty d={d} coin={coin} live={live} query={query} venues={venues} offered={offered} onAll={() => setVenues(offered)} onRetry={r.retry} error={r.error} />}
            />
            {d && d.rows.length >= limit && limit < MAX_ROWS && (
              <button type="button" className="tfl-more" onClick={() => setLimit((l) => Math.min(MAX_ROWS, l + 200))}>Show more wallets</button>
            )}
            <Coverage d={d} venues={venues} />
          </div>
        )}
      </div>
    </div>
  );
  if (!big) return view;
  return (
    <>
      <div className="tfl tfl-parked"><button type="button" className="tfl-more" onClick={() => setBig(false)}>Show beside the chart</button></div>
      {createPortal(<div className="tfl-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setBig(false); }}>{view}</div>, document.body)}
    </>
  );
}

function Summary({ d, role, loading }: { d: FlowWindow | null; role: FlowRole; loading: boolean }) {
  const s = d?.summary;
  const v = (x: ReactNode) => (loading ? <i className="tfl-skelv" aria-hidden="true" /> : x);
  return (
    <section className="tfl-sum" aria-label="Candle summary" aria-busy={loading}>
      <div className="tfl-sum__row">
        <div className="tfl-sum__lead">
          <span className="tfl-stat__l">Traded</span>
          <span className="tfl-sum__big" title={fmtUsdExact(s?.total)}>{v(s ? fmtUsdShort(s.total) : DASH)}</span>
        </div>
        <div className="tfl-sum__stats">
          <Stat label={role === 'all' ? 'Wallets' : role === 'taker' ? 'Takers' : 'Makers'} value={v(s ? fmtCount(s.wallets) : DASH)} />
          <Stat label="Top 10" value={v(s && s.wallets && s.top10 !== undefined ? pct(s.top10) : DASH)} title="The ten largest wallets' share of the volume shown" />
          <Stat label="Fills" value={v(s ? fmtCount(s.prints) : DASH)} title="Prints (one per match; each has a buyer and a seller)" />
          <Stat label="VWAP" value={v(s?.vwap ? fmtPx(s.vwap) : DASH)} />
        </div>
      </div>
      <SplitBar buy={s?.takerBuy ?? 0} sell={s?.takerSell ?? 0} buyLabel="Taker buys" sellLabel="Taker sells" />
    </section>
  );
}

interface Col { key: string; label: string; sort?: FlowSort; cls: string; title?: string; opt: boolean; w: string; min: number }
/** The table's columns: the wallet always, the rest on or off under View (a row's grid is built from the ones on). */
const COLS: Col[] = [
  { key: 'who', label: 'Wallet', cls: 'c-who', opt: false, w: 'minmax(108px, 1.5fr)', min: 108 },
  { key: 'share', label: 'Share', cls: 'c-share', opt: true, w: 'minmax(46px, 0.6fr)', min: 46 },
  { key: 'vol', label: 'Volume', sort: 'volume', cls: 'c-num c-vol', opt: true, w: '62px', min: 62 },
  { key: 'bias', label: 'Bias', cls: 'c-bias', title: 'Bought against sold (USD)', opt: true, w: 'minmax(46px, 0.6fr)', min: 46 },
  { key: 'fills', label: 'Fills', sort: 'fills', cls: 'c-num c-fills', opt: true, w: '38px', min: 38 },
  { key: 'px', label: 'Avg buy / sell', cls: 'c-num c-px', opt: true, w: '92px', min: 92 },
  { key: 'net', label: 'Net', sort: 'net', cls: 'c-num c-net', title: 'Bought minus sold, in the coin', opt: true, w: '80px', min: 80 },
  { key: 'tk', label: 'Taker', cls: 'c-num c-tk', title: 'Share of its volume it took liquidity for', opt: true, w: '46px', min: 46 },
];
const DEFAULT_COLS = ['share', 'vol', 'bias', 'fills'];
const ROW_GAP = 6;
const ROW_PAD = 8;

const SlidersGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" /><circle cx="10.5" cy="4.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.5" cy="11.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /></svg>
);

/** The table's View: which columns show, whose fills (takers, makers) and which side, the order. */
function TableView({ cols, onCols, role, onRole, side, onSide, sort, onSort }: {
  cols: string[]; onCols: (c: string[]) => void;
  role: FlowRole; onRole: (r: FlowRole) => void;
  side: FlowSide; onSide: (s: FlowSide) => void;
  sort: FlowSort; onSort: (s: FlowSort) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const colsChanged = cols.length !== DEFAULT_COLS.length || DEFAULT_COLS.some((c) => !cols.includes(c));
  const count = (colsChanged ? 1 : 0) + (role !== 'all' ? 1 : 0) + (side !== 'all' ? 1 : 0) + (sort !== 'volume' ? 1 : 0);
  const toggle = (k: string) => onCols(cols.includes(k) ? cols.filter((c) => c !== k) : COLS.filter((c) => c.key === k || cols.includes(c.key)).map((c) => c.key));
  const optional = COLS.filter((c) => c.opt);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`acctf-view tfl-view${open ? ' is-open' : ''}${count > 0 ? ' is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersGlyph />
        <span>View</span>
        {count > 0 && <span className="acctf-count">{count}</span>}
      </button>
      <ViewPop
        open={open}
        anchor={btn}
        onClose={() => setOpen(false)}
        onReset={() => { onCols(DEFAULT_COLS); onRole('all'); onSide('all'); onSort('volume'); }}
        resetDisabled={count === 0}
      >
        <Section label="Side">
          <ViewSeg<FlowSide> value={side} onChange={onSide} options={[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']]} tones={{ buy: 'pos', sell: 'neg' }} />
        </Section>
        <Section label="Who">
          <ViewSeg<FlowRole> value={role} onChange={onRole} options={[['all', 'All'], ['taker', 'Takers'], ['maker', 'Makers']]} />
        </Section>
        <Section label="Sort">
          <ViewSeg<FlowSort> value={sort} onChange={onSort} options={[['volume', 'Volume'], ['fills', 'Fills'], ['net', 'Net']]} />
        </Section>
        <Section label="Columns">
          <div className="acctf-seg" role="group" aria-label="Columns" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {optional.map((c) => {
              const on = cols.includes(c.key);
              return <button key={c.key} type="button" aria-pressed={on} className={on ? 'is-on' : ''} onClick={() => toggle(c.key)}>{c.key === 'px' ? 'Avg price' : c.label}</button>;
            })}
          </div>
        </Section>
      </ViewPop>
    </>
  );
}

/** What the table says when it has no rows: an error, before the recording, not listed, a search, a quiet candle. */
function TableEmpty({ d, coin, live, query, venues, offered, onAll, onRetry, error }: {
  d: FlowWindow | null; coin: string; live: boolean; query: string; venues: Venue[]; offered: Venue[]; onAll: () => void; onRetry: () => void; error: string | null;
}) {
  const names = (vs: Venue[]) => (vs.length === offered.length ? 'any platform' : vs.map((v) => VENUE_LABEL[v]).join(', '));
  if (error && !d) {
    return <EmptyState compact icon="alert" title="Couldn't load who traded" line={error} action={<button type="button" className="tfl-cta" onClick={onRetry}>Try again</button>} />;
  }
  if (!d) return null;
  if (d.since !== null && d.to <= d.since) {
    return <EmptyState compact icon="history" title="Before the recording began" line={`Every trade is kept from ${new Date(d.since).toUTCString().slice(5, 22)} UTC. Pick a later candle.`} />;
  }
  if (!d.markets.length) {
    return (
      <EmptyState
        compact
        icon="search"
        title={`${coin} isn't traded on ${names(venues)}`}
        line={venues.length < offered.length ? 'Other platforms may list it.' : 'None of the platforms we record lists this market.'}
        action={venues.length < offered.length ? <button type="button" className="tfl-cta" onClick={onAll}>Show all platforms</button> : undefined}
      />
    );
  }
  if (query.length >= 3) return <EmptyState compact icon="search" title="No wallet matches" line={`Nothing in this candle contains “${query}”.`} />;
  if (live) return <EmptyState compact icon="chart" title="No trades yet" line="This candle is still forming. Trades show here within 15 seconds." />;
  return <EmptyState compact icon="chart" title="No trades in this candle" line={`Nobody traded ${coin} on ${names(venues)} in this window.`} />;
}

function Table({ d, coin, cols, sort, onSort, loading, error, onOpen, empty }: {
  d: FlowWindow | null; coin: string; cols: Col[]; sort: FlowSort; onSort: (s: FlowSort) => void; loading: boolean; error: string | null; onOpen: (r: FlowWindowRow) => void; empty: ReactNode;
}) {
  const max = d?.rows.reduce((m, x) => Math.max(m, x.share), 0) ?? 0;
  const rows = d?.rows ?? [];
  const waiting = !d && !error && loading;
  const on = new Set(cols.map((c) => c.key));
  // Wider than the panel (many columns on a narrow one): the table scrolls sideways, the wallet stays readable.
  const grid = {
    '--cols': cols.map((c) => c.w).join(' '),
    minWidth: cols.reduce((s, c) => s + c.min, 0) + ROW_GAP * (cols.length - 1) + ROW_PAD * 2,
  } as CSSProperties;
  return (
    <div className="tfl-table" style={grid} role="table" aria-label="Wallets in this candle" aria-busy={loading}>
      <div className="tfl-tr tfl-th" role="row">
        {cols.map((c) => (
          <span key={c.key} role="columnheader" className={c.cls} title={c.title} aria-sort={c.sort === sort ? 'descending' : undefined}>
            {c.sort ? <button type="button" className={c.sort === sort ? 'is-on' : ''} onClick={() => onSort(c.sort!)}>{c.label}{c.sort === sort ? ' ↓' : ''}</button> : c.label}
          </span>
        ))}
      </div>
      {waiting && Array.from({ length: 6 }, (_, i) => <div key={i} className="tfl-tr tfl-skel" aria-hidden="true"><i /></div>)}
      {!rows.length && !waiting && <div className="tfl-tr--empty">{empty}</div>}
      {rows.map((x) => {
        const bias = x.buyNtl + x.sellNtl > 0 ? x.buyNtl / (x.buyNtl + x.sellNtl) : 0.5;
        return (
          <button type="button" key={`${x.venue}|${x.key}`} className="tfl-tr" role="row" onClick={() => onOpen(x)} aria-label={`${x.address ?? x.key} on ${VENUE_LABEL[x.venue]}: ${fmtUsdShort(x.vol)}. Show its fills`}>
            <span className="c-who" role="cell"><LeanIcon lean={x.lean} /><Wallet w={x} /></span>
            {on.has('share') && <span className="c-share" role="cell">
              <span className="tfl-share__n">{pct(x.share, x.share < 0.1 ? 1 : 0)}</span>
              <span className="tfl-share"><i style={{ width: `${max > 0 ? (x.share / max) * 100 : 0}%` }} /></span>
            </span>}
            {on.has('vol') && <span className="c-num c-vol" role="cell" title={fmtUsdExact(x.vol)}>{fmtUsdShort(x.vol)}</span>}
            {on.has('bias') && <span className="c-bias" role="cell" title={`Bought ${fmtUsdExact(x.buyNtl)} · sold ${fmtUsdExact(x.sellNtl)}`}>
              <span className="tfl-bias"><i className="is-buy" style={{ width: `${bias * 100}%` }} /><i className="is-sell" style={{ width: `${(1 - bias) * 100}%` }} /></span>
              <span className="tfl-bias__n"><span className="pos">{Math.round(bias * 100)}</span>/<span className="neg">{100 - Math.round(bias * 100)}</span></span>
            </span>}
            {on.has('fills') && <span className="c-num c-fills" role="cell" title={`${fmtCount(x.buyN)} buys · ${fmtCount(x.sellN)} sells`}>{fmtCount(x.buyN + x.sellN)}</span>}
            {on.has('px') && <span className="c-num c-px" role="cell">
              {x.buyPx !== null ? <span className="pos">{fmtPx(x.buyPx)}</span> : <span className="tfl-dim">{DASH}</span>}
              {x.sellPx !== null ? <span className="neg">{fmtPx(x.sellPx)}</span> : <span className="tfl-dim">{DASH}</span>}
            </span>}
            {on.has('net') && <span className={`c-num c-net ${x.net > 0 ? 'pos' : x.net < 0 ? 'neg' : 'tfl-dim'}`} role="cell" title={`${signed(x.net, fmtSz)} ${coin}`}>{signed(x.net, fmtSz)}</span>}
            {on.has('tk') && <span className="c-num c-tk tfl-dim" role="cell">{x.takerShare !== null ? pct(x.takerShare) : DASH}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A candle the recording does not cover whole: said above the table, not left to the footer. */
function Partial({ d }: { d: FlowWindow | null }) {
  if (!d || d.since === null || d.to <= d.since) return null;
  const late = d.since > d.from;
  const gapMs = d.gaps.reduce((s, [a, b]) => s + (b - a), 0);
  if (!late && !gapMs) return null;
  const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
  return (
    <div className="tfl-note" role="note">
      <span className="tfl-pill is-warn">{late ? 'Partial candle' : `${gapMs < 60_000 ? 'Under 1' : fmtNum(gapMs / 60_000, { maximumFractionDigits: 0 })} min not recorded`}</span>
      <span title={gapMs ? d.gaps.map(([a, b]) => `${new Date(a).toUTCString()} – ${new Date(b).toUTCString()}`).join('\n') : undefined}>
        {late ? `Recording began ${hm(d.since)} UTC: earlier trades in this candle are not counted.` : 'The recorder was down for part of this candle: those trades are not counted.'}
      </span>
    </div>
  );
}

/** Which chosen platforms list the coin (and since when), and which do not. */
function Coverage({ d, venues }: { d: FlowWindow | null; venues: Venue[] }) {
  if (!d) return null;
  const listed = new Set(d.markets.map((m) => m.venue));
  const missing = venues.filter((v) => !listed.has(v));
  return (
    <footer className="tfl-cov">
      <span className="tfl-cov__venues">
        {d.markets.map((m) => (
          <span key={`${m.venue}|${m.symbol}`} className="tfl-cov__m" title={`${VENUE_LABEL[m.venue]} ${m.symbol}: recorded from ${new Date(m.since).toUTCString()}`}>
            <VenueLogo venue={m.venue} size={12} />{m.symbol}
          </span>
        ))}
        {missing.map((v) => (
          <span key={v} className="tfl-cov__m is-off" title={`${VENUE_LABEL[v]} does not list ${d.coin}`}>
            <VenueLogo venue={v} size={12} />{VENUE_LABEL[v]}: not listed
          </span>
        ))}
      </span>
      <span className="tfl-dim tfl-cov__note">Every print of the venues' public trade streams, both sides. Wallets are shown by address.</span>
    </footer>
  );
}

// --- one wallet -----------------------------------------------------------------------------------

function WalletView({ coin, kind, venues, win, row, live, onBack }: {
  coin: string; kind: 'perp' | 'spot'; venues: Venue[]; win: CandleWindow; row: FlowWindowRow; live: boolean; onBack: () => void;
}) {
  const w = whoOf(row);
  const key = `w|${coin}|${kind}|${row.venue}|${w}|${win.from}|${win.to}`;
  const fetcher = useCallback((s: AbortSignal) => vsApi.flowWallet({ coin, kind, venues, from: win.from, to: win.to, w, venue: row.venue }, s), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = usePolled<WalletFillsBody>(key, fetcher, live ? 15_000 : 0);
  const d = r.stale ? null : r.data;
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [role, setRole] = useState<'all' | 'taker' | 'maker'>('all');
  // Indexes of the fills shown, newest first.
  const shown = useMemo(() => {
    if (!d) return [] as number[];
    const out: number[] = [];
    for (let i = d.fills.t.length - 1; i >= 0; i--) {
      if (side !== 'all' && d.fills.side[i] !== (side === 'buy' ? 1 : -1)) continue;
      if (role !== 'all' && d.fills.role[i] !== (role === 'taker' ? 0 : 1)) continue;
      out.push(i);
    }
    return out;
  }, [d, side, role]);
  return (
    <div className="tfl-body tfl-wallet">
      <div className="tfl-wallet__head">
        <button type="button" className="tfl-icobtn" onClick={onBack} aria-label="Back to all wallets" title="Back to all wallets">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <Identicon seed={w} size={32} />
        <div className="tfl-wallet__id">
          <b>{row.address ? short(row.address) : `${VENUE_LABEL[row.venue]} account ${row.key}`}</b>
          <span className="tfl-dim"><VenueLogo venue={row.venue} size={12} /> {VENUE_LABEL[row.venue]} · {fmtCount(d ? d.fills.t.length : row.buyN + row.sellN)} fills · {fmtUsdShort(d ? d.fills.px.reduce((s, p, i) => s + p * d.fills.sz[i]!, 0) : row.buyNtl + row.sellNtl)}</span>
        </div>
        <div className="tfl-wallet__acts">
          {row.address && <button type="button" className="tfl-icobtn" onClick={() => copyText(row.address!, 'Address copied')}>Copy address</button>}
          {row.address && <a className="tfl-icobtn" href={`/scan?address=${encodeURIComponent(row.address)}&venue=${row.venue}`}>Open profile</a>}
        </div>
      </div>
      <section className="tfl-sum">
        <div className="tfl-sum__stats tfl-sum__stats--wide">
          <Stat label="Net" value={<span className={row.net > 0 ? 'pos' : row.net < 0 ? 'neg' : ''}>{signed(row.net, fmtSz)} {coin}</span>} />
          <Stat label="Avg buy" value={<span className="pos">{row.buyPx !== null ? fmtPx(row.buyPx) : DASH}</span>} />
          <Stat label="Avg sell" value={<span className="neg">{row.sellPx !== null ? fmtPx(row.sellPx) : DASH}</span>} />
          <Stat label="Taker" value={row.takerShare !== null ? pct(row.takerShare) : DASH} title="Share of its volume it took liquidity for" />
          <Stat label="Share" value={pct(row.share, 1)} />
        </div>
        <SplitBar buy={row.buyNtl} sell={row.sellNtl} buyLabel="Bought" sellLabel="Sold" />
      </section>
      <div className="tfl-filters">
        <Seg value={side} label="Side" options={[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']]} onChange={setSide} />
        <Seg value={role} label="Role" options={[['all', 'All'], ['taker', 'Taker'], ['maker', 'Maker']]} onChange={setRole} />
        <span className="tfl-dim tfl-count">{d ? `${fmtCount(shown.length)} fills${d.capped ? ' (first 200,000)' : ''}` : ''}</span>
        <CsvButton disabled={!d?.fills.t.length} onClick={() => d && saveCsv(`fills-${coin}-${w.slice(0, 10)}.csv`, [
          ['time_utc', 'venue', 'side', 'role', 'price', 'size', 'value_usd', 'counterparty'],
          ...d.fills.t.map((t, i) => [new Date(t).toISOString(), d.venues[d.fills.venue[i]!]!, d.fills.side[i] === 1 ? 'buy' : 'sell', ['taker', 'maker', ''][d.fills.role[i]!]!, d.fills.px[i]!, d.fills.sz[i]!, d.fills.px[i]! * d.fills.sz[i]!, whoOf(d.others[d.fills.other[i]!]!)]),
        ])} />
      </div>
      <div className="tfl-fills" role="table" aria-label="Fills">
        <div className="tfl-fr tfl-th" role="row">
          <span role="columnheader">Side</span>
          <span role="columnheader" className="c-num">Price</span>
          <span role="columnheader" className="c-num">Size</span>
          <span role="columnheader" className="c-num c-val">Value</span>
          <span role="columnheader" className="c-cp">Counterparty</span>
          <span role="columnheader" className="c-num">Time (UTC)</span>
        </div>
        {r.error && !d && <EmptyState compact icon="alert" title="Couldn't load the fills" line={r.error} action={<button type="button" className="tfl-cta" onClick={r.retry}>Try again</button>} />}
        {!d && !r.error && Array.from({ length: 6 }, (_, i) => <div key={i} className="tfl-fr tfl-skel" aria-hidden="true"><i /></div>)}
        {d && !shown.length && <EmptyState compact icon="search" title="No fills match" line={d.fills.t.length ? 'Try All for side and role.' : 'This wallet has no fills in this candle on these platforms.'} />}
        {d && shown.length > 0 && <FillList d={d} rows={shown} />}
      </div>
    </div>
  );
}

/** The fills, drawn only where the list is scrolled to (a fixed row height). */
function FillList({ d, rows }: { d: WalletFillsBody; rows: number[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(480);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight || 480));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / FILL_ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((top + h) / FILL_ROW_H) + 10);
  const items: ReactNode[] = [];
  for (let k = first; k < last; k++) {
    const i = rows[k]!;
    const buy = d.fills.side[i] === 1;
    const roleN = d.fills.role[i]!;
    const other = d.others[d.fills.other[i]!]!;
    const style: CSSProperties = { top: k * FILL_ROW_H, height: FILL_ROW_H };
    items.push(
      <div key={i} className="tfl-fr" role="row" style={style}>
        <span role="cell" className="c-side">
          <span className={`tfl-pill ${buy ? 'is-buy' : 'is-sell'}`}>{buy ? 'Buy' : 'Sell'}</span>
          {roleN !== 2 && <span className="tfl-dim tfl-role">{roleN === 0 ? 'Taker' : 'Maker'}</span>}
        </span>
        <span role="cell" className={`c-num ${buy ? 'pos' : 'neg'}`}>{fmtPx(d.fills.px[i])}</span>
        <span role="cell" className="c-num">{fmtSz(d.fills.sz[i]!)}</span>
        <span role="cell" className="c-num c-val tfl-dim">{fmtUsdShort(d.fills.px[i]! * d.fills.sz[i]!)}</span>
        <span role="cell" className="c-cp" title={other.address ?? `account ${other.key}`}>
          <Identicon seed={whoOf(other)} size={14} />
          <span className="tfl-dim">{other.address ? short(other.address) : `#${other.key}`}</span>
        </span>
        <span role="cell" className="c-num tfl-dim">{clock(d.fills.t[i]!)}</span>
      </div>,
    );
  }
  return (
    <div className="tfl-fills__scroll" ref={box} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div className="tfl-fills__sizer" style={{ height: rows.length * FILL_ROW_H }}>{items}</div>
    </div>
  );
}
