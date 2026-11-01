/**
 * WHO TRADED (owner 2026-11-01: "Make it possible to get the following trade info & more for each
 * candle & every timeframe across all supported platforms ... Use our own design & optimize UX").
 *
 * A chart view. One candle of any interval - picked on the chart (right-click "Who traded this
 * candle") or stepped here - broken down by wallet over the chosen platforms:
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
import { FLOW_INTERVALS, candleAt, stepCandle, windowText, type CandleWindow } from './flowWindow';
import '../leaderboard/LeaderboardPage.css';
import './TradeFlow.css';

/** Every platform whose prints name both parties (server indexer/streams.ts). */
export const FLOW_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
const PAGE = 100;
const MAX_ROWS = 500;
const FILL_ROW_H = 30;

const pct = (v: number, dp = 0) => `${fmtNum(v * 100, { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`;
const fmtSz = (v: number) => fmtNum(v, { maximumSignificantDigits: 6 });
const signed = (v: number, f: (x: number) => string) => (v > 0 ? `+${f(v)}` : v < 0 ? `${MINUS}${f(-v)}` : f(0));
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
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
        <span><b className="pos">{buyLabel}</b> {total > 0 ? pct(b) : DASH} <span className="tfl-dim" title={fmtUsdExact(buy)}>{fmtUsdShort(buy)}</span></span>
        <span><span className="tfl-dim" title={fmtUsdExact(sell)}>{fmtUsdShort(sell)}</span> {total > 0 ? pct(1 - b) : DASH} <b className="neg">{sellLabel}</b></span>
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
  /** The chart's interval, and a time inside the candle picked on it (null: the latest candle). */
  interval: string;
  at: number | null;
}

