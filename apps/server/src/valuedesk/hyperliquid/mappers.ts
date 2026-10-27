/**
 * Pure mappers from raw Hyperliquid payloads to the ValueDesk contract
 * (../types.ts). No I/O, no clocks: everything here is unit-tested against
 * small fixtures in test/valuedesk-hyperliquid.test.ts.
 */
import { closeRuns, winRateOf } from '../winRate.js';
import type {
  EquityPoint,
  Positioning,
  TraderRow,
  VsFill,
  VsPosition,
  WhaleTrade,
  Window,
} from '../types.js';
import type {
  HlClearinghouseState,
  HlFillRaw,
  HlMetaAndAssetCtxs,
  HlPortfolio,
  HlPortfolioWindow,
  HlPositionRaw,
  HlWindowName,
  HlWsTrade,
} from './raw.js';

/** Decimal string (or number) to a finite number, else null. Never 0 for "missing". */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** HL window name to ours. The perp-only portfolio windows (perpDay, ...) are not mapped. */
export const WINDOW_OF: Readonly<Record<HlWindowName, Window>> = {
  day: '1d',
  week: '7d',
  month: '30d',
  allTime: 'all',
};

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export function normAddress(a: unknown): string | null {
  if (typeof a !== 'string') return null;
  const l = a.trim().toLowerCase();
  return ADDRESS_RE.test(l) ? l : null;
}

// --- positions -------------------------------------------------------------------

/**
 * One clearinghouse position to a VsPosition. null for a flat (szi = 0) entry.
 *
 * markPx is derived as positionValue / |szi|. HL computes positionValue from
 * the mark price in the same snapshot as unrealizedPnl, so this is the exact
 * mark the PnL was taken at, and it costs no extra request. `marks` (from a
 * cached metaAndAssetCtxs) is only a fallback if positionValue is unusable.
 *
 * `dex` names the HIP-3 dex the state was read from; HL already prefixes those
 * coins ("xyz:SP500"), and the prefix is added here only if it is missing.
 */
export function mapPosition(p: HlPositionRaw, dex = '', marks?: ReadonlyMap<string, number>): VsPosition | null {
  const szi = num(p.szi);
  if (szi === null || szi === 0) return null;
  const symbol = dex && !p.coin.includes(':') ? `${dex}:${p.coin}` : p.coin;
  const size = Math.abs(szi);
  const value = num(p.positionValue);
  const derived = value !== null && value > 0 ? value / size : null;
  const markPx = derived ?? marks?.get(symbol) ?? null;
  const notional = value !== null ? Math.abs(value) : markPx !== null ? size * markPx : 0;
  const lev = p.leverage;
  return {
    symbol,
    side: szi > 0 ? 'long' : 'short',
    size,
    notional,
    entryPx: num(p.entryPx),
    markPx,
    liqPx: num(p.liquidationPx),
    uPnl: num(p.unrealizedPnl),
    leverage: lev && typeof lev.value === 'number' ? lev.value : null,
    marginMode: lev?.type === 'cross' || lev?.type === 'isolated' ? lev.type : null,
  };
}

export function mapPositions(state: HlClearinghouseState | null | undefined, dex = '', marks?: ReadonlyMap<string, number>): VsPosition[] {
  const out: VsPosition[] = [];
  for (const ap of state?.assetPositions ?? []) {
    const p = ap?.position ? mapPosition(ap.position, dex, marks) : null;
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.notional - a.notional);
}

// --- fills -----------------------------------------------------------------------

const USD_TOKENS = new Set(['USDC', 'USDH', 'USDT', 'USDT0', 'USDE', 'USD']);

/**
 * HL fill to VsFill.
 * - side is the USER's side (B = buy), not the taker's.
 * - fee already includes any builder fee (verified: 7.5 bps = 3.6 + 3.9).
 * - Spot buys pay the fee in the received base token; that is converted to USD
 *   at the fill price so `fee` is always USD, as the contract says.
 */
