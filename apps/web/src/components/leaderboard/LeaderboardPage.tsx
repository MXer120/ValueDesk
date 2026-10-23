/**
 * The /leaderboard page.
 *
 * Membership is the top 100 by PnL, and a separate inverse hundred of the
 * lowest PnL. Account value, volume, a search and a min/max account value
 * only reorder or filter inside that hundred. They do not ask the venue for
 * a second ranking.
 *
 * The first request is the rank list alone, so the table can paint without
 * waiting on a chart per wallet. A follow-up (`curves=1`) fills the sparkline
 * and any missing account value on the three podium cards.
 *
 * SoDEX only publishes its top 1,000. Its inverse hundred is the bottom of
 * that published list, which the source line says. Hyperliquid's inverse
 * hundred is the bottom of the full file.
 *
 * Win rate, trade count and per-coin "top assets" are not on the public rank
 * list. Those cells stay a dash, or the venue mark, until a row actually
 * carries the figure. Nothing here is invented.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAsync } from '../../hooks';
import { fmtUsd, marketName, shortAddr, signClass } from '../../format';
import { PlatformSelect } from '../PlatformSelect';
import { LoadFailed, useLoadFailedToast } from '../LoadFailed';
import { maskAddress, useMask, usePrivacy } from '../../privacy';
import {
  VENUE_LABEL,
  VsError,
  vsApi,
  type LeaderboardResponse,
  type TraderRow,
  type Venue,
  type BoardWindow,
} from '../../vsApi';
import {
  DEFAULT_VIEW,
  LB_VENUES,
  LB_WINDOWS,
  parseView,
  rankMove,
  rankMoveText,
  writeView,
  type LbMode,
  type LbSide,
  type LbView,
} from './lbState';
import { winRateView } from '../../winRateView';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { ViewPop } from '../ViewPop';
import { Section, Seg } from '../accountTables/FilterBar';
import '../Account.css';
import '../Leaderboard.css';
import './LeaderboardPage.css';
import { formatNumber } from '../../intlCache';

function VenueMark({ venue, size = 16 }: { venue: Venue; size?: number }) {
  return <VenueLogo venue={venue} size={size} />;
}

/** The venues a row's figures come from (one, or several on a netted row). */
function VenueMarks({ row }: { row: Shown }) {
  const list = row.venues?.length ? row.venues : [row.venue];
  return (
    <span className="lbp-venue-marks">
      {list.map((v) => (
        <span key={v} className="lbp-vm" title={VENUE_LABEL[v]}>
          <VenueMark venue={v} />
        </span>
      ))}
    </span>
  );
}

/** Most-traded markets in the window. */
function AssetMarks({ row }: { row: Shown }) {
  return (
    <span className="lbp-assets">
      {(row.assets ?? []).map((sym) => <CoinIcon key={sym} coin={sym} size={16} title={marketName(sym)} />)}
    </span>
  );
}

type Shown = TraderRow & { venues?: Venue[] };

type SortKey = 'pnl' | 'volume' | 'accountValue' | 'winRate' | 'trades';
type AssetBoard = 'all' | 'majors' | 'alts' | 'equities' | 'commodities';

const BOARDS: { id: AssetBoard; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'majors', label: 'Majors' },
  { id: 'alts', label: 'Alts' },
  { id: 'equities', label: 'Equities' },
  { id: 'commodities', label: 'Commodities' },
];

const COMMODITY = /^(GOLD|SILVER|OIL|WTI|BRENT|NATGAS|GAS|COPPER|XAU|XAG|CL|NG|PAXG)$/;
const EQUITY = /^(US500|US100|US30|NAS100|SPX|NDX|DJI|GER40|UK100|JPN225|HK50|AAPL|TSLA|NVDA|MSFT|AMZN|META|GOOGL|COIN)$/;

/** Coin the icon and the asset filter should match. `xyz:AAPL` and `BTC-USD` both reduce. */
function assetBase(symbol: string): string {
  const tail = symbol.split(':').pop() ?? symbol;
  const head = tail.split(/[-/]/)[0] ?? tail;
  return head.replace(/^v/i, '').toUpperCase();
}

