/**
 * Account panels: balances, positions, open orders, and history.
 *
 * Seeded from REST and refreshed on account WebSocket events, so a fill shows
 * up without waiting for the next poll.
 *
 * Field names differ between the REST and WebSocket surfaces (and are terse on
 * both), so values are read through `pick()` with every plausible spelling
 * rather than guessing one and silently rendering an em-dash.
 *
 * The REST `/positions` payload has been observed directly, so the columns fed
 * by it are pinned to the real key names. A position carries exactly:
 *   id, symbol, marginMode, positionSide, size, initialMargin, avgEntryPrice,
 *   cumOpenCost, cumTradingFee, cumClosedSize, avgClosePrice, maxSize,
 *   realizedPnL, leverage, active, isTakenOver, takeOverPrice, createdAt,
 *   updatedAt
 *
 * WHAT IS NOT IN THAT LIST, AND WHAT WE DO ABOUT IT
 * -------------------------------------------------
 * There is no `markPrice`, no `unrealizedPnl` and no `liquidationPrice`, so:
 *   - `Mark` is the live mark feed (WS `markPrice`, seeded from REST tickers).
 *   - `Unreal. PnL` is DERIVED: (mark - entry) x size, signed by direction.
 *   - `Liq.` is an ESTIMATE from risk.ts against the venue's published margin
 *     tiers. It ignores collateral held elsewhere, which can only push real
 *     liquidation FURTHER away - it errs toward warning early, never late.
 * Every other cell renders exactly what the payload holds, and an absent value
 * is an em-dash. Nothing in this file prints a 0 it was not given.
 *
 * LOOK. The rows are the reference's (image 16): coin logo, the market, a
 * tinted side pill; figures right-aligned in the numeral face; PnL coloured;
 * row actions as the funds sheets' hairline chips. The band's filters (market,
 * margin, side, source) are applied HERE, to the rows this table holds - see
 * accountTables/filters.ts.
 *
 * HISTORY is read in AccountHistory.tsx; `History` below only picks the view.
 */
import { requestDeposit, requestTransfer, requestWithdraw, requestWithdrawFrom } from './account/actions';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Engine, type Symbol } from '../api';
import { bumpAccountResource, useAccountResource } from '../accountFeeds';
import { collateralSplit, crossAccountLeverage, crossMarginRatio } from '../accountData';
import { useAccountTotals } from './account/useAccountTotals';
import { PanelHeading } from '../dashboard/Panel';
import { useAsync, useChannel, useStatus } from '../hooks';
import { notifyTrade } from '../toast';
import { coinLabel, fmt, fmtBalance, fmtDateTime, fmtPrice, fmtQty, fmtUsd, num, pick } from '../format';
import { Private } from '../privacy';
import { estimateLiquidationPrice } from '../risk';
import { signedMarginAmount } from '../trading/orderParams';
import { useConfirm } from './Modal';
import { TpSlSheet, type TpSlConfirm } from './TpSlSheet';
import { planExit, type ExitExisting } from './tpsl';
import './Account.css';
import { CoinIcon, CoinLabel } from './CoinIcon';
import { HistoryTable, ReadFailed } from './AccountHistory';
import {
  DEFAULT_FILTER, TAB_CAPS, applyFilter, directionOfPosition, directionOfSide, marginOf, sourceOf,
  type TableFilter,
} from './accountTables/filters';
import {
  FilteredEmpty, LoadMore, MarketCell, Note, Pill, SidePill, SourcePill, StatusCell, Unit, orderTypeText, signedPct, signedUsd, tifText, toneOf,
} from './accountTables/cells';
import type { BandMeta } from './accountTables/FilterBar';
import { SortTh, sortRows, useTableSort } from './accountTables/sort';

/**
 * The glyph for "we have no value for this". One glyph, used everywhere, and
 * never a 0: a zero in a money column is a statement about the account.
 */
const EM = '—';
const dashed = (s: string): string => (s === '-' ? EM : s);
const usd = (v: unknown): string => dashed(fmtUsd(v as string | number | undefined));
const price = (v: unknown, tick?: string): string => dashed(tick ? fmtPrice(v as string | number | undefined, tick) : fmt(v as string | number | undefined));
const qty = (v: unknown, step?: string): string => dashed(step ? fmtQty(v as string | number | undefined, step) : fmt(v as string | number | undefined));
const when = (v: unknown): string => dashed(fmtDateTime(num(v) || undefined));

interface Ctx {
  engine: Engine;
  address: string | null;
  unlocked: boolean;
  /** Someone else's account (Scan): every table shows, nothing acts - no close, modify, cancel or transfer. */
  readOnly?: boolean;
  byName: Map<string, Symbol>;
  refreshToken: number;
  onChanged: () => void;
  /** The "Current market" checkbox: rows of this one symbol only. Unset shows everything. */
  symbolFilter?: string | null;
  /** The band's View filters for this tab. */
  filter?: TableFilter;
  /** Clears the View filters (the "Reset view" in an emptied table). */
  onResetView?: () => void;
  /** What this table tells the band's filter bar (history tabs only). */
  onMeta?: (m: BandMeta) => void;
}

const symbolOf = (row: any): string => pick<string>(row, 'symbol', 's') ?? '';

/**
 * Open orders drawn per step: a market maker's book (thousands of resting
 * orders) rendered in one go froze the page; the rest are one click away.
 */
const ORDER_PAGE = 200;

/** Re-fetch whenever the account stream reports an order/fill/balance change. */
function useAccountStream(engine: Engine, address: string | null, onChange: () => void) {
  const cb = useCallback(() => onChange(), [onChange]);
  useChannel(engine, address ? { channel: 'accountOrderUpdate', user: address } : null, cb);
  useChannel(engine, address ? { channel: 'accountTrade', user: address } : null, cb);
  useChannel(engine, address ? { channel: 'accountUpdate', user: address } : null, cb);
}

// --- balances ----------------------------------------------------------------

type Book = 'perps' | 'spot' | 'evm';