export function mapFill(f: HlFillRaw): VsFill {
  const px = num(f.px) ?? 0;
  const sz = num(f.sz) ?? 0;
  const rawFee = num(f.fee);
  const feeToken = (f.feeToken ?? 'USDC').toUpperCase();
  const fee = rawFee === null ? null : USD_TOKENS.has(feeToken) ? rawFee : rawFee * px;
  return {
    id: String(f.tid),
    time: f.time,
    symbol: f.coin,
    side: f.side === 'B' ? 'buy' : 'sell',
    px,
    sz,
    notional: px * sz,
    fee,
    closedPnl: num(f.closedPnl),
    dir: f.dir ?? null,
    oid: typeof f.oid === 'number' ? String(f.oid) : null,
  };
}

export interface FillStats {
  /** Distinct orders that closed or reduced exposure. */
  trades: number;
  /** Win rate by the shared definition (valuedesk/winRate.ts); null below its threshold. */
  winRate: number | null;
  /** The sample is the account's whole history (fewer fills than one page). */
  winRateExact: boolean;
  /** Closes (runs of reducing fills) with a non-zero result, and the winners among them. */
  closes: number;
  wins: number;
  lastActive: number | null;
  /** Oldest fill in the sample: the stats cover [sampleFrom, lastActive]. */
  sampleFrom: number | null;
  sampleSize: number;
}

const CLOSING_DIR = /^close|>|liquidat/i;

/**
 * Trade count and win rate from a fill sample (the provider uses the last
 * 2,000 fills, aggregateByTime, one request).
 *
 * A "trade" is one ORDER that realised PnL: every fill that closes, flips or
 * is liquidated (closedPnl != 0, or dir "Close ...", "Long > Short",
 * "Liquidated ...") is grouped by oid. Counting per order rather than per
 * fill stops one market order that sweeps ten makers from counting as ten.
 *
 * The WIN RATE is the shared one (valuedesk/winRate.ts): a close is a run of
 * reducing fills in one market, so a position closed in 135 TWAP slices is
 * one close, not 135 losses. A win is a positive gross closedPnl (before
 * fees). A sample shorter than a full page is the whole history (exact);
 * otherwise it is an estimate over [sampleFrom, lastActive], shown from
 * WIN_RATE_MIN_CLOSES closes.
 */
export function fillStats(fills: readonly HlFillRaw[], pageSize = 2000): FillStats {
  const closes = new Map<string, number>();
  let last: number | null = null;
  let first: number | null = null;
  for (const f of fills) {
    if (typeof f.time === 'number') {
      if (last === null || f.time > last) last = f.time;
      if (first === null || f.time < first) first = f.time;
    }
    const pnl = num(f.closedPnl) ?? 0;
    if (pnl === 0 && !CLOSING_DIR.test(f.dir ?? '')) continue;
    const key = typeof f.oid === 'number' ? `o${f.oid}` : `t${f.tid}`;
    closes.set(key, (closes.get(key) ?? 0) + pnl);
  }
  const runs = closeRuns(fills.map((f) => ({ symbol: f.coin, t: f.time, side: f.side === 'B' ? 1 : -1, closedPnl: num(f.closedPnl) ?? 0 })));
  const exact = fills.length < pageSize;
  const wr = winRateOf(runs.wins, runs.closes, exact);
  return {
    trades: closes.size,
    winRate: wr.winRate,
    winRateExact: exact,
    closes: runs.closes,
    wins: runs.wins,
    lastActive: last,
    sampleFrom: first,
    sampleSize: fills.length,
  };
}

// --- portfolio / equity ----------------------------------------------------------

export function portfolioWindow(p: HlPortfolio | null | undefined, name: string): HlPortfolioWindow | null {
  if (!Array.isArray(p)) return null;
  for (const entry of p) {
    if (Array.isArray(entry) && entry[0] === name && entry[1]) return entry[1];
  }
  return null;
}