function assetClass(symbol: string): Exclude<AssetBoard, 'all'> {
  const base = assetBase(symbol);
  if (COMMODITY.test(base)) return 'commodities';
  if (symbol.includes(':') || EQUITY.test(base)) return 'equities';
  if (base === 'BTC' || base === 'ETH') return 'majors';
  return 'alts';
}

function onBoard(row: TraderRow, board: AssetBoard): boolean {
  if (board === 'all') return true;
  return (row.assets ?? []).some((s) => assetClass(s) === board);
}

const WINDOW_WORD: Record<BoardWindow, string> = {
  '1d': '24h', '7d': '7d', '30d': '30d', '90d': '90d', ytd: 'YTD', all: 'All time',
};
const SORT_WORD: Record<SortKey, string> = {
  pnl: 'PnL', accountValue: 'Account value', volume: 'Volume', winRate: 'Win rate', trades: 'Trades',
};

function sortKeyOf(sort: LbView['sort']): SortKey {
  return sort === 'volume' || sort === 'accountValue' ? sort : 'pnl';
}

function metric(r: TraderRow, sort: SortKey, window: BoardWindow): number {
  const v = sort === 'accountValue' ? r.accountValue
    : sort === 'pnl' ? r.pnl[window]
    : sort === 'winRate' ? r.winRate
    : sort === 'trades' ? r.trades
    : window === '90d' || window === 'ytd' ? null
    : r.volume[window];
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

function fmtTrades(r: TraderRow): string {
  if (r.trades == null) return '—';
  const n = formatNumber(r.trades, 'en-US');
  return r.tradesCapped ? `${n}+` : n;
}

function present(rows: TraderRow[], o: {
  window: BoardWindow;
  sort: SortKey;
  dir: 'asc' | 'desc';
  minAv: string;
  maxAv: string;
  q: string;
  asset: string;
  board: AssetBoard;
}): Shown[] {
  let list: Shown[] = rows.map((r) => ({ ...r, venues: r.venues?.length ? r.venues : [r.venue] }));
  const q = o.q.trim().toLowerCase();
  const asset = o.asset.trim().toLowerCase();
  const lo = o.minAv.trim() ? Number(o.minAv) : null;
  const hi = o.maxAv.trim() ? Number(o.maxAv) : null;
  list = list.filter((r) => {
    // Address only: rows never show or match a name.
    if (q && !r.address.toLowerCase().includes(q)) return false;
    if (asset && !(r.assets ?? []).some((s) => assetBase(s).toLowerCase().includes(asset) || s.toLowerCase().includes(asset))) return false;
    if (!onBoard(r, o.board)) return false;
    if (lo != null && Number.isFinite(lo) && (r.accountValue == null || r.accountValue < lo)) return false;
    if (hi != null && Number.isFinite(hi) && (r.accountValue == null || r.accountValue > hi)) return false;
    return true;
  });
  const sign = o.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => sign * (metric(a, o.sort, o.window) - metric(b, o.sort, o.window)));
  return list;
}

function withCurves(rows: TraderRow[], curves: TraderRow[] | undefined): TraderRow[] {
  if (!curves?.length) return rows;
  const by = new Map(curves.slice(0, 3).map((r) => [`${r.venue}:${r.address}`, r]));
  return rows.map((r) => {
    const c = by.get(`${r.venue}:${r.address}`);
    if (!c) return r;
    return {
      ...r,
      accountValue: r.accountValue ?? c.accountValue,
      spark: (c.spark?.length ?? 0) > 1 ? c.spark : r.spark,
    };
  });
}

function needsCurves(rows: TraderRow[]): boolean {
  return rows.slice(0, 3).some((r) => (r.spark?.length ?? 0) < 2 || r.accountValue == null);
}

function fmtPnl(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const body = fmtUsd(Math.abs(v), 2);
  if (v > 0) return `+${body}`;
  if (v < 0) return `-${body}`;
  return body;
}

/** Win rate: exact plain, an estimate behind a muted "≈" (winRateView.ts says which and why). */
function WinRateTd({ row }: { row: TraderRow }) {
  const w = winRateView(row);
  return (
    <td className={`right ${w.tone}`} title={w.title}>
      {w.approx && <span className="muted">≈</span>}
      {w.text}
    </td>
  );
}