function BalancesInner({
  engine, address, refreshToken, showTitle = true, section = 'both', book: bookProp, onBook,
}: Ctx & { showTitle?: boolean; section?: 'summary' | 'table' | 'both'; book?: Book; onBook?: (b: Book) => void }) {
  // The page's market picks the book. A manual choice sticks until the market
  // moves to the other engine (a perp chart re-selects Perps, a spot chart Spot).
  const [ownBook, setOwnBook] = useState<Book>(engine === 'spot' ? 'spot' : 'perps');
  const book = bookProp ?? ownBook;
  const setBook = onBook ?? setOwnBook;
  useEffect(() => {
    if (bookProp === undefined) setOwnBook(engine === 'spot' ? 'spot' : 'perps');
  }, [engine, bookProp]);
  const readEngine: Engine = book === 'evm' ? 'spot' : book;
  // Shared with OrderEntry.tsx and Portfolio.tsx - see accountFeeds.ts.
  const stateKey = address && book !== 'evm' ? `state:${readEngine}:${address}` : null;
  const { data, error, loading, refresh } = useAccountResource(stateKey, () => api.state(readEngine, address!), 20_000);
  useEffect(() => { if (stateKey) refresh(); }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
  useAccountStream(readEngine, address, () => bumpAccountResource(stateKey));
  const totals = useAccountTotals(book === 'evm' ? address : null);

  const state = data?.state;
  const balances: any[] = state?.B ?? [];

  const openSymbols = (Array.isArray(state?.P) ? state.P : [])
    .map((p: any) => String(pick(p, 's', 'symbol') ?? ''))
    .filter(Boolean);
  const markOf = useMarkPrices(book === 'perps' ? openSymbols : []);
  const split = book === 'perps' ? collateralSplit(balances) : null;
  const ratio = book === 'perps' ? crossMarginRatio(state) : null;
  const leverage = book === 'perps' ? crossAccountLeverage(state, markOf) : null;

  const spotRows = balances.map((b) => {
    const coin = String(pick(b, 'a', 'coin', 'name') ?? '');
    const total = pick(b, 't', 'total', 'wb');
    return { key: coin || String(pick(b, 'i') ?? ''), coin, amount: dashed(fmtBalance(total as never, coin)) };
  });

  const summary = book === 'evm' && totals.evmLoading && !totals.evm
    ? <Note>Loading…</Note>
    : book !== 'evm' && !state && loading ? <Note>Loading…</Note>
    : book === 'perps' ? (
      <div className="acct-kv">
        <Kv label="Available margin" value={usd(pick(state, 'am'))} />
        <Kv label="Margin balance" value={split?.marginBalance == null ? EM : usd(split.marginBalance)} />
        <Kv sub label="USDC margin" value={split?.usdc == null ? EM : usd(split.usdc)} />
        <Kv sub label="Multi-asset margin" value={split?.multi == null ? EM : usd(split.multi)} />
        <Kv label="Cross margin ratio" value={ratio == null ? EM : `${(ratio * 100).toFixed(2)}%`} />
        <Kv label="Maintenance margin" value={usd(pick(state, 'mm'))} />
        <Kv label="Cross account leverage" value={leverage == null ? EM : `${leverage.toFixed(2)}x`} />
      </div>
    ) : book === 'evm' ? (
      <HoldingList
        rows={evmTop(totals.evm ?? []).map((h) => ({
          key: `${h.chain}:${h.symbol}`,
          coin: h.symbol,
          chain: h.chain,
          title: `${fmtBalance(h.amount, h.symbol)} ${coinLabel(h.symbol) || h.symbol}`,
          sub: h.chainLabel,
          value: fmtUsd(h.usd),
        }))}
        rest={evmRest(totals.evm ?? [])}
        empty={totals.evmLoading ? 'Reading your wallet…' : 'Nothing on ValueChain or the other EVM chains.'}
      />
    ) : spotRows.length === 0 ? <Note>Nothing held.</Note>
    : (
      <HoldingList
        rows={spotRows.map((r) => ({
          key: r.key,
          coin: r.coin,
          title: coinLabel(r.coin) || r.coin || EM,
          sub: '',
          value: r.amount,
        }))}
        empty="Nothing held."
      />
    );

  const table =
    balances.length === 0 ? <Note>{loading ? 'Loading…' : 'No balances.'}</Note> : (
      <table className="acct-table acct-t">
        <thead>
          <tr>
            <th>Asset</th>
            <th className="num">Total</th>
            <th className="num">{readEngine === 'perps' ? 'In use' : 'Locked'}</th>
            <th className="num">{readEngine === 'perps' ? 'Available' : 'Free'}</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b, i) => {
            // Spot rows are { t total, l locked }. Perps rows are { wb wallet
            // balance, aw available for margin } - sodex.com shows wb as the
            // total, aw as available and wb - aw as frozen.
            const perpsRow = readEngine === 'perps' && pick(b, 'wb') !== undefined;
            const total = perpsRow ? pick(b, 'wb') : pick(b, 't', 'total');
            const avail = perpsRow ? pick(b, 'aw') : undefined;
            const locked = perpsRow
              ? (avail === undefined ? undefined : Math.max(0, num(total) - num(avail)))
              : pick(b, 'l', 'locked');
            // Free only when both sides are known.
            const free = perpsRow ? avail : total === undefined || locked === undefined ? undefined : num(total) - num(locked);
            const coin = pick<string>(b, 'a', 'coin', 'name');
            return (
              <tr key={i}>
                <td>{coin ? <span className="acct-mkt"><CoinLabel coin={coin} size={18}><span className="acct-mkt__n">{coinLabel(coin)}</span></CoinLabel></span> : EM}</td>
                <td className="num">{dashed(fmtBalance(total as never, coin))}</td>
                <td className="num">{dashed(fmtBalance(locked as never, coin))}</td>
                <td className="num">{dashed(fmtBalance(free as never, coin))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );

  const funds = (
    <div className="acct-funds">
      <button type="button" className="fx-cta" onClick={requestDeposit}>Deposit</button>
      <div className="acct-funds__row">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={() => (book === 'evm' ? requestWithdraw() : requestWithdrawFrom(book))} disabled={book !== 'evm' && !data?.exists}>Withdraw</button>
        <button type="button" className="fx-cta fx-cta--ghost" onClick={() => requestTransfer(book === 'evm' ? { from: 'evm' } : { from: book })} disabled={book !== 'evm' && !data?.exists}>Transfer</button>
      </div>
    </div>
  );

  return (
    <section className={`panel acct${section === 'summary' ? ' acct--summary' : ''}`}>
      {showTitle && (
        <div className="acct-head">
          <h2>Account</h2>
          <BookSelect book={book} onChange={setBook} />
        </div>
      )}
      {!address ? <Note>Connect a wallet to see your balances.</Note> : (
        <>
          {error && !data && book !== 'evm' && <ReadFailed what={book === 'spot' ? 'Spot balances' : 'Futures balances'} error={error} onRetry={refresh} />}
          {book !== 'evm' && data && !data.exists && (
            <p className="acct-empty">No account for this wallet yet — deposit once to create one.</p>
          )}
          {section === 'both' ? <div className="acct-split">{summary}{book === 'evm' ? null : table}</div>
            : section === 'summary' ? summary
            : book === 'evm' ? summary
            : table}
          {section !== 'table' && funds}
        </>
      )}
    </section>
  );
}

/** The four largest EVM holdings. The rest collapse into one Other row. */
function evmTop<T extends { usd: number; amount: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.usd - a.usd || Number(b.amount) - Number(a.amount)).slice(0, 4);
}
function evmRest(rows: { usd: number; amount: string }[]): { label: string; value: string } | null {
  const rest = [...rows].sort((a, b) => b.usd - a.usd || Number(b.amount) - Number(a.amount)).slice(4);
  if (rest.length === 0) return null;
  const usd = rest.reduce((sum, h) => sum + h.usd, 0);
  return { label: 'Other', value: fmtUsd(usd) };
}

function HoldingList({ rows, empty, rest }: {
  rows: { key: string; coin: string; chain?: string; title: string; sub: string; value: string }[];
  empty: string;
  rest?: { label: string; value: string } | null;
}) {
  if (rows.length === 0 && !rest) return <Note>{empty}</Note>;
  return (
    <ul className="acct-hold">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="acct-hold__ic">
            <CoinIcon coin={r.coin} size={18} />
            {r.chain && <CoinIcon chain={r.chain} size={11} className="acct-hold__chain" />}
          </span>
          <span className="acct-hold__t">{r.title}{r.sub ? <small>{r.sub}</small> : null}</span>
          <span className="acct-hold__v">{r.value}</span>
        </li>
      ))}
      {rest && (
        <li className="is-rest">
          <span className="acct-hold__t">{rest.label}</span>
          <span className="acct-hold__v">{rest.value}</span>
        </li>
      )}
    </ul>
  );
}

