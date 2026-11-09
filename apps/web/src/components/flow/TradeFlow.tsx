/**
 * TRADE FLOW, first called Who traded (owner 2026-11-01: "Make it possible to get the following trade info & more for each
 * candle & every timeframe across all supported platforms ... Use our own design & optimize UX").
 *
 * A panel beside the chart, so the chart stays in view (owner 2026-11-03), built like the chart's other
 * panels: flush, one hairline between its parts (owner 2026-11-05: "doesnt match our other stuff"). One
 * candle of the chart's interval - picked on the chart (Shift-click it, or right-click "Who traded this
 * candle"; it is outlined there) - broken down by wallet over the chosen platforms:
 *   - the summary: traded, the takers' buy/sell split, wallets, the top three's share, fills, VWAP;
 *   - a ranked table: share, volume, buy/sell bias, fills, and under View lean (net bought, net
 *     sold, round trip), average buy and sell price, net size, taker share;
 *   - a wallet's fills in the candle (click a row): side, taker or maker, price, size, value,
 *     counterparty, time to the millisecond - a virtual list, so a hundred thousand rows scroll.
 * Data: the venues' public prints with both parties, kept by the indexer (server flow/). Nothing
 * here is estimated; a window before the recording began says so instead of showing zeros, and one
 * a venue counted more prints in than we hold says how many in one line (server flow/ledger.ts,
 * venueCheck.ts) with its figures marked as floors. A candle not compared yet says nothing.
 * No wallet names: the owner's rule (server valuedesk/labels.ts) - an identicon and the address.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLatched } from '../motion';
import type { FlowWindow, FlowWindowRow, WalletFillsBody } from '@sign/flow/read.js';
import type { VenueCoverage } from '@sign/flow/ledger.js';
import type { FlowRole, FlowSide, FlowSort } from '@sign/flow/codec.js';
import { vsApi, vsPaths, VENUE_LABEL, type Venue } from '../../vsApi';
import { useLiveRead } from '../../live/useLiveRead';
import { usePolled } from '../explore/cohorts/parts';
import { fmtCount, fmtPx, fmtUsdExact, fmtUsdShort } from '../explore/model';
import { fmtNum } from '../../numStyle';
import { DASH, MINUS } from '../../format';
import { VenueLogo } from '../VenueLogo';
import { Identicon } from '../Identicon';
import { PlatformSelect } from '../PlatformSelect';
import { copyText } from '../accountTables/IdCell';
import { HoverCard } from '../accountTables/cells';
import { coinOfSymbol } from '../../chart/liqMap';
import { candleCount, flowSpan, windowText, type CandleWindow } from './flowWindow';
import { EmptyState } from '../EmptyState';
import { ViewPop } from '../ViewPop';
import { Section, Seg as ViewSeg } from '../accountTables/FilterBar';
import { useStored } from '../../hooks';
import '../Account.css';
import '../leaderboard/LeaderboardPage.css';
import './TradeFlow.css';

/** Every platform whose prints name both parties (server indexer/streams.ts). */
export const FLOW_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
const PAGE = 100;
const MAX_ROWS = 500;
const FILL_ROW_H = 30;
/** Below this height the view is a short panel (thin summary). */
const SHORT_PX = 440;
const RECHECK_MS = 60_000;
const READING_MS = 5_000;
const RECHECK_WITHIN_MS = 12 * 3_600_000;
/** A shortfall's card lists this many of its spans. */
const HOLES_SHOWN = 6;

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

/** What each venue's own figures say of a window, SoDEX first. (`checks` is new: an answer from an older server has none.) */
const coveragesOf = (d: Pick<FlowWindow, 'coverage' | 'checks'>): VenueCoverage[] => [...(d.coverage ? [d.coverage] : []), ...(d.checks ?? [])];

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

