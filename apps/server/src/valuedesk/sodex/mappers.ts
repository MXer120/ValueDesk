/**
 * Pure mappers from SoDEX wire shapes to the ValueDesk contract (../types.ts).
 *
 * Nothing in this file does I/O, so every rule here is unit-tested against
 * verbatim live fixtures (test/valuedesk-sodex.test.ts). The shapes below were
 * observed on mainnet on 2026-09-25; the research notes are in
 * docs/research/01-sodex-valuechain.md and 04-opentrade-reuse-map.md.
 *
 * House rule, same as the rest of the server: `null` means "the venue did not
 * tell us". A missing number is never defaulted to 0 and never guessed.
 */
import { labelMatches } from '../labels.js';
import { winRateOf } from '../winRate.js';
import type {
  EquityPoint,
  Positioning,
  TraderRow,
  VsFill,
  VsPosition,
  Window,
} from '../types.js';

// --- windows -----------------------------------------------------------------

/** The leaderboard host's `window_type` enum (verified: anything else is HTTP 400). */
export type LbWindow = '24H' | '7D' | '30D' | 'ALL_TIME';
/** The portfolio-chart host's `window` enum (verified: "must be 24H, 7D, 30D, 90D, or 1Y"). */
export type ChartWindow = '24H' | '7D' | '30D' | '90D' | '1Y';

export const LB_WINDOW: Record<Window, LbWindow> = { '1d': '24H', '7d': '7D', '30d': '30D', all: 'ALL_TIME' };

/**
 * `all` maps to 1Y because the chart has no all-time window. SoDEX mainnet
 * opened in autumn 2025, so for now 1Y covers every account's whole life; once
 * the venue is older than a year this becomes "last 12 months".
 */
export const CHART_WINDOW: Record<Window, ChartWindow> = { '1d': '24H', '7d': '7D', '30d': '30D', all: '1Y' };

// --- primitives --------------------------------------------------------------

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Decimal string or number to a finite number, else null. Never 0 by default. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export const lowerAddress = (a: unknown): string | null =>
  typeof a === 'string' && ADDRESS_RE.test(a) ? a.toLowerCase() : null;