/** Zip accountValueHistory and pnlHistory by timestamp, oldest first. */
export function equitySeries(w: HlPortfolioWindow | null | undefined): EquityPoint[] {
  if (!w) return [];
  const by = new Map<number, EquityPoint>();
  const at = (t: number): EquityPoint => {
    let pt = by.get(t);
    if (!pt) {
      pt = { t, accountValue: null, pnl: null };
      by.set(t, pt);
    }
    return pt;
  };
  for (const [t, v] of w.accountValueHistory ?? []) if (typeof t === 'number') at(t).accountValue = num(v);
  for (const [t, v] of w.pnlHistory ?? []) if (typeof t === 'number') at(t).pnl = num(v);
  return [...by.values()].sort((a, b) => a.t - b.t);
}

export function mapPortfolio(p: HlPortfolio | null | undefined): Partial<Record<Window, EquityPoint[]>> {
  const out: Partial<Record<Window, EquityPoint[]>> = {};
  for (const [hl, w] of Object.entries(WINDOW_OF) as Array<[HlWindowName, Window]>) {
    const series = equitySeries(portfolioWindow(p, hl));
    if (series.length) out[w] = series;
  }
  return out;
}

/** Below this, a period return is noise (dust accounts), so the interval is skipped. */
const MIN_EQUITY_USD = 10;
/**
 * Intervals where the capital was under this fraction of the window's peak
 * account value are skipped too. Verified on a live account: it traded ~$2k
 * in 2023, was wiped out, and runs ~$500k today; without this floor the old
 * dust wipe-out reads as a 100% drawdown for a trader copied at $500k.
 */
const MIN_EQUITY_OF_PEAK = 0.01;

/**
 * Flow-neutral period returns from an equity series.
 *
 * PnL deltas exclude deposits and withdrawals by definition, account value
 * does not. r = dPnL / capital, where capital = max(AV before, AV after minus
 * dPnL): the larger of the capital at the start of the interval and the
 * capital after any deposit inside it. That stops a $100 account that deposits
 * $1M and then loses $50k from reading as a -50,000% period.
 */
export function periodReturns(series: readonly EquityPoint[]): number[] {
  const peak = series.reduce((m, pt) => (pt.accountValue !== null && pt.accountValue > m ? pt.accountValue : m), 0);
  const floor = Math.max(MIN_EQUITY_USD, peak * MIN_EQUITY_OF_PEAK);
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]!;
    const b = series[i]!;
    if (a.accountValue === null || a.pnl === null || b.pnl === null) continue;
    const dPnl = b.pnl - a.pnl;
    const capital = Math.max(a.accountValue, b.accountValue !== null ? b.accountValue - dPnl : a.accountValue);
    if (!(capital >= floor)) continue;
    out.push(Math.max(-1, dPnl / capital));
  }
  return out;
}