function Kv({ label, value, sub = false }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className={`acct-kv-row${sub ? ' is-sub' : ''}`}>
      <span className="acct-kv-label">{label}</span>
      <span className="acct-kv-value">{value}</span>
    </div>
  );
}

const BOOKS: { id: Book; label: string }[] = [
  { id: 'perps', label: 'Futures' },
  { id: 'spot', label: 'Spot' },
  { id: 'evm', label: 'EVM' },
];

function BookSelect({ book, onChange }: { book: Book; onChange: (b: Book) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const label = BOOKS.find((b) => b.id === book)?.label ?? 'Futures';
  return (
    <div className="acct-book" ref={ref}>
      <button
        type="button"
        className={`acct-book__btn${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="menu-popup acct-book__menu" role="menu">
          {BOOKS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitemradio"
              aria-checked={b.id === book}
              className={`menu-row${b.id === book ? '' : ' is-off'}`}
              onClick={() => { onChange(b.id); setOpen(false); }}
            >
              <span className="menu-row__label">{b.label}</span>
              <span className="menu-tick" aria-hidden="true">
                {b.id === book && (
                  <svg width="11" height="9" viewBox="0 0 10 8" aria-hidden="true" focusable="false">
                    <path d="M1 4.3 3.7 7 9 1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The trade page's account card: the heading says Account, and the book beside it follows the market. */
export function AccountPanel(props: Ctx) {
  const [book, setBook] = useState<Book>(props.engine === 'spot' ? 'spot' : 'perps');
  useEffect(() => { setBook(props.engine === 'spot' ? 'spot' : 'perps'); }, [props.engine]);
  return (
    <PanelHeading label="Account" end={<BookSelect book={book} onChange={setBook} />}>
      <Balances {...props} showTitle={false} section="summary" book={book} onBook={setBook} />
    </PanelHeading>
  );
}

// --- positions ---------------------------------------------------------------

/**
 * Whether a position is long or short: the explicit `positionSide` (the venue's
 * `{ BOTH: 1, LONG: 2, SHORT: 3 }`) first, the sign of `size` only under
 * one-way mode. Getting it backwards would make Close DOUBLE the position, so
 * null - never a guess - when neither is conclusive.
 */
function positionDirection(p: any): 'long' | 'short' | null {
  return directionOfPosition(pick(p, 'positionSide', 'ps'), pick(p, 'size', 'positionAmt', 'pa', 'q'));
}

/**
 * Live mark price for a set of symbols: the WS `markPrice` channel, seeded by
 * the REST tickers snapshot. Yields null - never 0 - for a symbol it has no
 * mark for, so the caller renders an em-dash instead of a PnL of nothing.
 */
function useMarkPrices(symbols: string[]): (symbol: string) => number | null {
  const key = [...new Set(symbols.filter(Boolean))].sort().join(',');
  const list = key ? key.split(',') : [];
  const [live, setLive] = useState<Record<string, number>>({});

  const { data } = useAsync(() => api.tickers('perps'), [key], {
    enabled: list.length > 0,
    pollMs: 20_000,
  });

  useChannel('perps', list.length ? { channel: 'markPrice', symbols: list } : null, (d) => {
    const rows: any[] = Array.isArray(d) ? d : [d];
    setLive((prev) => {
      let next = prev;
      for (const r of rows) {
        const s = pick<string>(r, 's', 'symbol');
        const p = num(pick(r, 'p', 'markPrice'));
        if (!s || !(p > 0) || prev[s] === p) continue;
        if (next === prev) next = { ...prev };
        next[s] = p;
      }
      return next;
    });
  });

  const seed = new Map<string, number>();
  for (const t of data?.tickers ?? []) {
    const p = num(t.markPrice);
    if (p > 0) seed.set(t.symbol, p);
  }

  return (symbol: string): number | null => {
    const l = live[symbol];
    if (l !== undefined && l > 0) return l;
    const s = seed.get(symbol);
    return s !== undefined && s > 0 ? s : null;
  };
}

const MARGIN_WORD = { cross: 'Cross', isolated: 'Isolated' } as const;

type PosEdit =
  | { kind: 'margin'; symbol: string; draft: string; dir: 'long' | 'short'; qty: string }
  | {
      kind: 'tpsl';
      symbol: string;
      dir: 'long' | 'short';
      coin: string;
      fullQty: string;
      entry: number;
      mark: number | null;
      tick?: string;
      tp?: ExitExisting;
      sl?: ExitExisting;
    };

function stopKind(o: any): 'tp' | 'sl' | null {
  const s = String(pick(o, 'stopType', 'st') ?? '').toUpperCase();
  if (s === 'TAKE_PROFIT' || s === '2' || s === 'TP') return 'tp';
  if (s === 'STOP_LOSS' || s === '1' || s === 'SL') return 'sl';
  return null;
}

/** The position's reduce-only take-profit and stop-loss, if one is already working. */
function exitsFor(orders: readonly any[], symbol: string, positionId: unknown): { tp?: any; sl?: any } {
  const out: { tp?: any; sl?: any } = {};
  for (const o of orders) {
    if (symbolOf(o) !== symbol) continue;
    const kind = stopKind(o);
    if (!kind || out[kind]) continue;
    const pid = pick(o, 'positionID');
    if (pid != null && positionId != null && String(pid) !== String(positionId)) continue;
    out[kind] = o;
  }
  return out;
}

const orderIdOf = (o: any): number | undefined => {
  const id = num(pick(o, 'orderID', 'i', 'orderId'));
  return id > 0 ? id : undefined;
};
function exitSnap(o: any): ExitExisting | undefined {
  if (!o) return undefined;
  const px = num(pick(o, 'stopPrice'));
  if (!(px > 0)) return undefined;
  const q = pick(o, 'origQty', 'quantity', 'q');
  const t = String(pick(o, 'type', 'o') ?? '').toUpperCase();
  return {
    orderID: orderIdOf(o),
    price: String(pick(o, 'stopPrice')),
    quantity: q == null || num(q) <= 0 ? '' : String(q),
    limit: t === 'LIMIT' || t === '1',
  };
}

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d="M7.1 1.7 10.3 4.9 4.1 11.1H.9V7.9Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);

const CloseX = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d="M2.4 2.4 9.6 9.6M9.6 2.4 2.4 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

function PositionsInner({
  engine, address, unlocked, readOnly = false, byName, refreshToken, onChanged, symbolFilter, filter = DEFAULT_FILTER, onResetView,
  showTitle = true, onCount,
}: Ctx & { showTitle?: boolean; onCount?: (n: number) => void }) {
  // Shared with Chart.tsx and OrderEntry.tsx - see accountFeeds.ts.
  const posKey = address && engine === 'perps' ? `pos:${address}` : null;
  const { data, error, loading, refresh } = useAccountResource(posKey, () => api.positions(address!), 10_000);
  const { msg, show, fromError } = useStatus();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  useEffect(() => { if (posKey) refresh(); }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
  useAccountStream('perps', address, () => bumpAccountResource(posKey));

  const open = (data?.positions ?? []).filter((p) => num(pick(p, 'size', 'positionAmt', 'pa', 'q')) !== 0);
  const positions = applyFilter(
    open,
    (p) => ({ symbol: symbolOf(p), margin: marginOf(pick(p, 'marginMode')), side: positionDirection(p) }),
    filter,
    TAB_CAPS.positions,
    { market: symbolFilter ?? null, now: Date.now() },
  );
  useEffect(() => onCount?.(positions.length), [positions.length, onCount]);

  const markOf = useMarkPrices(open.map(symbolOf));
  const ordersKey = address && engine === 'perps' ? `orders:perps:${address}` : null;
  const ordersFeed = useAccountResource(ordersKey, () => api.openOrders('perps', address!), 10_000);
  const { sort, toggle } = useTableSort();
  const [posEdit, setPosEdit] = useState<PosEdit | null>(null);

  async function close(p: any) {
    const symbol = symbolOf(p);
    const amt = num(pick(p, 'size', 'positionAmt', 'pa', 'q'));
    if (!symbol || !amt) return;

    // Direction decides the side of a REAL market order - backwards doubles
    // the position - so it comes from `positionSide` first (positionDirection).
    const dir = positionDirection(p);
    if (!dir) {
      return show('err', 'Cannot determine whether this position is long or short - refusing to send a close order.');
    }

    // The review states the side that will actually be submitted, not only the
    // direction being closed - those are opposites.
    const sym = byName.get(symbol);
    const ok = await confirm({
      title: 'Close position at market',
      danger: true,
      confirmLabel: 'Close at market',
      cancelLabel: 'Keep position',
      body: (
        <table className="kv">
          <tbody>
            <tr><th>Market</th><td>{sym?.displayName ?? symbol}</td></tr>
            <tr><th>Position</th><td className={dir === 'long' ? 'pos' : 'neg'}>{dir}</td></tr>
            <tr><th>Size</th><td>{qty(Math.abs(amt), sym?.stepSize)} {sym?.baseCoin ?? ''}</td></tr>
            <tr><th>Entry</th><td>{price(pick(p, 'avgEntryPrice'), sym?.tickSize)}</td></tr>
            <tr><th>Order sent</th><td>{dir === 'long' ? 'SELL' : 'BUY'} market, reduce-only</td></tr>
          </tbody>
        </table>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.placeOrder('perps', {
        symbol,
        side: dir === 'long' ? 'sell' : 'buy',
        type: 'market',
        quantity: String(Math.abs(amt)),
        reduceOnly: true,
      });
      show('ok', `Closing ${symbol}`);
      onChanged();
      refresh();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveExits(req: TpSlConfirm) {
    if (!posEdit || posEdit.kind !== 'tpsl') return;
    const edit = posEdit;
    setBusy(true);
    try {
      for (const [kind, draft, existing] of [
        ['tp', req.tp, edit.tp],
        ['sl', req.sl, edit.sl],
      ] as const) {
        const plan = planExit(existing, draft);
        if (plan.action === 'keep') continue;
        const place = (order: { price: string; quantity: string; limit: boolean }) => api.placeOrder('perps', {
          symbol: edit.symbol,
          side: edit.dir === 'long' ? 'sell' : 'buy',
          type: order.limit ? 'limit' : 'market',
          ...(order.limit ? { price: order.price, tif: 'gtc' as const } : {}),
          quantity: order.quantity,
          reduceOnly: true,
          stopPrice: order.price,
          stopType: kind,
          triggerType: 'mark',
        });
        if (plan.action === 'cancel') {
          if (!existing?.orderID) throw new Error('That exit has no order id, so it cannot be cancelled from here.');
          await api.cancelOrder('perps', { symbol: edit.symbol, orderID: existing.orderID });
          continue;
        }
        if (plan.action === 'modify') {
          if (!existing?.orderID) throw new Error('That exit has no order id, so it cannot be changed from here.');
          await api.changeOrder('perps', { symbol: edit.symbol, orderID: existing.orderID }, {
            ...(plan.price ? { stopPrice: plan.price } : {}),
            ...(plan.quantity ? { quantity: plan.quantity } : {}),
            ...(plan.limitPrice ? { price: plan.limitPrice } : {}),
          });
          continue;
        }
        if (plan.action === 'replace') {
          if (!existing?.orderID) throw new Error('That exit has no order id, so it cannot be changed from here.');
          await api.cancelOrder('perps', { symbol: edit.symbol, orderID: existing.orderID });
          try {
            await place(plan);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new Error(`The previous exit was cancelled, and the new one was not accepted (${why}). Place it again.`);
          }
          continue;
        }
        await place(plan);
      }
      show('ok', 'TP/SL updated.');
      setPosEdit(null);
      onChanged();
      refresh();
      if (ordersKey) bumpAccountResource(ordersKey);
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveMargin(add: boolean) {
    if (!posEdit || posEdit.kind !== 'margin') return;
    let signed: string;
    try {
      signed = signedMarginAmount(posEdit.draft, add);
    } catch (e) {
      return show('err', e instanceof Error ? e.message : 'Enter an amount.');
    }
    const ok = await confirm({
      title: add ? 'Add isolated margin' : 'Remove isolated margin',
      confirmLabel: add ? 'Add margin' : 'Remove margin',
      cancelLabel: 'Back',
      body: (
        <p>
          {add ? 'Add' : 'Remove'} <strong>{signed.replace(/^-/, '')}</strong> of isolated margin on <strong>{posEdit.symbol}</strong>.
          SoDEX applies this only to an isolated position. A remove that would leave the position under-margined is rejected.
        </p>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.adjustMargin(posEdit.symbol, signed);
      show('ok', add ? 'Margin added.' : 'Margin removed.');
      setPosEdit(null);
      onChanged();
      refresh();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  if (engine !== 'perps') return null;

  const openOrders: any[] = ordersFeed.data?.orders ?? [];
  const shown = sortRows(positions, sort, (p, key) => {
    const symbol = symbolOf(p);
    const size = Math.abs(num(pick(p, 'size', 'positionAmt', 'pa', 'q')));
    const dir = positionDirection(p);
    const entry = num(pick(p, 'avgEntryPrice'));
    const mark = markOf(symbol);
    const im = num(pick(p, 'initialMargin'));
    const upnl = dir && mark !== null && entry > 0 && size > 0
      ? (dir === 'long' ? mark - entry : entry - mark) * size
      : null;
    if (key === 'market') return symbol;
    if (key === 'size') return dir === 'short' ? -size : size;
    if (key === 'value') return mark === null ? null : mark * size;
    if (key === 'entry') return entry > 0 ? entry : null;
    if (key === 'mark') return mark;
    if (key === 'liq') {
      const sym = byName.get(symbol);
      const lev = num(pick(p, 'leverage'));
      if (!dir || !(entry > 0) || !(size > 0)) return null;
      return estimateLiquidationPrice({
        entryPrice: entry, quantity: size, side: dir === 'long' ? 'buy' : 'sell', leverage: lev, sym,
      }).price;
    }
    if (key === 'upnl') return upnl;
    if (key === 'margin') return im > 0 ? im : null;
    return null;
  });

  return (
    <section className="panel acct">
      {showTitle && <div className="acct-head"><h2>Positions</h2></div>}
      {!address ? <Note>Connect a wallet to see open positions.</Note> : (
        <>
        {error && <ReadFailed what="Positions" error={error} onRetry={refresh} />}
        {positions.length === 0 ? (!error && (open.length > 0
          ? <FilteredEmpty onReset={onResetView} />
          : <Note>{loading ? 'Loading…' : 'No open positions.'}</Note>)) : (
        <table className="acct-table acct-t acct-pos">
          <thead>
            <tr>
              <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
              <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="entry" label="Entry" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="mark" label="Mark" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="liq" label={<>Liq. <span className="acct-tag">est.</span></>} numeric sort={sort} onSort={toggle} className="num" title="Estimated from entry, size and leverage against the venue's published margin tiers. It ignores collateral held elsewhere in the account, which can only move real liquidation further away." />
              <SortTh k="upnl" label="PnL" numeric sort={sort} onSort={toggle} className="num" title="Derived here: (mark − entry) × size, signed by direction; the % is against the position's margin. The venue does not publish an unrealised PnL for a position." />
              <SortTh k="margin" label="Margin" numeric sort={sort} onSort={toggle} className="num" />
              <th>TP/SL</th>
              {!readOnly && <th className="acct-actions" aria-label="Close" />}
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => {
              const symbol = symbolOf(p) || EM;
              const sym = byName.get(symbol);
              const amt = num(pick(p, 'size', 'positionAmt', 'pa', 'q'));
              const size = Math.abs(amt);
              const dir = positionDirection(p);
              const entry = num(pick(p, 'avgEntryPrice'));
              const mark = markOf(symbol);
              const margin = marginOf(pick(p, 'marginMode'));
              const lev = num(pick(p, 'leverage'));
              const im = num(pick(p, 'initialMargin'));
              const unit = coinLabel(sym?.baseCoin) || undefined;

              const upnl =
                dir && mark !== null && entry > 0 && size > 0
                  ? (dir === 'long' ? mark - entry : entry - mark) * size
                  : null;
              const roe = upnl !== null && im > 0 ? upnl / im : null;

              const exits = exitsFor(openOrders, symbol, pick(p, 'id'));
              const liq =
                dir && entry > 0 && size > 0
                  ? estimateLiquidationPrice({
                      entryPrice: entry,
                      quantity: size,
                      side: dir === 'long' ? 'buy' : 'sell',
                      leverage: lev,
                      sym,
                    }).price
                  : null;

              return (
                <tr key={String(pick(p, 'id') ?? i)}>
                  <td>
                    <MarketCell symbol={symbol} sym={sym} engine="perps" icon={22}>
                      {lev > 0 && (
                        <span
                          className={`acct-levbox${dir ? ` acct-levbox--${dir}` : ''}`}
                          title={dir === 'long' ? 'Long' : dir === 'short' ? 'Short' : undefined}
                        >
                          {lev}x
                        </span>
                      )}
                      {margin && <span className="acct-mode">{MARGIN_WORD[margin]}</span>}
                    </MarketCell>
                  </td>
                  <td className="num"><Unit value={qty(size, sym?.stepSize)} unit={unit} /></td>
                  <td className="num">{mark === null ? EM : fmtUsd(mark * size)}</td>
                  <td className="num">{price(pick(p, 'avgEntryPrice'), sym?.tickSize)}</td>
                  <td className="num">{mark === null ? EM : fmtPrice(mark, sym?.tickSize)}</td>
                  <td className="num acct-dim">{liq === null ? EM : fmtPrice(liq, sym?.tickSize)}</td>
                  <td className={`num ${toneOf(upnl)}`}>
                    {upnl === null ? EM : <>{signedUsd(upnl)}{roe !== null && <span className="acct-sub"> {signedPct(roe)}</span>}</>}
                  </td>
                  <td className="num">
                    {usd(pick(p, 'initialMargin'))}
                    {margin === 'isolated' && dir && !readOnly && (
                      <button
                        type="button"
                        className="acct-edit"
                        aria-label={`Edit isolated margin on ${symbol}`}
                        disabled={busy || !unlocked}
                        onClick={() => setPosEdit({ symbol, kind: 'margin', draft: '', dir, qty: String(size) })}
                      >
                        <PencilIcon />
                      </button>
                    )}
                  </td>
                  <td className="acct-exits">
                    <span className="acct-tpsl">
                      <span>{exits.tp ? price(pick(exits.tp, 'stopPrice'), sym?.tickSize) : EM}</span>
                      <span className="acct-tpsl__s">/</span>
                      <span>{exits.sl ? price(pick(exits.sl, 'stopPrice'), sym?.tickSize) : EM}</span>
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="acct-edit"
                        aria-label={`Edit TP/SL on ${symbol}`}
                        disabled={busy || !unlocked || !dir}
                        onClick={() => {
                          if (!dir) return;
                          const raw = String(pick(p, 'size', 'positionAmt', 'pa', 'q') ?? '');
                          setPosEdit({
                            kind: 'tpsl',
                            symbol,
                            dir,
                            coin: coinLabel(sym?.baseCoin) || sym?.baseCoin || '',
                            fullQty: raw.startsWith('-') ? raw.slice(1) : raw,
                            entry,
                            mark,
                            tick: sym?.tickSize,
                            tp: exitSnap(exits.tp),
                            sl: exitSnap(exits.sl),
                          });
                        }}
                      >
                        <PencilIcon />
                      </button>
                    )}
                  </td>
                  {!readOnly && <td className="acct-actions">
                    <button
                      type="button"
                      className="acct-x"
                      onClick={() => close(p)}
                      disabled={busy || !unlocked || !dir}
                      aria-label={dir ? `Close ${symbol} at market` : `Cannot close ${symbol}`}
                      title={dir ? 'Close at market (reduce-only)' : 'Direction unknown - close manually from the order ticket.'}
                    >
                      <CloseX />
                    </button>
                  </td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        </>
      )}
      {posEdit?.kind === 'margin' && (
        <div className="acct-modify">
          <span className="acct-modify__t">Isolated margin · {posEdit.symbol}</span>
          <label>
            <span>Amount</span>
            <input
              value={posEdit.draft}
              onChange={(e) => setPosEdit({ ...posEdit, draft: e.target.value })}
              inputMode="decimal"
              autoFocus
            />
          </label>
          <button type="button" className="acct-act acct-act--solid" onClick={() => saveMargin(true)} disabled={busy}>Add</button>
          <button type="button" className="acct-act" onClick={() => saveMargin(false)} disabled={busy}>Remove</button>
          <button type="button" className="acct-act" onClick={() => setPosEdit(null)} disabled={busy}>Cancel</button>
        </div>
      )}
      {posEdit?.kind === 'tpsl' && (
        <TpSlSheet
          key={`${posEdit.symbol}:${posEdit.fullQty}`}
          symbol={posEdit.symbol}
          coin={posEdit.coin}
          side={posEdit.dir}
          entry={posEdit.entry}
          mark={posEdit.mark}
          fullQty={posEdit.fullQty}
          tick={posEdit.tick}
          tp={posEdit.tp}
          sl={posEdit.sl}
          busy={busy}
          onClose={() => { if (!busy) setPosEdit(null); }}
          onConfirm={(req) => void saveExits(req)}
        />
      )}
      {msg && <p className={`status ${msg.kind}`}>{msg.text}</p>}
      {dialog}
    </section>
  );
}

// --- open orders -------------------------------------------------------------

function OpenOrdersInner({
  engine, address, unlocked, byName, refreshToken, onChanged, symbolFilter, filter = DEFAULT_FILTER, onResetView,
  showTitle = true, onCount, headAction, readOnly = false,
}: Ctx & { showTitle?: boolean; onCount?: (n: number) => void; headAction?: ReactNode }) {
  const [orderCap, setOrderCap] = useState(ORDER_PAGE);
  // Shared with Chart.tsx - see accountFeeds.ts. The FULL list; the band's
  // filters narrow it here.
  const ordersKey = address ? `orders:${engine}:${address}` : null;
  const { data, error, loading, refresh } = useAccountResource(ordersKey, () => api.openOrders(engine, address!), 10_000);
  const { msg, show, fromError } = useStatus();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const { confirm, dialog } = useConfirm();
  useEffect(() => { if (ordersKey) refresh(); }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
  useAccountStream(engine, address, () => bumpAccountResource(ordersKey));

  const all: any[] = data?.orders ?? [];
  const orders = applyFilter(
    all,
    (o) => ({ symbol: symbolOf(o), side: directionOfSide(pick(o, 'side', 'S')), source: sourceOf(pick(o, 'clOrdID', 'c')) }),
    filter,
    TAB_CAPS.orders,
    { market: symbolFilter ?? null, now: Date.now() },
  );
  useEffect(() => onCount?.(orders.length), [orders.length, onCount]);
  const { sort, toggle } = useTableSort();
  const shownOrders = sortRows(orders, sort, (o, key) => {
    const sym = byName.get(symbolOf(o));
    const px = num(pick(o, 'price', 'p'));
    const q = num(pick(o, 'quantity', 'q', 'origQty'));
    if (key === 'market') return symbolOf(o);
    if (key === 'status') return String(pick(o, 'status', 'X') ?? '');
    if (key === 'type') return orderTypeText(o);
    if (key === 'price') return px > 0 ? px : null;
    if (key === 'trigger') { const s = num(pick(o, 'stopPrice')); return s > 0 ? s : null; }
    if (key === 'size') return q;
    if (key === 'filled') return num(pick(o, 'filledQuantity', 'z', 'executedQty'));
    if (key === 'value') return px > 0 ? px * q : null;
    if (key === 'placed') return num(pick(o, 'createdAt', 'T', 'time')) || null;
    return sym ? null : null;
  });

  async function cancel(o: any) {
    setBusy(true);
    try {
      await api.cancelOrder(engine, {
        symbol: symbolOf(o),
        orderID: num(pick(o, 'orderID', 'i', 'orderId')) || undefined,
      });
      const sym = byName.get(symbolOf(o));
      const buy = directionOfSide(pick(o, 'side', 'S')) === 'long';
      notifyTrade('cancelled', {
        coin: sym?.baseCoin ?? undefined,
        title: `${sym?.displayName ?? symbolOf(o)} ${engine === 'perps' ? (buy ? 'long' : 'short') : (buy ? 'buy' : 'sell')} cancelled`,
        detail: `${fmtQty(pick(o, 'quantity', 'q', 'origQty'), sym?.stepSize)} ${coinLabel(sym?.baseCoin) || ''} @ ${fmtPrice(pick(o, 'price', 'p'), sym?.tickSize)}`.replace(/\s+@/, ' @'),
      });
      onChanged();
      refresh();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancelAll() {
    // The dialog counts the rows ON SCREEN, but the request cancels everything
    // open on the engine - so when a filter hides rows, the difference is said.
    const hidden = all.length - orders.length;
    const ok = await confirm({
      title: `Cancel all ${engine} orders`,
      danger: true,
      confirmLabel: 'Cancel every open order',
      cancelLabel: 'Keep them',
      body: (
        <p>
          Cancels every order the gateway currently lists as open on <strong>{engine}</strong>
          {hidden > 0
            ? ` — including ${hidden} this table is currently hiding (${orders.length} shown).`
            : ` — ${orders.length} in this table right now.`}{' '}
          Open positions are not closed by this; only resting orders are removed.
        </p>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.cancelAll(engine);
      notifyTrade('cancelled', { title: 'Orders cancelled', detail: `${r.cancelled} open order${r.cancelled === 1 ? '' : 's'} on ${engine === 'perps' ? 'Futures' : 'Spot'}` });
      onChanged();
      refresh();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  const spot = engine === 'spot';
  const anyStop = orders.some((o) => num(pick(o, 'stopPrice')) > 0);
  const head = showTitle || !!headAction;

  return (
    <section className="panel acct">
      {head && (
        <div className="acct-head">
          {showTitle && <h2>Open orders ({orders.length})</h2>}
          {headAction}
        </div>
      )}
      {!address ? <Note>Connect a wallet to see open orders.</Note> : (
        <>
        {error && <ReadFailed what="Open orders" error={error} onRetry={refresh} />}
        {orders.length === 0 ? (!error && (all.length > 0
          ? <FilteredEmpty onReset={onResetView} />
          : <Note>{loading ? 'Loading…' : 'No open orders.'}</Note>)) : (
        <table className="acct-table acct-t">
          <thead>
            <tr>
              <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
              <SortTh k="status" label="Status" sort={sort} onSort={toggle} />
              <SortTh k="type" label="Type" sort={sort} onSort={toggle} />
              <SortTh k="price" label="Price" numeric sort={sort} onSort={toggle} className="num" />
              {anyStop && <SortTh k="trigger" label="Trigger" numeric sort={sort} onSort={toggle} className="num" title="The mark price that turns this stop into an order." />}
              <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="filled" label="Filled" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
              <SortTh k="placed" label="Placed" numeric sort={sort} onSort={toggle} className="num" />
              {!readOnly && (
                <th className="acct-actions">
                  <button type="button" className="acct-act acct-act--danger" onClick={cancelAll} disabled={busy || !unlocked || orders.length === 0}>
                    Cancel all
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shownOrders.slice(0, orderCap).map((o, i) => {
              const symbol = symbolOf(o) || EM;
              const sym = byName.get(symbol);
              const dir = directionOfSide(pick(o, 'side', 'S'));
              const px = num(pick(o, 'price', 'p'));
              const q = pick(o, 'quantity', 'q', 'origQty');
              const filled = pick(o, 'filledQuantity', 'z', 'executedQty') ?? '0';
              const stopPx = num(pick(o, 'stopPrice'));
              const tif = tifText(pick(o, 'timeInForce', 'f'));
              const unit = coinLabel(sym?.baseCoin) || undefined;
              const value = px > 0 && q !== undefined ? px * num(q) : null;
              return (
                <tr key={String(pick(o, 'orderID', 'i') ?? i)}>
                  <td>
                    <MarketCell symbol={symbol} sym={sym} engine={engine}>
                      <SidePill dir={dir} spot={spot} />
                      <SourcePill source={sourceOf(pick(o, 'clOrdID', 'c'))} />
                    </MarketCell>
                  </td>
                  <td>
                    <StatusCell
                      o={{ status: pick(o, 'status', 'X'), executedQty: filled, origQty: q, stopPrice: pick(o, 'stopPrice'), stopType: pick(o, 'stopType') }}
                      qtyText={(v) => qty(v, sym?.stepSize)}
                      unit={unit}
                      priceText={px > 0 ? fmtPrice(pick(o, 'avgPrice', 'ap') ?? px, sym?.tickSize) : null}
                    />
                  </td>
                  <td className="acct-word">
                    {orderTypeText(o)}
                    {tif && <span className="acct-sub"> · {tif}</span>}
                    {pick(o, 'reduceOnly') === true && <Pill tone="muted">Reduce</Pill>}
                  </td>
                  <td className="num">{px > 0 ? price(px, sym?.tickSize) : <span className="acct-dim">Market</span>}</td>
                  {anyStop && <td className="num">{stopPx > 0 ? price(stopPx, sym?.tickSize) : EM}</td>}
                  <td className="num"><Unit value={qty(q, sym?.stepSize)} unit={unit} /></td>
                  <td className="num">{qty(filled, sym?.stepSize)}</td>
                  <td className="num">{value === null ? EM : fmtUsd(value)}</td>
                  <td className="num acct-time">{when(pick(o, 'createdAt', 'T', 'time'))}</td>
                  {!readOnly && <td className="acct-actions">
                    {/* Spot and perps alike: changeOrder picks SoDEX's request for the order (trading/actions.ts). */}
                    <button type="button" className="acct-act" onClick={() => setEditing(o)} disabled={busy || !unlocked}>
                      Modify
                    </button>
                    <button type="button" className="acct-act" onClick={() => cancel(o)} disabled={busy || !unlocked}>
                      Cancel
                    </button>
                  </td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {shownOrders.length > orderCap && (
          <LoadMore
            onMore={() => setOrderCap((n) => n + ORDER_PAGE)}
            loading={false}
            note={`${(shownOrders.length - orderCap).toLocaleString('en-US')} more below`}
          />
        )}
        </>
      )}
      {editing && (
        <ModifyOrder
          engine={engine}
          order={editing}
          byName={byName}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onChanged(); refresh(); }}
        />
      )}
      {msg && <p className={`status ${msg.kind}`}>{msg.text}</p>}
      {dialog}
    </section>
  );
}

function ModifyOrder({
  engine, order, byName, onClose, onDone,
}: { engine: Engine; order: any; byName: Map<string, Symbol>; onClose: () => void; onDone: () => void }) {
  const symbol = symbolOf(order);
  const sym = byName.get(symbol);
  const [priceInput, setPriceInput] = useState(String(pick(order, 'price', 'p') ?? ''));
  const [quantity, setQuantity] = useState(String(pick(order, 'quantity', 'q', 'origQty') ?? ''));
  const [busy, setBusy] = useState(false);
  const { msg, show, fromError } = useStatus();

  async function submit() {
    setBusy(true);
    try {
      // Modify for a take-profit / stop-loss, replace for a plain limit order - or, where that could
      // drop the builder fee, cancel + new order (trading/actions.ts changeOrder).
      const r = await api.changeOrder(
        engine,
        { symbol, orderID: num(pick(order, 'orderID', 'i', 'orderId')) || undefined, clOrdID: pick(order, 'clOrdID', 'c') || undefined },
        { price: priceInput, quantity },
      );
      show('ok', r.route === 'recreate' ? 'Changed: the order was cancelled and placed again with the new values.' : 'Modified.');
      onDone();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acct-modify">
      <span className="acct-modify__t">Modify {sym?.displayName ?? symbol}</span>
      <label><span>Price</span><input value={priceInput} onChange={(e) => setPriceInput(e.target.value)} inputMode="decimal" /></label>
      <label><span>Size</span><input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" /></label>
      <button type="button" className="acct-act acct-act--solid" onClick={submit} disabled={busy}>Save</button>
      <button type="button" className="acct-act" onClick={onClose}>Cancel</button>
      {msg && <p className={`status ${msg.kind}`}>{msg.text}</p>}
    </div>
  );
}

// --- history -----------------------------------------------------------------

/**
 * Order, trade, funding and closed-position history - AccountHistory.tsx's
 * paged tables. This wrapper keeps the two shapes callers use: a single fixed
 * view (`forceTab`, one per tab of the account band) or its own switch.
 */
type HistoryTab = 'trades' | 'orders' | 'funding' | 'positions';
const PERPS_ONLY: ReadonlySet<HistoryTab> = new Set(['funding', 'positions']);

function HistoryInner({
  engine, address, byName, refreshToken, symbolFilter, filter, onResetView, onMeta, showTitle = true, forceTab, headAction, cardView,
}: Ctx & { showTitle?: boolean; forceTab?: HistoryTab; headAction?: ReactNode; cardView?: boolean }) {
  const [tab, setTab] = useState<HistoryTab>(forceTab ?? 'trades');
  const shown: HistoryTab = forceTab ?? tab;

  useEffect(() => {
    if (!forceTab && engine !== 'perps' && PERPS_ONLY.has(tab)) setTab('trades');
  }, [engine, tab, forceTab]);

  const tabs: HistoryTab[] = engine === 'perps' ? ['trades', 'orders', 'funding', 'positions'] : ['trades', 'orders'];
  const switcher = !forceTab && (
    <div className="segmented">
      {tabs.map((t) => (
        <button type="button" key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
      ))}
    </div>
  );
  const action = (showTitle || switcher || headAction) ? (
    <>
      {showTitle && <h2>History</h2>}
      {switcher}
      {headAction}
    </>
  ) : undefined;

  return (
    <HistoryTable
      kind={shown}
      engine={engine}
      address={address}
      byName={byName}
      refreshToken={refreshToken}
      symbolFilter={symbolFilter}
      filter={filter}
      onResetView={onResetView}
      onMeta={onMeta}
      headAction={action}
      cardView={cardView}
    />
  );
}

/*
 * The four account tables, each wrapped in its own incognito category.
 * Wrapping here rather than threading a masker through every value: each call
 * site is a chance to miss one. See `Private` in privacy.tsx.
 */
export function Balances(props: Parameters<typeof BalancesInner>[0]) {
  return <Private k="funds"><BalancesInner {...props} /></Private>;
}
export function Positions(props: Parameters<typeof PositionsInner>[0]) {
  return <Private k="positions"><PositionsInner {...props} /></Private>;
}
export function OpenOrders(props: Parameters<typeof OpenOrdersInner>[0]) {
  return <Private k="orders"><OpenOrdersInner {...props} /></Private>;
}
export function History(props: Parameters<typeof HistoryInner>[0]) {
  return <Private k="history"><HistoryInner {...props} /></Private>;
}

/**
 * Keeps the account's live data warm while the account band is on the page,
 * whichever tab is showing: positions, open orders and account state stay
 * subscribed (the shared feeds in accountFeeds.ts, the same keys and fetchers
 * the tables use) and follow SoDEX's account stream. Switching tabs then shows
 * current data at once instead of a spinner; leaving the page releases it all.
 */
export function AccountKeepAlive({ engine, address }: { engine: Engine; address: string | null }) {
  const posKey = address ? `pos:${address}` : null;
  const ordersKey = address ? `orders:${engine}:${address}` : null;
  const stateKey = address ? `state:${engine}:${address}` : null;
  useAccountResource(posKey, () => api.positions(address!), 10_000);
  useAccountResource(ordersKey, () => api.openOrders(engine, address!), 10_000);
  useAccountResource(stateKey, () => api.state(engine, address!), 20_000);
  useAccountStream('perps', address, () => bumpAccountResource(posKey));
  useAccountStream(engine, address, () => {
    bumpAccountResource(ordersKey);
    bumpAccountResource(stateKey);
  });
  return null;
}