/** Evenly spaced samples that always keep the first and the last value. */
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max || max < 2) return values.slice();
  const out: number[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

// --- upstream shapes (mainnet-data.sodex.dev) --------------------------------

export interface LbItem {
  window_type: string;
  wallet_address: string;
  account_id: number;
  /** Decimal strings upstream. */
  pnl_usd: string;
  volume_usd: string;
  rank: number;
}

export interface LbPage {
  window_type: string;
  page: number;
  page_size: number;
  total: number;
  /** When the hourly ranking snapshot was taken (ms). */
  snapshot_ts: number;
  items: LbItem[] | null;
}

export interface LbRank {
  window_type: string;
  wallet_address: string;
  found: boolean;
  snapshot_ts: number;
  item?: LbItem;
}

export interface ChartPoint {
  ts_ms: number;
  account_value_usd: string;
  /** Cumulative PnL since the start of the window. */
  pnl_usd: string;
  spot_pnl_usd?: string;
  perps_pnl_usd?: string;
  vault_pnl_usd?: string;
  /** Cumulative return since the start of the window, as a fraction. */
  roi: string;
}

/** `/api/v1/wallet/portfolio/chart?account_id&window` - the venue's own portfolio curve. */
export interface PortfolioChart {
  account_id: number;
  window: string;
  market_type: string;
  total_pnl_usd: string;
  roi: string;
  chart: ChartPoint[] | null;
}

// --- upstream shapes (mainnet-gw.sodex.dev, account reads) -------------------

/** Terse position inside `/perps/accounts/{a}/state` `P[]`. `sz` is SIGNED. */
export interface StatePosition {
  i?: number;
  s: string;
  /** "CROSS" | "ISOLATED". */
  m?: string;
  /** Always "BOTH" (one-way mode), so the side comes from the sign of `sz`. */
  ps?: string;
  sz: string;
  ep?: string;
  /** Unrealised PnL. */
  ur?: string;
  l?: number;
  /** Liquidation price; "0" when there is none to report. */
  lp?: string;
  /** Realised PnL of this position so far. */
  cr?: string;
  ct?: number;
  ut?: number;
}

export interface PerpsState {
  user?: string;
  /** 0 = this wallet has no SoDEX account. */
  aid?: number;
  uid?: number;
  /** Account value (collateral at haircut-free price + unrealised PnL). */
  av?: string;
  am?: string;
  P?: StatePosition[] | null;
  O?: unknown[] | null;
}

export interface SpotBalance {
  i?: number;
  /** Coin name, e.g. "vETH", "WSOSO", "vUSDC". */
  a: string;
  /** Total. */
  t: string;
  /** Locked in orders. */
  l?: string;
}

export interface SpotState {
  user?: string;
  aid?: number;
  B?: SpotBalance[] | null;
  O?: unknown[] | null;
}

/** One fill from `/{engine}/accounts/{a}/trades` (bare array). */
export interface RawTrade {
  symbol?: string;
  tradeID?: number | string;
  orderID?: number | string;
  side?: string | number;
  price?: string;
  quantity?: string;
  /** Negative = rebate. Charged in `feeCoin`. */
  fee?: string;
  feeCoin?: string;
  time?: number;
  isMaker?: boolean;
}

/** One closed position from `/perps/accounts/{a}/positions/history` (bare array). */
export interface ClosedPosition {
  symbol?: string;
  positionSide?: string;
  realizedPnL?: string;
  leverage?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** One print on the gateway WS `trade` channel. */
export interface WsPrint {
  /** Send time. */
  E?: number;
  /** Block (match) time. */
  T: number;
  t?: number;
  s: string;
  /** Aggressor side: BUY means the buyer (`bi`) took liquidity. */
  S: string;
  p: string;
  q: string;
  /** Buyer account id. */
  bi: number;
  /** Seller account id. */
  si: number;
}

export interface MarkPrice {
  symbol: string;
  markPrice: string;
}

export interface SpotTicker {
  symbol: string;
  lastPx?: string;
}

// --- leaderboard -------------------------------------------------------------

/** One leaderboard item as a row for `window`. roi/accountValue are filled by enrichment. */
export function lbItemToRow(it: LbItem, window: Window): TraderRow | null {
  const address = lowerAddress(it?.wallet_address);
  if (!address) return null;
  return {
    venue: 'sodex',
    address,
    label: null,
    accountId: num(it.account_id),
    accountValue: null,
    pnl: { [window]: num(it.pnl_usd) },
    roi: { [window]: null },
    volume: { [window]: num(it.volume_usd) },
    rank: typeof it.rank === 'number' ? it.rank : undefined,
    rankChange: null,
  };
}

/** 1-based upstream page numbers that cover rows [offset, offset+limit). */
export function pagesFor(offset: number, limit: number, pageSize: number): number[] {
  if (limit <= 0) return [];
  const first = Math.floor(offset / pageSize) + 1;
  const last = Math.floor((offset + limit - 1) / pageSize) + 1;
  const out: number[] = [];
  for (let p = first; p <= last; p++) out.push(p);
  return out;
}

/**
 * The contract's search: case-insensitive address prefix (with or without 0x),
 * label substring, or an exact SoDEX account id.
 */
export function matchesQuery(row: TraderRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  // Digits are ambiguous: an account id, or the start of an address.
  if (/^\d+$/.test(s) && row.accountId != null && String(row.accountId) === s) return true;
  const bare = s.startsWith('0x') ? s.slice(2) : s;
  if (/^[0-9a-f]+$/.test(bare) && row.address.slice(2).startsWith(bare)) return true;
  return labelMatches(row.address, row.label, s);
}

/**
 * Remembers each address's rank in the previous hourly snapshot, so a row can
 * say how far it moved. Only knows what this process has seen: until two
 * snapshots have been observed for a board, `rankChange` stays null.
 */
export class RankHistory {
  private boards = new Map<
    string,
    { cur: { snap: number; ranks: Map<string, number> }; prev: { snap: number; ranks: Map<string, number> } | null }
  >();

  constructor(private readonly maxPerBoard = 20_000) {}

  /** Positive = moved up since the previous snapshot. */
  observe(board: string, snapshot: number, address: string, rank: number): number | null {
    let b = this.boards.get(board);
    if (!b) {
      b = { cur: { snap: snapshot, ranks: new Map() }, prev: null };
      this.boards.set(board, b);
    }
    if (snapshot > b.cur.snap) {
      b.prev = b.cur;
      b.cur = { snap: snapshot, ranks: new Map() };
    }
    if (snapshot < b.cur.snap) {
      // A cached page from the older snapshot: compare within what it is.
      return null;
    }
    if (b.cur.ranks.size < this.maxPerBoard) b.cur.ranks.set(address, rank);
    const before = b.prev?.ranks.get(address);
    return before === undefined ? null : before - rank;
  }
}

// --- portfolio chart ---------------------------------------------------------

export function chartToEquity(c: PortfolioChart | null | undefined): EquityPoint[] {
  return (c?.chart ?? [])
    .map((p) => ({ t: Number(p.ts_ms), accountValue: num(p.account_value_usd), pnl: num(p.pnl_usd) }))
    .filter((p) => Number.isFinite(p.t) && p.t > 0)
    .sort((a, b) => a.t - b.t);
}

export interface ChartSummary {
  pnl: number | null;
  roi: number | null;
  /** Latest account value on the curve. */
  accountValue: number | null;
  /** Cumulative PnL, oldest to newest, downsampled for a sparkline. */
  spark: number[];
  asOf: number | null;
  /**
   * Share of the window's PnL that came from SoDEX vaults rather than trading
   * (null when the PnL is not positive). The top of the PnL board is full of
   * vault depositors with zero traded volume.
   */
  vaultShare: number | null;
}

/** A trader whose window PnL is at least this much vault yield is tagged 'vault'. */
export const VAULT_TAG_SHARE = 0.5;

export function summariseChart(c: PortfolioChart | null | undefined, sparkPoints = 40): ChartSummary {
  const pts = chartToEquity(c);
  const last = pts[pts.length - 1];
  const rawLast = (c?.chart ?? []).reduce<ChartPoint | undefined>(
    (a, p) => (!a || Number(p.ts_ms) > Number(a.ts_ms) ? p : a),
    undefined,
  );
  const lastPnl = num(rawLast?.pnl_usd);
  const lastVault = num(rawLast?.vault_pnl_usd);
  return {
    pnl: num(c?.total_pnl_usd),
    roi: num(c?.roi),
    accountValue: last?.accountValue ?? null,
    spark: downsample(
      pts.map((p) => p.pnl).filter((v): v is number => v !== null),
      sparkPoints,
    ),
    asOf: last?.t ?? null,
    vaultShare: lastPnl !== null && lastPnl > 0 && lastVault !== null ? lastVault / lastPnl : null,
  };
}

/**
 * Return index (1 + cumulative roi) of a chart, with the leading stretch before
 * the account existed trimmed off. That stretch is all zeros on the 1Y chart and
 * would otherwise dilute every per-period statistic.
 */
export function returnIndex(c: PortfolioChart | null | undefined): number[] {
  const pts = (c?.chart ?? []).slice().sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));
  let start = 0;
  while (start < pts.length) {
    const p = pts[start]!;
    const av = num(p.account_value_usd) ?? 0;
    const pnl = num(p.pnl_usd) ?? 0;
    if (av > 0 || pnl !== 0) break;
    start++;
  }
  const out: number[] = [];
  for (const p of pts.slice(start)) {
    const r = num(p.roi);
    if (r === null) continue;
    out.push(1 + r);
  }
  return out;
}