/** Places moved on this board since the snapshot `rankSince` names; nothing when flat or unknown. */
function RankMove({ rc, since }: { rc: number | null | undefined; since: number | null | undefined }) {
  const m = rankMove(rc);
  if (!m) return null;
  const t = rankMoveText(m, since);
  return (
    <span className={`lbp-move ${m.dir === 'up' ? 'pos' : 'neg'}`} title={t.title} aria-label={t.label}>
      {m.dir === 'up' ? '▲' : '▼'}{m.n}
    </span>
  );
}

function Person() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="8" r="3.1" fill="currentColor" />
      <path d="M5.2 19.4c1.3-3.3 3.6-4.8 6.8-4.8s5.5 1.5 6.8 4.8" fill="currentColor" />
    </svg>
  );
}

function Spark({ pts, up }: { pts: number[]; up: boolean }) {
  const gid = useId().replace(/:/g, '');
  const w = 160;
  const h = 74;
  if (pts.length < 2) return <span className="lbp-spark is-empty" />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const xOf = (i: number) => (i / (pts.length - 1)) * w;
  const yOf = (v: number) => 4 + (1 - (v - min) / span) * (h - 12);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ');
  const last = pts.length - 1;
  return (
    <svg className={`lbp-spark ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
      <circle cx={xOf(last)} cy={yOf(pts[last]!)} r="2.4" fill="currentColor" />
    </svg>
  );
}

function Caret({ on }: { on: boolean }) {
  return (
    <svg className={`lbp-caret${on ? ' is-on' : ''}`} width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
      <path d="M4 1 7 4H1L4 1Z" />
      <path d="M4 9 1 6h6L4 9Z" />
    </svg>
  );
}

type Page = LeaderboardResponse & {
  partial?: Venue[];
  /** `rankSince`: when the ranks `rankChange` compares against were taken (null = no snapshot yet). */
  index?: { complete: boolean; pending: number; updatedAt: number; rankSince?: number | null };
};
type Loaded = { ok: true; key: string; res: Page } | { ok: false; key: string; code?: string; message: string };

const SEARCH_DEBOUNCE_MS = 200;

export interface LeaderboardPageProps {
  address: string | null;
  onScan: (address: string, venue?: Venue) => void;
  onOpenCopy: (address: string, venue: Venue) => void;
}

export function LeaderboardPage({ address, onScan }: LeaderboardPageProps) {
  const [view, setView] = useState<LbView>(() => parseView(window.location.search));
  const [statSort, setStatSort] = useState<SortKey | null>(null);
  const [board, setBoard] = useState<AssetBoard>('all');
  const [minTrades, setMinTrades] = useState<0 | 2>(2);
  const [draft, setDraft] = useState(view.q);
  const debounce = useRef<number>();
  const viewBtn = useRef<HTMLButtonElement>(null);
  const [viewOpen, setViewOpen] = useState(false);

  const update = useCallback((patch: Partial<LbView>) => {
    setView((v) => ({ ...v, page: 1, ...patch }));
  }, []);
  /** Toggle a venue; the last selected one stays selected. */
  const setVenues = (next: Venue[]) => setView((cur) => ({ ...cur, venues: next, page: 1 }));
  const multi = view.venues.length > 1;
  const pickSort = (s: SortKey) => {
    if (s === 'winRate' || s === 'trades') setStatSort(s);
    else { setStatSort(null); update({ sort: s }); }
  };

  useEffect(() => {
    const next = writeView(window.location.search, view, DEFAULT_VIEW);
    if (next !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
    }
  }, [view]);

  useEffect(() => {
    setDraft((d) => (d.trim() === view.q ? d : view.q));
  }, [view.q]);
  useEffect(() => () => window.clearTimeout(debounce.current), []);

  const commitSearch = (text: string) => {
    window.clearTimeout(debounce.current);
    const q = text.trim().slice(0, 64);
    setView((v) => (v.q === q ? v : { ...v, q, page: 1 }));
  };
  const onSearchChange = (text: string) => {
    setDraft(text);
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => commitSearch(text), SEARCH_DEBOUNCE_MS);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitSearch(draft);
    if (e.key === 'Escape') { setDraft(''); commitSearch(''); }
  };

  const mode: LbMode = multi ? view.mode : 'single';
  const key = `${view.venues.join(',')}|${view.side}|${mode}|${view.window}|${minTrades}`;
  const query = {
    venues: view.venues.join(','),
    view: multi ? mode : undefined,
    window: view.window,
    sort: 'pnl' as const,
    limit: 100,
    offset: 0,
    side: view.side,
    minTrades: minTrades === 2 ? (2 as const) : undefined,
  };
  const { data, error, loading, refresh } = useAsync<Loaded>(
    () => vsApi.leaderboard(query).then(
      (res): Loaded => ({ ok: true, key, res }),
      (e: unknown): Loaded => {
        if (e instanceof VsError) return { ok: false, key, code: e.code, message: e.message };
        throw e;
      },
    ),
    [key],
    { pollMs: 15_000 },
  );

  const top = data?.ok && data.key === key ? data.res : null;
  const missing = !!top && needsCurves(top.rows);
  const { data: curves } = useAsync<Loaded | null>(
    () => vsApi.leaderboard({ ...query, curves: 1 }).then(
      (res): Loaded => ({ ok: true, key, res }),
      () => null,
    ),
    [key],
    { enabled: missing },
  );

  const failure = data && !data.ok && data.key === key && data.code !== 'not_available' ? data.message : null;
  useLoadFailedToast(failure ?? error, 'Leaderboard', refresh);

  const sort = statSort ?? sortKeyOf(view.sort);
  const curveRows = curves?.ok && curves.key === key ? curves.res.rows : undefined;
  // The inverse board is worst first: ascending by PnL, descending by the rest.
  const dir = view.side === 'worst' && sort === 'pnl' ? 'asc' : 'desc';
  const shaped = top
    ? present(withCurves(top.rows, curveRows), { window: view.window, sort, dir, minAv: '', maxAv: '', q: view.q, asset: '', board })
    : null;

  const me = address ? address.toLowerCase() : null;
  const { isHidden } = usePrivacy();
  const maskPnl = useMask('pnl');
  const maskEquity = useMask('equity');
  const hideAddr = isHidden('address');

  const partial = top?.partial?.length ? top.partial : null;
  const viewCount = (sort !== 'pnl' ? 1 : 0) + (board !== 'all' ? 1 : 0) + (minTrades !== 2 ? 1 : 0);
  const unavailable = data?.ok === false && data.key === key && data.code === 'not_available';

  return (
    <section className="panel lbp" aria-busy={loading}>
      <div className="lbp-bar">
        {/* Everything that changes WHICH hundred is shown stays on the bar;
            everything that only reorders or narrows it is in View. */}
        <div className="lbp-seg lbp-side" role="radiogroup" aria-label="Leaderboard or inverse">
          {(['top', 'worst'] as LbSide[]).map((sd) => (
            <button key={sd} type="button" role="radio" aria-checked={view.side === sd} className={view.side === sd ? 'is-on' : ''} onClick={() => update({ side: sd })}>
              {sd === 'top' ? 'Leaderboard' : 'Inverse'}
            </button>
          ))}
        </div>
        <PlatformSelect options={LB_VENUES} value={view.venues} onChange={setVenues} />
        {multi && (
          <div className="lbp-seg" role="radiogroup" aria-label="Net or single">
            {(['net', 'single'] as LbMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={view.mode === m}
                className={view.mode === m ? 'is-on' : ''}
                onClick={() => update({ mode: m })}
                title={m === 'net' ? 'One row per address: PnL, volume, trades and win rate summed over the selected venues' : 'Each venue\u2019s rows side by side'}
              >
                {m === 'net' ? 'Net' : 'Single'}
              </button>
            ))}
          </div>
        )}
        <div className="lbp-seg" role="radiogroup" aria-label="Window">
          {LB_WINDOWS.map((w) => (
            <button key={w} type="button" role="radio" aria-checked={view.window === w} className={view.window === w ? 'is-on' : ''} onClick={() => update({ window: w })}>
              {WINDOW_WORD[w]}
            </button>
          ))}
        </div>
        <label className="lbp-search">
          <SearchGlyph />
          <input
            type="text"
            value={draft}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search address"
            aria-label="Search this hundred by address"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="search"
          />
        </label>
        <button
          ref={viewBtn}
          type="button"
          className={`acctf-view${viewOpen ? ' is-open' : ''}${viewCount > 0 ? ' is-active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={viewOpen}
          onClick={() => setViewOpen((v) => !v)}
        >
          <SlidersGlyph />
          <span>View</span>
          {viewCount > 0 && <span className="acctf-count">{viewCount}</span>}
        </button>
        <ViewPop
          open={viewOpen}
          anchor={viewBtn}
          onClose={() => setViewOpen(false)}
          onReset={() => { pickSort('pnl'); setBoard('all'); setMinTrades(2); }}
          resetDisabled={viewCount === 0}
        >
          <Section label="Sort">
            <Seg<SortKey> value={sort} onChange={pickSort} options={(Object.keys(SORT_WORD) as SortKey[]).map((k) => [k, k === 'accountValue' ? 'Acc. value' : SORT_WORD[k]])} cols={3} />
          </Section>
          <Section label="Asset group">
            <Seg<AssetBoard> value={board} onChange={setBoard} options={BOARDS.map((x) => [x.id, x.label])} cols={3} />
          </Section>
          <Section label="Trades in this window">
            <Seg<'2' | '0'> value={minTrades === 2 ? '2' : '0'} onChange={(v) => setMinTrades(v === '2' ? 2 : 0)} options={[['2', 'More than 1'], ['0', 'Any']]} />
          </Section>
        </ViewPop>
      </div>

      {top?.source && <p className="lbp-note">{top.source}</p>}
      {top?.index && !top.index.complete && (
        <p className="lbp-note">
          Still indexing: {top.index.pending > 0
            ? `${top.index.pending.toLocaleString('en-US')} traders ranked here are waiting for a trade check, so the order can still change.`
            : 'the ranking source is loading.'}
        </p>
      )}

      {partial && (
        <p className="lbp-note">
          {partial.map((v) => VENUE_LABEL[v]).join(' and ')} could not be loaded. This ranking uses the venue that answered.
        </p>
      )}

      {unavailable ? (
        <p className="lbp-empty">This leaderboard is not available yet.</p>
      ) : failure || error ? (
        <LoadFailed what="Leaderboard" onRetry={refresh} />
      ) : (
        <Board
          rows={shaped}
          window={view.window}
          sort={sort}
          dir={dir}
          onSort={pickSort}
          // The Scan overview (every venue the address trades on), never straight into one venue.
          onOpen={(a) => onScan(a)}
          me={me}
          hideAddr={hideAddr}
          maskPnl={maskPnl}
          maskEquity={maskEquity}
          rankSince={top?.index?.rankSince ?? null}
          empty={minTrades === 2 ? 'No indexed trader has more than one trade in this window yet.' : view.q || board !== 'all' ? 'No trader in this hundred matches.' : 'No traders in this hundred.'}
        />
      )}
    </section>
  );
}


function Board({
  rows, window, sort, dir, onSort, onOpen, me, hideAddr, maskPnl, maskEquity, rankSince, empty,
}: {
  rows: Shown[] | null;
  window: BoardWindow;
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (s: SortKey) => void;
  onOpen: (address: string, venue?: Venue) => void;
  me: string | null;
  hideAddr: boolean;
  maskPnl: (value: string) => ReactNode;
  maskEquity: (value: string) => ReactNode;
  rankSince: number | null;
  empty: string;
}) {
  if (!rows) return <Skeleton />;
  if (!rows.length) return <p className="lbp-empty">{empty}</p>;
  // Movement is on the board's own (PnL) order; under another sort the rank column is that sort's position.
  const moves = sort === 'pnl';
  const head = (col: SortKey, label: string) => {
    const on = sort === col;
    return (
      <th className="right">
        <button type="button" className={`lbp-th${on ? ' is-on' : ''}`} onClick={() => onSort(col)}>
          {label}
          <Caret on={on && dir === 'desc'} />
        </button>
      </th>
    );
  };
  return (
    <>
      <div className="lbp-pod">
        {rows.slice(0, 3).map((r, i) => {
          const place = (i + 1) as 1 | 2 | 3;
          const pnl = r.pnl[window] ?? null;
          const isMe = !!me && r.address.toLowerCase() === me;
          const name = isMe && hideAddr ? maskAddress(r.address, true) : shortAddr(r.address);
          const pnlText = fmtPnl(pnl);
          const avText = fmtUsd(r.accountValue, 0);
          return (
            <button
              key={`${r.venue}-${r.address}-${place}`}
              type="button"
              className={`lbp-card is-${place}`}
              onClick={() => onOpen(r.address, r.venue)}
            >
              <span className="lbp-card__top">
                <span className="lbp-ava" aria-hidden="true"><Person /></span>
                <span className="lbp-card__id">{name}</span>
                <AssetMarks row={r} />
                <VenueMarks row={r} />
                {moves && <RankMove rc={r.rankChange} since={rankSince} />}
                <span className={`lbp-place is-${place}`} aria-label={`Rank ${place}`}>{place}</span>
              </span>
              <span className="lbp-card__body">
                <span className="lbp-card__fig">
                  <span className={`lbp-card__pnl ${signClass(pnl)}`}>{isMe ? maskPnl(pnlText) : pnlText}</span>
                  <span className="lbp-card__k">Net PnL</span>
                  <span className="lbp-card__av">{isMe ? maskEquity(avText) : avText}</span>
                  <span className="lbp-card__k">Acc. Value</span>
                </span>
                <Spark pts={r.spark ?? []} up={(pnl ?? 0) >= 0} />
              </span>
            </button>
          );
        })}
      </div>
      <div className="lbp-sheet">
        <table className="datatable lb-table lbp-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Trader</th>
              {head('accountValue', 'Account value')}
              {head('pnl', 'Net PnL')}
              {head('volume', 'Volume')}
              {head('winRate', 'Win rate')}
              {head('trades', 'Trades')}
              <th>Top assets</th>
              <th className="lbp-th-venues">Venues</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(3).map((r, i) => {
              const isMe = !!me && r.address.toLowerCase() === me;
              const pnl = r.pnl[window] ?? null;
              const name = isMe && hideAddr ? maskAddress(r.address, true) : shortAddr(r.address);
              const pnlText = fmtPnl(pnl);
              const avText = fmtUsd(r.accountValue, 0);
              return (
                <tr key={`${r.venue}-${r.address}`} className={isMe ? 'lb-me' : ''}>
                  <td className="lbp-rank">{i + 4}{moves && <RankMove rc={r.rankChange} since={rankSince} />}</td>
                  <td>
                    <span className="lbp-trader">
                      <span className="lbp-ava" aria-hidden="true"><Person /></span>
                      <button type="button" className="lb-scanlink lbp-name" onClick={() => onOpen(r.address, r.venue)}>{name}</button>
                      {isMe && <span className="lbp-you">You</span>}
                    </span>
                  </td>
                  <td className="right">{isMe ? maskEquity(avText) : avText}</td>
                  <td className={`right ${signClass(pnl)}`}>{isMe ? maskPnl(pnlText) : pnlText}</td>
                  <td className="right">{fmtUsd(r.volume[window] ?? null, 0)}</td>
                  <WinRateTd row={r} />
                  <td className="right">{fmtTrades(r)}</td>
                  <td><AssetMarks row={r} /></td>
                  <td className="lbp-td-venues"><VenueMarks row={r} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Skeleton() {
  return (
    <div className="lbp-skel" aria-hidden="true">
      <div className="lbp-pod">
        {[1, 2, 3].map((n) => (
          <div key={n} className={`lbp-card is-${n}`}>
            <span className="lbp-bone lbp-bone--id" />
            <span className="lbp-bone lbp-bone--pnl" />
            <span className="lbp-bone lbp-bone--line" />
          </div>
        ))}
      </div>
      <div className="lbp-skel__rows">
        {Array.from({ length: 8 }, (_, i) => <span key={i} className="lbp-bone lbp-bone--row" />)}
      </div>
    </div>
  );
}

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.6 10.6 3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
const SlidersGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" /><circle cx="10.5" cy="4.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.5" cy="11.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /></svg>
);