export function TradeFlowView({ symbol, spot, interval: chartInterval, at }: TradeFlowProps) {
  const coin = coinOfSymbol(symbol);
  const startInterval = (FLOW_INTERVALS as readonly string[]).includes(chartInterval) ? chartInterval : '1h';
  const [interval, setIv] = useState(startInterval);
  const [win, setWin] = useState<CandleWindow>(() => candleAt(startInterval, at ?? Date.now()));
  // A candle picked on the chart (or the chart's interval changing) moves the window.
  useEffect(() => {
    const iv = (FLOW_INTERVALS as readonly string[]).includes(chartInterval) ? chartInterval : '1h';
    setIv(iv);
    setWin(candleAt(iv, at ?? Date.now()));
  }, [chartInterval, at]);
  const [venues, setVenues] = useState<Venue[]>(spot ? ['sodex'] : [...FLOW_VENUES]);
  const [role, setRole] = useState<FlowRole>('all');
  const [side, setSide] = useState<FlowSide>('all');
  const [sort, setSort] = useState<FlowSort>('volume');
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<FlowWindowRow | null>(null);
  /** Shown large, over the page (a chart card is often too short for a table). */
  const [big, setBig] = useState(false);
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
  const pickInterval = (iv: string) => {
    setIv(iv);
    // Keep the moment in view: the new candle holds the old one's start (or now, for the latest).
    setWin(candleAt(iv, live ? now : win.from));
  };

  const kind = spot ? 'spot' as const : 'perp' as const;
  const key = `${coin}|${kind}|${venues.join(',')}|${win.from}|${win.to}|${role}|${side}|${sort}|${limit}|${query}`;
  const fetcher = useCallback(
    (s: AbortSignal) => vsApi.flow({ coin, venues, kind, from: win.from, to: win.to, role, side, sort, limit, ...(query.length >= 3 ? { q: query } : {}) }, s),
    [key], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // A candle still forming is read again every 15 s (the recorder's flush); a closed one once.
  const r = usePolled<FlowWindow>(key, fetcher, live ? 15_000 : 0);
  const d = r.data;

  const view = (
    <div className={`tfl${big ? ' tfl--big' : ''}`} role={big ? 'dialog' : undefined} aria-label={big ? `Who traded ${coin}` : undefined}>
      <div className="tfl-bar">
        <div className="tfl-title">
          <CoinIcon coin={coin} size={20} />
          <div>
            <b>Who traded {coin}</b>
            <span className="tfl-dim">{windowText(win)}{live ? ' · live' : ''}</span>
          </div>
        </div>
        <div className="tfl-nav">
          <button type="button" className="tfl-icobtn" aria-label="Previous candle" title="Previous candle" onClick={() => setWin((w) => stepCandle(interval, w, -1))}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <Seg value={interval} label="Candle" options={FLOW_INTERVALS.map((i) => [i, i.endsWith('h') ? i.toUpperCase() : i] as const)} onChange={pickInterval} />
          <button type="button" className="tfl-icobtn" aria-label="Next candle" title="Next candle" disabled={live} onClick={() => setWin((w) => stepCandle(interval, w, 1))}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className={`tfl-latest${win.from === latest.from ? ' is-on' : ''}`} onClick={() => setWin(latest)}>Latest</button>
        </div>
        <PlatformSelect options={spot ? ['sodex'] : FLOW_VENUES} value={venues} onChange={setVenues} align="end" />
        <button type="button" className="tfl-icobtn tfl-expand" onClick={() => setBig((b) => !b)} aria-label={big ? 'Back into the chart' : 'Expand'} title={big ? 'Back into the chart (Esc)' : 'Expand'}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {big ? <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2 2M9.5 9.5 14 14" /> : <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5 7 7M13.5 13.5 9 9" />}
          </svg>
        </button>
      </div>

      {open ? (
        <WalletView coin={coin} kind={kind} venues={venues} win={win} row={open} live={live} onBack={() => setOpen(null)} />
      ) : (
        <div className="tfl-body">
          <Summary d={d && !(d.since !== null && d.to <= d.since) ? d : null} role={role} />
          <Partial d={d} />
          <div className="tfl-filters">
            <Seg value={role} label="Who" options={[['all', 'All'], ['taker', 'Takers'], ['maker', 'Makers']]} onChange={setRole} />
            <Seg value={side} label="Side" options={[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']]} onChange={setSide} />
            <label className="lbp-search tfl-search">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" strokeLinecap="round" /></svg>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a wallet or account id" aria-label="Find a wallet" spellCheck={false} />
            </label>
            <CsvButton disabled={!d?.rows.length} onClick={() => d && saveCsv(`who-traded-${coin}-${new Date(win.from).toISOString().slice(0, 16).replace(':', '')}.csv`, [
              ['venue', 'wallet', 'lean', 'share', 'volume_usd', 'bought_usd', 'sold_usd', 'bought', 'sold', 'net', 'fills_buy', 'fills_sell', 'avg_buy', 'avg_sell', 'taker_share'],
              ...d.rows.map((x) => [x.venue, whoOf(x), x.lean, x.share, x.vol, x.buyNtl, x.sellNtl, x.buySz, x.sellSz, x.net, x.buyN, x.sellN, x.buyPx ?? '', x.sellPx ?? '', x.takerShare ?? '']),
            ])} />
          </div>
          <Table d={d} coin={coin} sort={sort} onSort={setSort} loading={r.loading} stale={r.stale} error={r.error} onOpen={setOpen} />
          {d && d.rows.length >= limit && limit < MAX_ROWS && (
            <button type="button" className="tfl-more" onClick={() => setLimit((l) => Math.min(MAX_ROWS, l + 200))}>Show more wallets</button>
          )}
          <Coverage d={d} />
        </div>
      )}
    </div>
  );
  if (!big) return view;
  return (
    <>
      <div className="tfl tfl-parked"><button type="button" className="tfl-more" onClick={() => setBig(false)}>Show here</button></div>
      {createPortal(<div className="tfl-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setBig(false); }}>{view}</div>, document.body)}
    </>
  );
}

function Summary({ d, role }: { d: FlowWindow | null; role: FlowRole }) {
  const s = d?.summary;
  return (
    <section className="tfl-sum" aria-label="Candle summary">
      <div className="tfl-sum__head">
        <div>
          <span className="tfl-stat__l">Traded</span>
          <span className="tfl-sum__big" title={fmtUsdExact(s?.total)}>{s ? fmtUsdShort(s.total) : DASH}</span>
        </div>
        <div className="tfl-sum__stats">
          <Stat label={role === 'all' ? 'Wallets' : role === 'taker' ? 'Takers' : 'Makers'} value={s ? fmtCount(s.wallets) : DASH} />
          <Stat label="Top 3" value={s && s.wallets ? pct(s.top3) : DASH} title="The three largest wallets' share of the volume shown" />
          <Stat label="Fills" value={s ? fmtCount(s.prints) : DASH} title="Prints (one per match; each has a buyer and a seller)" />
          <Stat label="VWAP" value={s?.vwap ? fmtPx(s.vwap) : DASH} />
        </div>
      </div>
      <SplitBar buy={s?.takerBuy ?? 0} sell={s?.takerSell ?? 0} buyLabel="Taker buys" sellLabel="Taker sells" />
    </section>
  );
}

const COLS: Array<{ key: string; label: string; sort?: FlowSort; cls: string; title?: string }> = [
  { key: 'who', label: 'Wallet', cls: 'c-who' },
  { key: 'share', label: 'Share', cls: 'c-share' },
  { key: 'vol', label: 'Volume', sort: 'volume', cls: 'c-num' },
  { key: 'bias', label: 'Bias', cls: 'c-bias', title: 'Bought against sold (USD)' },
  { key: 'fills', label: 'Fills', sort: 'fills', cls: 'c-num c-fills' },
  { key: 'px', label: 'Avg buy / sell', cls: 'c-num c-px' },
  { key: 'net', label: 'Net', sort: 'net', cls: 'c-num c-net', title: 'Bought minus sold, in the coin' },
  { key: 'tk', label: 'Taker', cls: 'c-num c-tk', title: 'Share of its volume it took liquidity for' },
];

function Table({ d, coin, sort, onSort, loading, stale, error, onOpen }: {
  d: FlowWindow | null; coin: string; sort: FlowSort; onSort: (s: FlowSort) => void; loading: boolean; stale: boolean; error: string | null; onOpen: (r: FlowWindowRow) => void;
}) {
  const before = d && d.since !== null && d.to <= d.since;
  const max = d?.rows[0]?.share ?? 0;
  return (
    <div className={`tfl-table${stale ? ' is-stale' : ''}`} role="table" aria-label="Wallets in this candle">
      <div className="tfl-tr tfl-th" role="row">
        {COLS.map((c) => (
          <span key={c.key} role="columnheader" className={c.cls} title={c.title} aria-sort={c.sort === sort ? 'descending' : undefined}>
            {c.sort ? <button type="button" className={c.sort === sort ? 'is-on' : ''} onClick={() => onSort(c.sort!)}>{c.label}{c.sort === sort ? ' ↓' : ''}</button> : c.label}
          </span>
        ))}
      </div>
      {error && !d && <div className="tfl-empty">{error}</div>}
      {!d && !error && loading && Array.from({ length: 8 }, (_, i) => <div key={i} className="tfl-tr tfl-skel" aria-hidden="true"><i /></div>)}
      {d && before && <div className="tfl-empty">Trades are recorded from {new Date(d.since!).toUTCString().slice(5, 22)} UTC. This candle is earlier.</div>}
      {d && !before && !d.rows.length && <div className="tfl-empty">No trades in this candle{d.markets.length ? '' : ` on these platforms: ${coin} isn't listed there`}.</div>}
      {d?.rows.map((x) => {
        const bias = x.buyNtl + x.sellNtl > 0 ? x.buyNtl / (x.buyNtl + x.sellNtl) : 0.5;
        return (
          <button type="button" key={`${x.venue}|${x.key}`} className="tfl-tr" role="row" onClick={() => onOpen(x)}>
            <span className="c-who" role="cell"><LeanIcon lean={x.lean} /><Wallet w={x} /></span>
            <span className="c-share" role="cell">
              <span className="tfl-share"><i style={{ width: `${max > 0 ? (x.share / max) * 100 : 0}%` }} /></span>
              <span className="tfl-dim">{pct(x.share, x.share < 0.1 ? 1 : 0)}</span>
            </span>
            <span className="c-num" role="cell" title={fmtUsdExact(x.vol)}>{fmtUsdShort(x.vol)}</span>
            <span className="c-bias" role="cell" title={`Bought ${fmtUsdExact(x.buyNtl)} · sold ${fmtUsdExact(x.sellNtl)}`}>
              <span className="tfl-bias"><i className="is-buy" style={{ width: `${bias * 100}%` }} /><i className="is-sell" style={{ width: `${(1 - bias) * 100}%` }} /></span>
              <span className="tfl-bias__n"><span className="pos">{Math.round(bias * 100)}</span>/<span className="neg">{100 - Math.round(bias * 100)}</span></span>
            </span>
            <span className="c-num c-fills" role="cell" title={`${fmtCount(x.buyN)} buys · ${fmtCount(x.sellN)} sells`}>{fmtCount(x.buyN + x.sellN)}</span>
            <span className="c-num c-px" role="cell">
              {x.buyPx !== null ? <span className="pos">{fmtPx(x.buyPx)}</span> : <span className="tfl-dim">{DASH}</span>}
              {x.sellPx !== null ? <span className="neg">{fmtPx(x.sellPx)}</span> : <span className="tfl-dim">{DASH}</span>}
            </span>
            <span className={`c-num c-net ${x.net > 0 ? 'pos' : x.net < 0 ? 'neg' : 'tfl-dim'}`} role="cell" title={`${signed(x.net, fmtSz)} ${coin}`}>{signed(x.net, fmtSz)}</span>
            <span className="c-num c-tk tfl-dim" role="cell">{x.takerShare !== null ? pct(x.takerShare) : DASH}</span>
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
      {late && <span className="tfl-pill is-warn">Partial candle</span>}
      {late && <span>Recording began {hm(d.since)} UTC: trades before that are not in these figures.</span>}
      {gapMs > 0 && (
        <span className="tfl-pill is-warn" title={d.gaps.map(([a, b]) => `${new Date(a).toUTCString()} – ${new Date(b).toUTCString()}`).join('\n')}>
          {fmtNum(gapMs / 60_000, { maximumFractionDigits: 0 })} min not recorded
        </span>
      )}
    </div>
  );
}

function Coverage({ d }: { d: FlowWindow | null }) {
  if (!d) return null;
  return (
    <footer className="tfl-cov">
      <span className="tfl-cov__venues">
        {d.markets.map((m) => (
          <span key={`${m.venue}|${m.symbol}`} className="tfl-cov__m" title={`${VENUE_LABEL[m.venue]} ${m.symbol}: recorded from ${new Date(m.since).toUTCString()}`}>
            <VenueLogo venue={m.venue} size={12} />{m.symbol}
          </span>
        ))}
      </span>
      <span className="tfl-dim">Every print from the venues' public trade streams, both sides. Wallets are shown by address.</span>
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
  const d = r.data;
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
        {r.error && !d && <div className="tfl-empty">{r.error}</div>}
        {!d && !r.error && <div className="tfl-empty">Reading fills…</div>}
        {d && !shown.length && <div className="tfl-empty">No fills match.</div>}
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