/**
 * Worst peak-to-trough of the return index, as a positive fraction. The window
 * starts at index 1, so a loss straight from the start counts. Account value is
 * deliberately NOT used: deposits and withdrawals move it without any trading.
 */
export function maxDrawdown(index: number[]): number | null {
  if (index.length < 2) return null;
  let peak = 1;
  let worst = 0;
  for (const v of index) {
    if (!(v > 0)) return 1; // the index went to zero or below: everything was lost
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** Annualised Sharpe of per-period returns of the index (rf = 0), or null if too short or flat. */
export function sharpe(index: number[], periodsPerYear = 365, minReturns = 14): number | null {
  const rets: number[] = [];
  for (let i = 1; i < index.length; i++) {
    const a = index[i - 1]!;
    const b = index[i]!;
    if (a > 0 && b > 0) rets.push(b / a - 1);
  }
  if (rets.length < minReturns) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-12)) return null;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

// --- positions and balances --------------------------------------------------

export const markMap = (marks: MarkPrice[] | null | undefined): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of marks ?? []) {
    const px = num(x?.markPrice);
    if (x?.symbol && px !== null && px > 0) m.set(x.symbol, px);
  }
  return m;
};

/** Perps positions from the account state. Flat rows are dropped. */
export function statePositions(P: StatePosition[] | null | undefined, marks: Map<string, number>): VsPosition[] {
  const out: VsPosition[] = [];
  for (const p of P ?? []) {
    const signed = num(p?.sz);
    if (!p?.s || signed === null || signed === 0) continue;
    const size = Math.abs(signed);
    const entry = num(p.ep);
    const upnl = num(p.ur);
    // The venue's mark first; else the one implied by entry + uPnL.
    let mark = marks.get(p.s) ?? null;
    if (mark === null && entry !== null && upnl !== null) mark = entry + upnl / signed;
    const liq = num(p.lp);
    const mode = String(p.m ?? '').toUpperCase();
    out.push({
      symbol: p.s,
      side: signed > 0 ? 'long' : 'short',
      size,
      notional: size * (mark ?? entry ?? 0),
      entryPx: entry,
      markPx: mark,
      // "0" is how the venue says "no liquidation price" (cross, well collateralised).
      liqPx: liq !== null && liq > 0 ? liq : null,
      uPnl: upnl,
      leverage: typeof p.l === 'number' && p.l > 0 ? p.l : null,
      marginMode: mode === 'CROSS' ? 'cross' : mode === 'ISOLATED' ? 'isolated' : null,
    });
  }
  return out.sort((a, b) => b.notional - a.notional);
}

