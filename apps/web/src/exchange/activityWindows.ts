/**
 * What a wallet's own SoDEX history adds up to in a time window (the Portfolio summary).
 *
 * The rows are the ones allTime.ts walks from SoDEX in this browser, nothing from our index. Two rules:
 *
 *  - A figure is either final or it does not exist. `coverOf` says whether the walk has established everything in
 *    the window; until it has, the reader gets no number, so a partial sum cannot be shown as if it were the answer.
 *  - Only what the walk has covered contiguously counts: rows above the checkpoint's `newest` belong to a catch-up
 *    still running, with a possible hole under them.
 *
 * FEES. Every market on SoDEX is quoted in vUSDC (checked 2026-11-06: 105 perps, 43 spot), and a fill's fee is charged
 * in vUSDC or, on a spot buy, in the coin bought. A fee in the coin bought is that fill's price times the fee, which
 * is what it cost at that moment. A fee in any other coin has no price on its row, so it stays listed by coin and out
 * of the dollar figure, never guessed.
 */
import { DecimalSum } from '@sign/historyStats.js';
import { mulDecimal } from '@sign/sodex/decimalMath.js';
import type { NormalRow } from '@sign/historyRows.js';
import { VENUE_ROW_LIMIT, type ScopeState } from '@sign/historySync.js';

export interface CoinAmount { coin: string | null; amount: number }

export interface TradeFigures {
  trades: number;
  buys: number;
  sells: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** Dollars, positive = paid. */
  commission: number;
  latestCommission: number | null;
  /** Fees in a coin the row gives no price for: not in `commission`. */
  otherFees: CoinAmount[];
  /** Rows missing a side, price, quantity or fee. Any at all makes the window incomplete. */
  unreadable: number;
}

export interface FundingFigures {
  payments: number;
  /** Dollars, as SoDEX signs it. */
  total: number;
  received: number;
  paid: number;
  latest: number | null;
  otherCoins: CoinAmount[];
  unreadable: number;
}

export type Cover =
  | { state: 'final'; asOf: number }
  | { state: 'reading'; rows: number; oldest: number | null }
  | { state: 'incomplete'; reason: string };

const isUsdc = (coin: string | null): boolean => coin !== null && /^v?USDC$/i.test(coin);
/** "vAVAX_vUSDC" -> "vAVAX". Perps symbols ("BTC-USD") have no base coin to pay a fee in. */
const baseOf = (symbol: string | null): string | null => (symbol?.includes('_') ? symbol.split('_')[0]! : null);

const readable = (v: string | null): boolean => v !== null && Number.isFinite(Number(v));

const inWindow = (r: NormalRow, since: number | null, top: number | null): boolean =>
  top !== null && Number.isFinite(r.time) && r.time <= top && (since === null || r.time >= since);

const coinTotals = (m: Map<string | null, DecimalSum>): CoinAmount[] =>
  [...m].map(([coin, sum]) => ({ coin, amount: Number(sum.toString()) }));