/** Time-weighted return over the series, as a fraction. null if no usable interval. */
export function twr(series: readonly EquityPoint[]): number | null {
  const rs = periodReturns(series);
  if (!rs.length) return null;
  return rs.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Worst peak-to-trough of the compounded return index, as a positive fraction. */
export function maxDrawdownOf(series: readonly EquityPoint[]): number | null {
  const rs = periodReturns(series);
  if (!rs.length) return null;
  let idx = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of rs) {
    idx *= 1 + r;
    if (idx > peak) peak = idx;
    const dd = peak > 0 ? 1 - idx / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

/**
 * Windows used for drawdown and portfolio ROI. `allTime` is left out on
 * purpose: its points are 1 to 2 weeks apart, and on live accounts it carries
 * accounting jumps (one master showed a -$271M single-step PnL move while its
 * account value stayed near $1M) that no flow adjustment can separate from a
 * real loss.
 */
const RETURN_WINDOWS: readonly HlWindowName[] = ['day', 'week', 'month'];

/**
 * 30-day max drawdown. day, week and month are three samplings of the same
 * recent equity curve (about every 2 h, 2.5 h and 16 h), so each one's
 * drawdown is a lower bound of the true one and the max is the best estimate.
 */
export function portfolioMaxDrawdown(p: HlPortfolio | null | undefined): number | null {
  let best: number | null = null;
  for (const hl of RETURN_WINDOWS) {
    const dd = maxDrawdownOf(equitySeries(portfolioWindow(p, hl)));
    if (dd !== null && (best === null || dd > best)) best = dd;
  }
  return best;
}

/** Did this account ever hold value, book PnL or trade? */
export function portfolioHasActivity(p: HlPortfolio | null | undefined): boolean {
  if (!Array.isArray(p)) return false;
  for (const entry of p) {
    const w = Array.isArray(entry) ? entry[1] : null;
    if (!w) continue;
    if ((num(w.vlm) ?? 0) !== 0) return true;
    for (const [, v] of w.accountValueHistory ?? []) if ((num(v) ?? 0) !== 0) return true;
    for (const [, v] of w.pnlHistory ?? []) if ((num(v) ?? 0) !== 0) return true;
  }
  return false;
}

/**
 * A TraderRow for an address that is not on the leaderboard, from its own
 * portfolio: pnl = cumulative PnL at the end of each window, roi = the
 * time-weighted return over the window (flow-neutral, see periodReturns),
 * volume = the window's vlm. roi.all stays null (see RETURN_WINDOWS).
 */
export function summaryFromPortfolio(address: string, p: HlPortfolio | null | undefined, liveAccountValue: number | null): TraderRow {
  const row: TraderRow = { venue: 'hyperliquid', address, label: null, accountValue: liveAccountValue, pnl: {}, roi: {}, volume: {} };
  let latestAv: { t: number; v: number } | null = null;
  for (const [hl, w] of Object.entries(WINDOW_OF) as Array<[HlWindowName, Window]>) {
    const raw = portfolioWindow(p, hl);
    if (!raw) continue;
    const series = equitySeries(raw);
    const lastPnl = [...series].reverse().find((pt) => pt.pnl !== null)?.pnl ?? null;
    row.pnl[w] = lastPnl;
    row.roi[w] = RETURN_WINDOWS.includes(hl) ? twr(series) : null;
    row.volume[w] = num(raw.vlm);
    for (const pt of series) {
      if (pt.accountValue !== null && (latestAv === null || pt.t >= latestAv.t)) latestAv = { t: pt.t, v: pt.accountValue };
    }
  }
  if (latestAv) row.accountValue = latestAv.v;
  return row;
}

// --- trades firehose (whales) ----------------------------------------------------

/**
 * The taker of a WS trade. HL's `side` is the AGGRESSOR's side and `users` is
 * always [buyer, seller], so B -> users[0], A -> users[1]. Verified live on
 * 2026-09-25: for a side "B" print the buyer's own fill had crossed:true, and
 * for a side "A" print the seller's did while the buyer's had crossed:false.
 */
export function takerOf(t: Pick<HlWsTrade, 'side' | 'users'>): string | null {
  const u = t.side === 'B' ? t.users?.[0] : t.side === 'A' ? t.users?.[1] : undefined;
  return normAddress(u);
}

const ZERO_HASH = /^0x0*$/i;

/**
 * Collapse the prints of one taker order into one WhaleTrade.
 *
 * A $500k market order that sweeps 20 makers arrives as 20 prints of $25k,
 * none of which would pass a $100k filter. Prints are grouped by
 * (coin, tx hash, side, taker), which is exactly "one taker order in one
 * block": HL sends a block's prints for a coin in one message. px becomes the
 * volume-weighted average. A zero hash (seen on some system trades) cannot be
 * trusted as a grouping key, so those prints stay separate.
 */
export function aggregateTakerPrints(trades: readonly HlWsTrade[]): WhaleTrade[] {
  const groups = new Map<string, WhaleTrade>();
  for (const t of trades) {
    const px = num(t.px);
    const sz = num(t.sz);
    if (px === null || sz === null || sz <= 0) continue;
    const taker = takerOf(t);
    const side = t.side === 'B' ? 'buy' : 'sell';
    const key = !t.hash || ZERO_HASH.test(t.hash) ? `tid:${t.tid}` : `${t.coin}|${t.hash}|${side}|${taker ?? ''}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { venue: 'hyperliquid', time: t.time, symbol: t.coin, side, px, sz, notional: px * sz, address: taker });
    } else {
      g.sz += sz;
      g.notional += px * sz;
      g.px = g.notional / g.sz;
      if (t.time > g.time) g.time = t.time;
    }
  }
  return [...groups.values()];
}

// --- markets ---------------------------------------------------------------------

export interface CoinVolume {
  coin: string;
  dayNtlVlm: number;
  markPx: number | null;
}

export function coinsFromMeta(meta: HlMetaAndAssetCtxs | null | undefined): CoinVolume[] {
  if (!Array.isArray(meta) || meta.length < 2) return [];
  const [m, ctxs] = meta;
  const out: CoinVolume[] = [];
  (m?.universe ?? []).forEach((u, i) => {
    const ctx = ctxs?.[i];
    if (!u?.name || u.isDelisted || !ctx) return;
    out.push({ coin: u.name, dayNtlVlm: num(ctx.dayNtlVlm) ?? 0, markPx: num(ctx.markPx) });
  });
  return out;
}

/** The n most traded coins (24h notional), highest first. */
export function topCoins(coins: readonly CoinVolume[], n: number): string[] {
  return [...coins]
    .filter((c) => c.dayNtlVlm > 0)
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm)
    .slice(0, n)
    .map((c) => c.coin);
}

// --- positioning -----------------------------------------------------------------

/**
 * Canonical key for symbol matching across venues' spellings:
 * "btc", "BTC-USD", "BTC/USDC", "BTC-PERP" all become "BTC"; "xyz:SP500"
 * becomes "XYZ:SP500".
 */
export function symbolKey(s: string): string {
  let k = s.trim().toUpperCase();
  for (let prev = ''; prev !== k; ) {
    prev = k;
    k = k.replace(/[-_/](USDC|USDT|USD|PERP)$/, '');
  }
  return k;
}

/** Does HL coin `coin` answer a request for `symbol`? "SP500" matches "xyz:SP500". */
export function symbolMatches(coin: string, symbol: string): boolean {
  const want = symbolKey(symbol);
  const have = symbolKey(coin);
  if (have === want) return true;
  const colon = have.indexOf(':');
  return !want.includes(':') && colon >= 0 && have.slice(colon + 1) === want;
}

/**
 * Net positioning per coin across a set of traders (one inner array per
 * trader). A trader counts once per side per coin.
 */
export function aggregatePositioning(traders: ReadonlyArray<readonly VsPosition[]>): Positioning[] {
  const by = new Map<string, Positioning>();
  for (const positions of traders) {
    const counted = new Set<string>();
    for (const p of positions) {
      let row = by.get(p.symbol);
      if (!row) {
        row = { venue: 'hyperliquid', symbol: p.symbol, longUsd: 0, shortUsd: 0, longTraders: 0, shortTraders: 0 };
        by.set(p.symbol, row);
      }
      const once = `${p.symbol}|${p.side}`;
      if (p.side === 'long') {
        row.longUsd += p.notional;
        if (!counted.has(once)) row.longTraders++;
      } else {
        row.shortUsd += p.notional;
        if (!counted.has(once)) row.shortTraders++;
      }
      counted.add(once);
    }
  }
  return [...by.values()].sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd));
}