const STABLES = new Set(['vUSDC', 'USDC', 'vUSD', 'USD']);

/**
 * Coin -> USD price for spot balances: the coin's `_vUSDC` spot ticker first,
 * then the perps mark of the same underlying ("vETH" -> "ETH-USD", "WSOSO" ->
 * "SOSO-USD"). A coin with neither is left unpriced, not priced at 0.
 */
export function spotPrices(tickers: SpotTicker[] | null | undefined, marks: Map<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of STABLES) m.set(s, 1);
  for (const t of tickers ?? []) {
    const [base, quote] = String(t?.symbol ?? '').split('_');
    const px = num(t?.lastPx);
    if (base && quote === 'vUSDC' && px !== null && px > 0 && !m.has(base)) m.set(base, px);
  }
  for (const [sym, px] of marks) {
    const under = sym.replace(/-USD$/, '');
    for (const coin of [`v${under}`, `W${under}`]) if (!m.has(coin)) m.set(coin, px);
  }
  return m;
}

export function spotValue(
  B: SpotBalance[] | null | undefined,
  prices: Map<string, number>,
): { value: number; unpriced: string[] } {
  let value = 0;
  const unpriced: string[] = [];
  for (const b of B ?? []) {
    const amt = num(b?.t);
    if (!b?.a || amt === null || amt === 0) continue;
    const px = prices.get(b.a);
    if (px === undefined) unpriced.push(b.a);
    else value += amt * px;
  }
  return { value, unpriced };
}