/** The fills from `since` (null: all) up to `top`, the checkpoint's `newest`. Exact decimals until the last step. */
export function tradeFigures(rows: readonly NormalRow[], since: number | null, top: number | null): TradeFigures {
  const buy = new DecimalSum();
  const sell = new DecimalSum();
  const other = new DecimalSum();
  const commission = new DecimalSum();
  const otherFees = new Map<string | null, DecimalSum>();
  let trades = 0;
  let buys = 0;
  let sells = 0;
  let unreadable = 0;
  let latestAt = -Infinity;
  let latest: number | null = null;
  for (const r of rows) {
    if (!Number.isFinite(r.time)) { unreadable++; continue; }
    if (!inWindow(r, since, top)) continue;
    trades++;
    const side = r.side?.toUpperCase();
    if (!readable(r.price) || !readable(r.qty) || !readable(r.fee) || (side !== 'BUY' && side !== 'SELL')) unreadable++;
    if (readable(r.price) && readable(r.qty)) {
      const notional = mulDecimal(r.price!, r.qty!);
      if (side === 'BUY') buy.add(notional);
      else if (side === 'SELL') sell.add(notional);
      else other.add(notional);
    }
    if (side === 'BUY') buys++;
    if (side === 'SELL') sells++;
    if (!readable(r.fee)) continue;
    let usd: string | null = null;
    if (isUsdc(r.feeCoin)) usd = r.fee;
    else if (r.feeCoin !== null && r.feeCoin === baseOf(r.symbol) && readable(r.price)) usd = mulDecimal(r.fee!, r.price!);
    if (usd === null) {
      const sum = otherFees.get(r.feeCoin) ?? new DecimalSum();
      sum.add(r.fee);
      otherFees.set(r.feeCoin, sum);
      continue;
    }
    commission.add(usd);
    if (r.time > latestAt) { latestAt = r.time; latest = Number(usd); }
  }
  const buyVolume = Number(buy.toString());
  const sellVolume = Number(sell.toString());
  const total = new DecimalSum();
  total.add(buy.toString());
  total.add(sell.toString());
  total.add(other.toString());
  return {
    trades, buys, sells,
    volume: Number(total.toString()),
    buyVolume, sellVolume,
    commission: Number(commission.toString()),
    latestCommission: latest,
    otherFees: coinTotals(otherFees),
    unreadable,
  };
}

export function fundingFigures(rows: readonly NormalRow[], since: number | null, top: number | null): FundingFigures {
  const total = new DecimalSum();
  const received = new DecimalSum();
  const paid = new DecimalSum();
  const others = new Map<string | null, DecimalSum>();
  let payments = 0;
  let unreadable = 0;
  let latestAt = -Infinity;
  let latest: number | null = null;
  for (const r of rows) {
    if (!Number.isFinite(r.time)) { unreadable++; continue; }
    if (!inWindow(r, since, top)) continue;
    payments++;
    if (!readable(r.fee)) { unreadable++; continue; }
    if (!isUsdc(r.feeCoin)) {
      const sum = others.get(r.feeCoin) ?? new DecimalSum();
      sum.add(r.fee);
      others.set(r.feeCoin, sum);
      continue;
    }
    total.add(r.fee);
    if (Number(r.fee) >= 0) received.add(r.fee);
    else paid.add(r.fee);
    if (r.time > latestAt) { latestAt = r.time; latest = Number(r.fee); }
  }
  return {
    payments,
    total: Number(total.toString()),
    received: Number(received.toString()),
    paid: Number(paid.toString()),
    latest,
    otherCoins: coinTotals(others),
    unreadable,
  };
}

/**
 * Does what the walk has established cover this window?
 *
 * The oldest row must be strictly older than the window's start: `endTime` is inclusive, so more rows of the oldest
 * row's own millisecond may still be a page away. A walk that ended at SoDEX's row limit proves only what it reached.
 */
export function coverOf(state: ScopeState, running: boolean, since: number | null, rows: number): Cover {
  const asOf = state.syncedAt ?? (state.complete && !state.lastError && state.updatedAt > 0 ? state.updatedAt : null);
  const from = state.coveredFrom ?? state.oldest;
  const reached = (state.complete && !state.limited) || (since !== null && from !== null && from < since);
  if (reached && asOf !== null) return { state: 'final', asOf };
  if (state.complete && state.limited) {
    const day = from === null ? 'a recent date' : new Date(from).toISOString().slice(0, 10);
    return { state: 'incomplete', reason: `SoDEX keeps only a wallet's latest ${VENUE_ROW_LIMIT.toLocaleString('en-US')} rows, and nothing before ${day} can be read.` };
  }
  if (running || state.updatedAt === 0 || !state.lastError) return { state: 'reading', rows, oldest: state.oldest };
  return { state: 'incomplete', reason: state.lastError };
}