function Wallet({ w, size = 16 }: { w: { venue: Venue; address: string | null; key: string }; size?: number }) {
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

export function TradeFlowView({ symbol, spot, interval, at, end, onPick, onClose }: TradeFlowProps) {
  const coin = coinOfSymbol(symbol);
  // The chart's candle, picked there; the chart's interval changing re-cuts it.
  const win = useMemo(() => flowSpan(interval, at, end), [interval, at, end]);
  const count = useMemo(() => candleCount(interval, win), [interval, win]);
  const offered: Venue[] = spot ? ['sodex'] : [...FLOW_VENUES];
  const [venues, setVenues] = useState<Venue[]>(offered);
  const [role, setRole] = useState<FlowRole>('all');
  const [side, setSide] = useState<FlowSide>('all');
  const [sort, setSort] = useState<FlowSort>('volume');
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<FlowWindowRow | null>(null);
  // A short panel (the trade page's chart card is ~300 px): the summary goes thin.
  const rootRef = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setShort(el.clientHeight > 0 && el.clientHeight < SHORT_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The wallet slides over the list and away again (owner 2026-11-06: "fully smooth"): the list stays
  // mounted under it, with its scroll, and the wallet is still there while it leaves.
  const wallet = useLatched(open, 220);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setOpen(null); setLimit(PAGE); }, [coin, win.from, win.to, venues.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const live = win.to > now;

  const kind = spot ? 'spot' as const : 'perp' as const;
  const key = `${coin}|${kind}|${venues.join(',')}|${win.from}|${win.to}|${role}|${side}|${sort}|${limit}|${query}`;
  const ask = useMemo(
    () => ({ coin, venues, kind, from: win.from, to: win.to, role, side, sort, limit, ...(query.length >= 3 ? { q: query } : {}) }),
    [key], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fetcher = useCallback((s: AbortSignal) => vsApi.flow(ask, s), [ask]);
  // Pushed from server 1 while the live socket is up (live/useLiveRead.ts, server routes/liveHub.ts): a print shows within
  // about half a second of being readable (2026-11-09: it took 15-30 s polled through Vercel). Without the socket: a candle
  // still forming is read again every 15 s (the recorder's flush); a closed one once. One already closed, once: a venue's
  // count comes within 30 minutes and the catch-up can still fill it for hours, so a recent one that is not final is read
  // again now and then, silently (the socket does the same server-side): only a known shortfall is said.
  const [recheck, setRecheck] = useState(0);
  const r = useLiveRead<FlowWindow>(key, vsPaths.flow(ask), fetcher, live ? 15_000 : recheck);
  // The previous candle's answer while this one loads is not this candle's: skeletons, not "No trades".
  const d = r.stale ? null : r.data;
  useEffect(() => {
    // A venue's figures being read just now come within seconds.
    const reading = !!d && coveragesOf(d).some((c) => c.pending);
    setRecheck(reading ? READING_MS : !!d && !d.final && d.to > Date.now() - RECHECK_WITHIN_MS ? RECHECK_MS : 0);
  }, [d]);
  const [cols, setCols] = useStored<string[]>('flow.cols', DEFAULT_COLS);
  const shownCols = COLS.filter((c) => !c.opt || cols.includes(c.key));
  const before = !!d && d.since !== null && d.to <= d.since;
  return (
    <div ref={rootRef} className={`tfl${short ? ' is-short' : ''}`}>
      <div className="tfl-bar">
        <b className="tfl-title">Trade flow</b>
        <button type="button" className="tfl-ghost" onClick={onClose} aria-label="Close trade flow" title="Close">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      {/* The candles picked on the chart. */}
      <div className="tfl-candle" aria-live="polite">
        <b>{windowText(win)}</b>
        {count > 1 && <span>{fmtCount(count)} candles</span>}
        {live && (
          <span className="tfl-forming" title={r.streaming ? 'Streaming: each print shows as it lands' : 'Refreshed every 15 seconds'}>
            {r.streaming && <i className="tfl-dot" aria-hidden="true" />}Forming
          </span>
        )}
      </div>

      <div className="tfl-views">
      <div className="tfl-scroll" {...(open ? { inert: '' } : {})}>
          <div className="tfl-body">
            <Summary d={d && !before && d.markets.length ? d : null} role={role} loading={r.loading && !d} />
            <Partial d={d} win={win} />
            <div className="tfl-filters">
              <label className="lbp-search tfl-search">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" strokeLinecap="round" /></svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a wallet" title="A wallet address or account id" aria-label="Find a wallet" spellCheck={false} />
              </label>
              <PlatformSelect options={offered} value={venues} onChange={setVenues} align="end" />
              <TableView cols={cols} onCols={setCols} role={role} onRole={setRole} side={side} onSide={setSide} sort={sort} onSort={setSort} />
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
      </div>
      {wallet.value && (
        <div className={`tfl-layer${wallet.closing ? ' is-closing' : ''}`}>
          <WalletView coin={coin} kind={kind} venues={venues} win={win} row={wallet.value} live={live} onBack={() => setOpen(null)} />
        </div>
      )}
      </div>
    </div>
  );
}

function Summary({ d, role, loading }: { d: FlowWindow | null; role: FlowRole; loading: boolean }) {
  const s = d?.summary;
  const v = (x: ReactNode) => (loading ? <i className="tfl-skelv" aria-hidden="true" /> : x);
  // Prints we do not hold: what is counted here is the least it can have been.
  const floor = (d && coveragesOf(d).some((c) => c.holeSlots > (c.overSlots ?? 0))) || !!d?.down.length ? '+' : '';
  // Nothing held at all says nothing, not "at least nothing".
  const blank = !!floor && s?.prints === 0;
  return (
    <section className="tfl-sum" aria-label="Candle summary" aria-busy={loading}>
      <div className="tfl-sum__stats">
        <Stat label="Traded" value={v(s && !blank ? `${fmtUsdShort(s.total)}${floor}` : DASH)} title={s ? `${fmtUsdExact(s.total)}${floor ? ' of what we hold' : ''}` : undefined} />
        <Stat label={role === 'all' ? 'Wallets' : role === 'taker' ? 'Takers' : 'Makers'} value={v(s && !blank ? `${fmtCount(s.wallets)}${floor}` : DASH)} />
        <Stat label="Top 10" value={v(s && s.wallets && s.top10 !== undefined ? pct(s.top10) : DASH)} title="The ten largest wallets' share of the volume shown" />
        <Stat label="Fills" value={v(s && !blank ? `${fmtCount(s.prints)}${floor}` : DASH)} title="Prints (one per match; each has a buyer and a seller)" />
      </div>
      {/* Every print has a buyer and a seller, so the split is by who took: under "All" that is the plain
          buys and sells a chart shows. A maker buys what a taker sells, so makers read the same prints mirrored. */}
      {role === 'maker'
        ? <SplitBar buy={s?.takerSell ?? 0} sell={s?.takerBuy ?? 0} buyLabel="Maker buys" sellLabel="Maker sells" />
        : <SplitBar buy={s?.takerBuy ?? 0} sell={s?.takerSell ?? 0} buyLabel={role === 'taker' ? 'Taker buys' : 'Buys'} sellLabel={role === 'taker' ? 'Taker sells' : 'Sells'} />}
    </section>
  );
}

interface Col { key: string; label: string; sort?: FlowSort; cls: string; title?: string; opt: boolean; w: string; min: number }
/** The table's columns: the wallet always, the rest on or off under View (a row's grid is built from the ones on). */
const COLS: Col[] = [
  { key: 'who', label: 'Wallet', cls: 'c-who', opt: false, w: 'minmax(108px, 1.5fr)', min: 108 },
  { key: 'lean', label: 'Lean', cls: 'c-lean', title: 'Net buyer, net seller or round trip', opt: true, w: '30px', min: 30 },
  { key: 'share', label: 'Share', cls: 'c-num c-share', opt: true, w: '40px', min: 40 },
  { key: 'vol', label: 'Volume', sort: 'volume', cls: 'c-num c-vol', opt: true, w: '62px', min: 62 },
  { key: 'bias', label: 'Bias', cls: 'c-bias', title: 'Bought against sold (USD)', opt: true, w: 'minmax(44px, 0.8fr)', min: 44 },
  { key: 'fills', label: 'Fills', sort: 'fills', cls: 'c-num c-fills', opt: true, w: '40px', min: 40 },
  { key: 'px', label: 'Avg buy / sell', cls: 'c-num c-px', opt: true, w: '92px', min: 92 },
  { key: 'net', label: 'Net', sort: 'net', cls: 'c-num c-net', title: 'Bought minus sold, in the coin', opt: true, w: '80px', min: 80 },
  { key: 'tk', label: 'Taker', cls: 'c-num c-tk', title: 'Share of its volume it took liquidity for', opt: true, w: '46px', min: 46 },
];
const DEFAULT_COLS = ['share', 'vol', 'bias', 'fills'];
const ROW_GAP = 8;
const ROW_PAD = 12;

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
    return <EmptyState compact icon="alert" title="Couldn't load the trade flow" line={error} action={<button type="button" className="tfl-cta" onClick={onRetry}>Try again</button>} />;
  }
  if (!d) return null;
  if (d.since !== null && d.to <= d.since) {
    return <EmptyState compact icon="history" title="Before the recording began" line={`Recording began ${new Date(d.since).toUTCString().slice(5, 22)} UTC. Pick a later candle.`} />;
  }
  // A venue counted trades here and we hold none of them: never "nobody traded", and never "not listed".
  const counted = coveragesOf(d).filter((c) => c.expected > 0);
  if (query.length < 3 && counted.length && counted.every((c) => c.held === 0)) {
    const figures = counted.map((c) => (c.unit === 'volume' ? `${VENUE_LABEL[c.venue]} shows volume` : `${VENUE_LABEL[c.venue]} counted ${fmtNum(c.expected)}`)).join(', ');
    return <EmptyState compact icon="alert" title="We hold no trades for this candle" line={`${figures} here, so this table is not who traded. Pick another candle.`} />;
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
            <span className="c-who" role="cell"><Wallet w={x} /></span>
            {on.has('lean') && <span className="c-lean" role="cell"><LeanIcon lean={x.lean} /></span>}
            {on.has('share') && <span className="c-num c-share tfl-dim" role="cell">{pct(x.share, x.share < 0.1 ? 1 : 0)}</span>}
            {on.has('vol') && <span className="c-num c-vol" role="cell" title={fmtUsdExact(x.vol)}>{fmtUsdShort(x.vol)}</span>}
            {on.has('bias') && <span className="c-bias" role="cell" title={`${Math.round(bias * 100)}% bought, ${100 - Math.round(bias * 100)}% sold: bought ${fmtUsdExact(x.buyNtl)} · sold ${fmtUsdExact(x.sellNtl)}`}>
              <span className="tfl-bias"><i className="is-buy" style={{ width: `${bias * 100}%` }} /><i className="is-sell" style={{ width: `${(1 - bias) * 100}%` }} /></span>
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

/** Where in the window the holes are: a thin bar across its time, as the taker split above it, the missing spans marked. */
function HoleStrip({ gaps, from, to }: { gaps: ReadonlyArray<readonly [number, number]>; from: number; to: number }) {
  const span = to - from;
  if (span <= 0) return null;
  return (
    <span className="tfl-holes" aria-hidden="true">
      {gaps.map(([a, b]) => (
        <i key={a} style={{ left: `${((Math.max(a, from) - from) / span) * 100}%`, width: `max(2px, ${((Math.min(b, to) - Math.max(a, from)) / span) * 100}%)` }} />
      ))}
    </span>
  );
}

/** One venue's figures, in a line: prints against its count, or a share of its volume where it gives no count. */
function heldPill(c: VenueCoverage, named: boolean): string {
  const who = named ? `${VENUE_LABEL[c.venue]}: ` : '';
  if (c.unit === 'volume') return `${who}held ${pct(c.expected > 0 ? c.held / c.expected : 0, 1)} of volume`;
  // Whole sentences: a translation of a lone "Held" would be the paused copy's word (i18n catalogues).
  return named
    ? `${VENUE_LABEL[c.venue]}: held ${fmtNum(c.held)} of ${fmtNum(c.expected)} trades`
    : `Held ${fmtNum(c.held)} of ${fmtNum(c.expected)} trades`;
}

/** One short line of a shortfall: a pill, its details on hover, focus or a tap (HoverCard), and where it is when that is known. */
function NoteLine({ pill, card, strip }: { pill: ReactNode; card: ReactNode; strip?: ReactNode }) {
  return (
    <div className="tfl-note" role="note">
      <HoverCard className="tfl-note__more" card={<div className="tfl-note__card">{card}</div>}>
        <span className="tfl-pill is-warn">
          {pill}
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.9" /><path d="M6 5.5v2.8M6 3.6v.1" /></svg>
        </span>
      </HoverCard>
      {strip}
    </div>
  );
}

/**
 * A candle known not to be whole, above the table: before the recording, the recorder down, each venue's own figures against
 * what is held, one short line each with the details on hover or a tap. Prints we do not hold are a hole wherever they went.
 * A candle only waiting for its check says nothing (owner 2026-11-06): the API's `final` stays false and the panel keeps asking,
 * but nothing is known to be wrong, so nothing is shown.
 */
export function Partial({ d, win, wallet }: { d: Pick<FlowWindow, 'from' | 'to' | 'since' | 'gaps' | 'down' | 'coverage' | 'checks'> | null; win: CandleWindow; wallet?: boolean }) {
  if (!d || d.since === null || d.to <= d.since) return null;
  const late = d.since > d.from;
  const downMs = d.down.reduce((s, [a, b]) => s + (b - a), 0);
  const all = coveragesOf(d);
  const off = all.filter((c) => c.holeSlots > 0);
  if (!late && !downMs && !off.length) return null;
  const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
  // A candle shorter than the slots it is judged by says so.
  const scope = (c: VenueCoverage) => (c.from < win.from || c.to > win.to ? 'the slots around this candle' : 'this candle');
  const whose = wallet ? "This wallet's fills in them are missing too." : 'Volume, wallets, shares and VWAP are from what we hold.';
  const named = all.length > 1;
  return (
    <>
      {off.map((c) => (
        <NoteLine
          key={c.venue}
          pill={heldPill(c, named)}
          card={(
            <>
              <p>
                {c.unit === 'volume'
                  ? `${VENUE_LABEL[c.venue]} gives volume, not a count: in ${scope(c)} we hold ${pct(c.expected > 0 ? c.held / c.expected : 0, 1)} of it.`
                  : `${VENUE_LABEL[c.venue]} counted ${fmtNum(c.expected)} trades in ${scope(c)} and we hold ${fmtNum(c.held)}.`}
                {(c.overSlots ?? 0) > 0 ? ` In ${fmtNum(c.overSlots!)} of its ${c.overSlots === 1 ? 'slot' : 'slots'} we hold more than that: those trades were recorded twice.` : ''} {whose}
              </p>
              {c.unit !== 'volume' && c.holes.length > 0 && (
                <ul className="tfl-note__slots">
                  {c.holes.slice(0, HOLES_SHOWN).map((h) => <li key={h.from}><span>{hm(h.from)} – {hm(h.to)} UTC</span><span>{fmtNum(h.held)} of {fmtNum(h.venue)}</span></li>)}
                  {c.holes.length > HOLES_SHOWN && <li><span>{fmtNum(c.holes.length - HOLES_SHOWN)} more</span></li>}
                </ul>
              )}
            </>
          )}
          strip={scope(c) === 'this candle' ? <HoleStrip gaps={c.holes.map((h) => [h.from, h.to] as const)} from={d.from} to={d.to} /> : undefined}
        />
      ))}
      {(late || downMs > 0) && (
        <NoteLine
          pill={late ? 'Partial candle' : `${downMs < 60_000 ? 'Under 1' : fmtNum(downMs / 60_000, { maximumFractionDigits: 0 })} min not recorded`}
          card={(
            <>
              <p>{late ? `Recording began ${hm(d.since)} UTC: earlier trades in this candle are not counted.` : 'The recorder was down for part of this candle: those trades are not counted.'}</p>
              {downMs > 0 && (
                <ul className="tfl-note__slots">
                  {d.down.slice(0, HOLES_SHOWN).map(([a, b]) => <li key={a}><span>{hm(a)} – {hm(b)} UTC</span></li>)}
                </ul>
              )}
            </>
          )}
        />
      )}
    </>
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
      <span className="tfl-dim tfl-cov__note">
        {coveragesOf(d).filter((c) => c.expected > 0 && !c.holeSlots && !c.unchecked.length).map((c) => (c.unit === 'volume' ? `${VENUE_LABEL[c.venue]}: its volume all held. ` : `${VENUE_LABEL[c.venue]}: all ${fmtNum(c.expected)} of its trades held, by its own count. `)).join('')}
        From the venues' public trade streams, both sides. Wallets are shown by address.
      </span>
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
        <button type="button" className="tfl-ghost" onClick={onBack} aria-label="Back to all wallets" title="Back to all wallets">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <Identicon seed={w} size={24} />
        <div className="tfl-wallet__id">
          <b>{row.address ? short(row.address) : `${VENUE_LABEL[row.venue]} account ${row.key}`}</b>
          <span className="tfl-dim"><VenueLogo venue={row.venue} size={12} /> {VENUE_LABEL[row.venue]} · {fmtCount(d ? d.fills.t.length : row.buyN + row.sellN)} fills · {fmtUsdShort(d ? d.fills.px.reduce((s, p, i) => s + p * d.fills.sz[i]!, 0) : row.buyNtl + row.sellNtl)}</span>
        </div>
        <div className="tfl-wallet__acts">
          {row.address && <button type="button" className="tfl-icobtn" onClick={() => copyText(row.address!, 'Address copied')}>Copy address</button>}
          {row.address && <a className="tfl-icobtn" href={`/scan?address=${encodeURIComponent(row.address)}&venue=${row.venue}`}>Open profile</a>}
        </div>
      </div>
      <Partial d={d} win={win} wallet />
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