// --- closed positions: win rate and style ------------------------------------

export interface ClosedStats {
  /** Closed positions in the sample. */
  count: number;
  /** By the shared definition (valuedesk/winRate.ts): one closed position = one close. Null below its threshold. */
  winRate: number | null;
  /** The sample is every closed position (fewer than `limit`). */
  winRateExact: boolean;
  closes: number;
  wins: number;
  /** Oldest close in the sample. */
  firstClosedAt: number | null;
  /** Median holding time in ms. */
  medianHoldMs: number | null;
  medianLeverage: number | null;
  lastClosedAt: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function closedStats(rows: ClosedPosition[] | null | undefined, limit = Number.POSITIVE_INFINITY): ClosedStats {
  let wins = 0;
  let losses = 0;
  const holds: number[] = [];
  const levs: number[] = [];
  let last: number | null = null;
  let first: number | null = null;
  const list = rows ?? [];
  for (const r of list) {
    const pnl = num(r?.realizedPnL);
    if (pnl !== null && pnl > 0) wins++;
    else if (pnl !== null && pnl < 0) losses++;
    const a = num(r?.createdAt);
    const b = num(r?.updatedAt);
    if (a !== null && b !== null && b >= a) holds.push(b - a);
    if (b !== null && (last === null || b > last)) last = b;
    if (b !== null && (first === null || b < first)) first = b;
    const l = num(r?.leverage);
    if (l !== null && l > 0) levs.push(l);
  }
  const exact = list.length < limit;
  return {
    count: list.length,
    winRate: winRateOf(wins, wins + losses, exact).winRate,
    winRateExact: exact,
    closes: wins + losses,
    wins,
    firstClosedAt: first,
    medianHoldMs: median(holds),
    medianLeverage: median(levs),
    lastClosedAt: last,
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Style tags. Each rule states its own threshold; none is inferred from thin data. */
export function styleTags(o: {
  accountValue: number | null;
  positions: VsPosition[];
  closed: ClosedStats;
}): string[] {
  const tags: string[] = [];
  const exposure = o.positions.reduce((s, p) => s + p.notional, 0);
  if ((o.accountValue ?? 0) >= 500_000 || exposure >= 1_000_000) tags.push('whale');
  const openLev = Math.max(0, ...o.positions.map((p) => p.leverage ?? 0));
  if (openLev >= 20 || (o.closed.medianLeverage ?? 0) >= 20) tags.push('high-leverage');
  if (o.closed.count >= 20 && o.closed.medianHoldMs !== null) {
    if (o.closed.medianHoldMs < 15 * MIN) tags.push('scalper');
    else if (o.closed.medianHoldMs >= 24 * HOUR) tags.push('swing');
    else tags.push('intraday');
  }
  return tags;
}

// --- fills -------------------------------------------------------------------

export function fillSide(side: unknown): 'buy' | 'sell' | null {
  const s = String(side ?? '').toUpperCase();
  if (s === 'BUY' || s === '1') return 'buy';
  if (s === 'SELL' || s === '2') return 'sell';
  return null;
}

/**
 * The fee in USD, where that is knowable. Perps and spot SELL fees are charged
 * in the quote coin (vUSDC). Spot BUY fees are charged in the BASE coin, so
 * they are converted at the fill price. Any other coin stays null rather than
 * being passed off as dollars.
 */
export function feeUsd(fee: number | null, feeCoin: string | undefined, symbol: string, px: number): number | null {
  if (fee === null) return null;
  if (!feeCoin || STABLES.has(feeCoin)) return feeCoin ? fee : null;
  const base = symbol.includes('_') ? symbol.split('_')[0] : null;
  if (base && feeCoin === base) return fee * px;
  return null;
}

/** `rowKey` must be unique per fill (see history.ts: tradeID alone is NOT). */
export function tradeToFill(engine: 'perps' | 'spot', t: RawTrade, rowKey: string): VsFill | null {
  const symbol = typeof t?.symbol === 'string' ? t.symbol : null;
  const side = fillSide(t?.side);
  const px = num(t?.price);
  const sz = num(t?.quantity);
  const time = num(t?.time);
  if (!symbol || !side || px === null || sz === null || time === null) return null;
  return {
    id: `${engine === 'perps' ? 'p' : 's'}:${t.tradeID ?? '?'}:${rowKey.slice(0, 10)}`,
    time,
    symbol,
    side,
    px,
    sz,
    notional: px * sz,
    fee: feeUsd(num(t.fee), t.feeCoin, symbol, px),
    closedPnl: null,
    dir: null,
  };
}

// --- whales ------------------------------------------------------------------

/** Who took liquidity on a print. `S` is the aggressor: BUY => the buyer `bi`. */
export function takerOf(p: WsPrint): { side: 'buy' | 'sell'; accountId: number } | null {
  const S = String(p?.S ?? '').toUpperCase();
  if (S === 'BUY' && Number.isInteger(p.bi)) return { side: 'buy', accountId: p.bi };
  if (S === 'SELL' && Number.isInteger(p.si)) return { side: 'sell', accountId: p.si };
  return null;
}

export interface WhaleAgg {
  time: number;
  symbol: string;
  side: 'buy' | 'sell';
  accountId: number;
  sz: number;
  notional: number;
  /** Local receive time of the first print, for flushing. */
  seenAt: number;
}

/**
 * Folds the prints of one taker order into one trade.
 *
 * A market order that sweeps five resting orders arrives as five prints with
 * the same taker, side, symbol and block time. Judged print by print, a $60k
 * sweep of $12k fills would look like five medium trades, or like nothing at
 * all under a $50k filter. So prints are grouped by (symbol, side, taker, T)
 * and released once no more can arrive (`holdMs` after the first one).
 */
export class WhaleAggregator {
  private pending = new Map<string, WhaleAgg>();

  constructor(private readonly holdMs = 1_500) {}

  add(p: WsPrint, now: number): void {
    const taker = takerOf(p);
    const px = num(p?.p);
    const q = num(p?.q);
    const T = num(p?.T);
    if (!taker || !p?.s || px === null || q === null || T === null) return;
    const key = `${p.s}|${taker.side}|${taker.accountId}|${T}`;
    const agg = this.pending.get(key);
    if (agg) {
      agg.sz += q;
      agg.notional += px * q;
    } else {
      this.pending.set(key, {
        time: T,
        symbol: p.s,
        side: taker.side,
        accountId: taker.accountId,
        sz: q,
        notional: px * q,
        seenAt: now,
      });
    }
  }

  /** Completed groups at or above `minNotional`, oldest first. Smaller ones are discarded. */
  flush(now: number, minNotional: number, force = false): WhaleAgg[] {
    const out: WhaleAgg[] = [];
    for (const [k, a] of this.pending) {
      if (!force && now - a.seenAt < this.holdMs) continue;
      this.pending.delete(k);
      if (a.notional >= minNotional) out.push(a);
    }
    return out.sort((a, b) => a.time - b.time);
  }

  get size(): number {
    return this.pending.size;
  }
}

// --- positioning -------------------------------------------------------------

export function aggregatePositioning(accounts: Array<{ positions: VsPosition[] }>): Positioning[] {
  const by = new Map<string, Positioning>();
  for (const a of accounts) {
    for (const p of a.positions) {
      let row = by.get(p.symbol);
      if (!row) {
        row = { venue: 'sodex', symbol: p.symbol, longUsd: 0, shortUsd: 0, longTraders: 0, shortTraders: 0 };
        by.set(p.symbol, row);
      }
      // One-way mode: an account holds at most one position per symbol.
      if (p.side === 'long') {
        row.longUsd += p.notional;
        row.longTraders++;
      } else {
        row.shortUsd += p.notional;
        row.shortTraders++;
      }
    }
  }
  return [...by.values()].sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd));
}

/** "btc", "BTC", "BTC-USD" all select "BTC-USD". */
export function symbolMatches(symbol: string, wanted: string): boolean {
  const w = wanted.trim().toUpperCase();
  if (!w) return true;
  const s = symbol.toUpperCase();
  return s === w || s === `${w}-USD` || s.split('-')[0] === w;
}

// --- analytics that cannot be trusted -----------------------------------------------

/**
 * Why SoDEX's portfolio analytics for an account cannot be used, or null.
 *
 *   no-deposits-recorded  every point with a balance has account value == PnL:
 *                         the analytics never saw a deposit, so a transfer-in
 *                         reads as profit (account 23342: 0 -> +$5.07M in one
 *                         hour, ROI 49,959x, then flat while the live account
 *                         holds 92 positions and ~$17M).
 *   live-mismatch         the account holds far more live (perps + spot) than
 *                         the chart's latest value: the analytics stopped
 *                         following it. (Less live than the chart is normal:
 *                         vault deposits count on the chart only.)
 *   single-jump           90%+ of the window's PnL arrived in one point, on an
 *                         account that was empty just before: a balance booked
 *                         as profit.
 *
 * Pure. `liveValue` is perps account value + spot at market, when known.
 */
export type AnalyticsSuspect = 'no-deposits-recorded' | 'live-mismatch' | 'single-jump';

/** Points with a balance needed before "value always equals PnL" means anything. */
const SUSPECT_MIN_POINTS = 3;

export function chartSuspect(c: PortfolioChart | null | undefined, liveValue: number | null = null): AnalyticsSuspect | null {
  const pts = chartToEquity(c);
  const funded = pts.filter((p) => p.accountValue !== null && p.accountValue > 0);
  if (funded.length >= SUSPECT_MIN_POINTS && funded.every((p) => Math.abs(p.accountValue! - (p.pnl ?? 0)) < Math.max(1, 1e-6 * p.accountValue!))) {
    return 'no-deposits-recorded';
  }
  const last = [...pts].reverse().find((p) => p.accountValue !== null);
  if (liveValue !== null && last?.accountValue != null && liveValue > last.accountValue * 1.2 + 1_000) return 'live-mismatch';
  // A balance appearing from (almost) nothing AS profit: the PnL step and the
  // value step are the same money. A trade that wins big on a funded account
  // does not look like this (its value was there before the step).
  const total = pts.length ? pts[pts.length - 1]!.pnl : null;
  if (total !== null && Math.abs(total) >= 10_000) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (a.pnl === null || b.pnl === null || a.accountValue === null || b.accountValue === null) continue;
      const dp = b.pnl - a.pnl;
      const dv = b.accountValue - a.accountValue;
      if (Math.abs(dp) >= 0.9 * Math.abs(total) && Math.sign(dp) === Math.sign(total)
        && a.accountValue <= 0.01 * b.accountValue && Math.abs(dv - dp) <= 0.01 * Math.abs(dp)) return 'single-jump';
    }
  }
  return null;
}

/** An equity curve without its account-value series (drawn from the analytics that cannot be trusted). */
export function withoutAccountValue(pts: EquityPoint[]): EquityPoint[] {
  return pts.map((p) => ({ ...p, accountValue: null }));
}

/**
 * A window's curve from the 1Y chart, rebased to 0 at the window start, when
 * the window's own chart came back empty. Null when the 1Y chart has fewer
 * than two points in the window.
 */
export function rebaseWindow(year: EquityPoint[], fromT: number): EquityPoint[] | null {
  const inWin = year.filter((p) => p.t >= fromT);
  if (inWin.length < 2) return null;
  const before = [...year].reverse().find((p) => p.t < fromT && p.pnl !== null);
  const base = before?.pnl ?? inWin[0]!.pnl ?? 0;
  return inWin.map((p) => ({ t: p.t, accountValue: p.accountValue, pnl: p.pnl === null ? null : p.pnl - base }));
}
