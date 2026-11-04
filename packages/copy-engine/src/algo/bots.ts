/**
 * Bots (the Bots page), pure: a grid's levels and what follows a fill on one, a volume maker's quotes, a bot's
 * book (volume, fees, PnL) and its series. The runtime and the page's preview call the same functions.
 *
 * WHAT A BOT COSTS. Every child is post-only (GTX), so every fill pays SoDEX's maker fee (1.2 bp at tier 0)
 * plus the bot builder fee (policy.ts BOT_FEE, 0.1 bp): 1.3 bp, $130 per $1M traded. A volume maker earns
 * back what the spread gives it and loses what the price takes from what it holds (adverse selection); a
 * grid earns one level's step per round trip. The only taker orders a bot ever sends are the reduce-only
 * close when it stops with `onStop: 'close'` and a minute of resting did not close it.
 */
import type { MarketInfo } from '../types.ts';
import { floorStep, minChildQty, snapDown, snapUp, type Quote } from './math.ts';
import type { BotBook, GridSpec, MmSpec, Side } from './types.ts';

/** One point of a bot's series every this often... */
export const BOT_SAMPLE_MS = 5 * 60_000;
/** ...and at most this many: past it, every other point of the older half goes (older history, coarser). */
export const BOT_SERIES_MAX = 1_500;

export const emptyBook = (): BotBook => ({ buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, makerValue: 0, takerValue: 0, tradeFees: 0, builderFees: 0, fills: 0, series: [] });

/** One fill into the book: `tradeRate` SoDEX's fee for that fill, `builderRate` ours, both fractions of the notional. */
export function bookFill(b: BotBook, side: Side, qty: number, value: number, maker: boolean, tradeRate: number, builderRate: number): void {
  if (!(qty > 0) || !(value > 0)) return;
  if (side === 'buy') {
    b.buyQty += qty;
    b.buyValue += value;
  } else {
    b.sellQty += qty;
    b.sellValue += value;
  }
  if (maker) b.makerValue += value;
  else b.takerValue += value;
  b.tradeFees += value * tradeRate;
  b.builderFees += value * builderRate;
  b.fills++;
}

export const bookVolume = (b: BotBook): number => b.buyValue + b.sellValue;
export const bookInventory = (b: BotBook): number => b.buyQty - b.sellQty;
/** Before fees, at the price `mark`. */
export const bookGross = (b: BotBook, mark: number): number => b.sellValue - b.buyValue + bookInventory(b) * mark;
/** After every fee. */
export const bookNet = (b: BotBook, mark: number): number => bookGross(b, mark) - b.tradeFees - b.builderFees;

/** What a million dollars of volume cost: -net PnL per $1M traded (negative = it earned). null under $1 traded. */
export function costPerMillion(b: BotBook, mark: number): number | null {
  const v = bookVolume(b);
  return v >= 1 ? (-bookNet(b, mark) / v) * 1_000_000 : null;
}

/** A point of the series, when one is due; thinned past BOT_SERIES_MAX. Returns whether it added one. */
export function sampleBook(b: BotBook, mark: number, now: number, force = false): boolean {
  const last = b.series[b.series.length - 1];
  if (!force && last && now - last[0] < BOT_SAMPLE_MS) return false;
  b.series.push([now, round2(bookVolume(b)), round4(bookNet(b, mark)), round4(b.tradeFees + b.builderFees)]);
  if (b.series.length > BOT_SERIES_MAX) {
    const half = Math.floor(b.series.length / 2);
    b.series = [...b.series.slice(0, half).filter((_, i) => i % 2 === 0), ...b.series.slice(half)];
  }
  return true;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/* ------------------------------------------------------------------ grid ----- */

/** A grid's level prices, low to high, each on the tick and distinct. */
export function gridPrices(s: Pick<GridSpec, 'low' | 'high' | 'levels' | 'spacing'>, tickSize: string): number[] {
  const n = s.levels;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const p = s.spacing === 'geometric' ? s.low * Math.pow(s.high / s.low, t) : s.low + (s.high - s.low) * t;
    const snapped = i === 0 ? snapUp(p, tickSize) : snapDown(p, tickSize);
    if (!out.length || snapped > out[out.length - 1]! + 1e-12) out.push(snapped);
  }
  return out;
}

/** One level of a running grid: the side it rests on, or null (the gap: nothing there). */
export type GridSide = Side | null;

/**
 * The first assignment at the price `ref`: buys on the levels below it, sells above, and the level nearest it
 * left empty - the gap a fill moves along.
 */
export function gridStart(prices: readonly number[], ref: number): GridSide[] {
  let gap = 0;
  for (let i = 1; i < prices.length; i++) if (Math.abs(prices[i]! - ref) < Math.abs(prices[gap]! - ref)) gap = i;
  return prices.map((_, i) => (i < gap ? 'buy' : i > gap ? 'sell' : null));
}

/**
 * A level filled whole: it becomes the gap, and the level on the far side of it takes the other side - a buy
 * filled at i puts a sell at i+1, a sell at i a buy at i-1. Past either end nothing is placed (the fill there
 * was the last of the range).
 */
export function gridAfterFill(sides: GridSide[], i: number, filled: Side): GridSide[] {
  const out = [...sides];
  out[i] = null;
  const j = filled === 'buy' ? i + 1 : i - 1;
  if (j >= 0 && j < out.length) out[j] = filled === 'buy' ? 'sell' : 'buy';
  return out;
}

/** Each level's size: `orderUsd` at its price, on the step, at least SoDEX's minimum. */
export function gridQty(orderUsd: number, price: number, m: MarketInfo): number {
  return Math.max(floorStep(orderUsd / price, m), minChildQty(m, price));
}

/** What one round trip on adjacent levels earns before fees, as a fraction (the step over the price). */
export function gridStepPct(prices: readonly number[]): number {
  if (prices.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < prices.length; i++) sum += (prices[i]! - prices[i - 1]!) / prices[i - 1]!;
  return sum / (prices.length - 1);
}

/* ------------------------------------------------------------- volume maker ----- */

export interface MmQuote {
  side: Side;
  price: number;
  quantity: number;
}

/**
 * The quotes a volume maker wants now, given what it holds (`inventory`, base units, signed) at the mark.
 *   - each side rests `offsetTicks` from its best price (-1 one tick inside where the spread has room), and at least
 *     `edgeBps` from both the mid and the mark (in a wide spread: one tick inside, never closer to fair than that);
 *   - the side that adds to what it holds steps back by skewTicks x |held| / cap (rounded), so the side
 *     that unwinds is the one at the touch;
 *   - a side that would take it past the cap is not quoted; the side that unwinds is sized up to what it
 *     holds when that is less than one order, so it can always reach flat;
 *   - a quote under SoDEX's minimum is raised to it;
 *   - with a queue guard, the side that adds is not quoted while its own best price's queue is thin (queueShare);
 *   - with `fair` (the Binance-led maker, spec.ref): the side that adds rests refBps from it (0: at the touch as above)
 *     and is not quoted within pullBps of it; the side that unwinds at a quarter of refBps, never through it.
 */
export function mmQuotes(s: Pick<MmSpec, 'orderUsd' | 'maxInventoryUsd' | 'offsetTicks' | 'skewTicks' | 'edgeBps' | 'queueGuard' | 'refBps' | 'pullBps'>, q: Quote, m: MarketInfo, inventory: number, mark: number, fair: number | null = null): MmQuote[] {
  const tick = Number(m.tickSize);
  const invUsd = inventory * mark;
  const ratio = Math.max(-1, Math.min(1, invUsd / s.maxInventoryUsd));
  const out: MmQuote[] = [];
  const room = Math.round((q.ask - q.bid) / tick);
  for (const side of ['buy', 'sell'] as const) {
    const adds = side === 'buy' ? inventory >= 0 : inventory <= 0;
    // The cap: an order on the adding side may not take what it holds past it.
    if (adds && Math.abs(invUsd) + s.orderUsd > s.maxInventoryUsd + 1e-9) continue;
    // The queue guard: a thin queue on its own side is about to be traded through - the fill would be the move against it.
    const share = queueShare(q, side);
    if (adds && (s.queueGuard ?? 0) > 0 && share !== null && share < s.queueGuard!) continue;
    const skew = adds ? Math.round(Math.abs(ratio) * s.skewTicks) : 0;
    const inside = s.offsetTicks < 0 && room >= 2 ? 1 : 0;
    const off = Math.max(0, s.offsetTicks) + skew;
    let price = side === 'buy' ? q.bid - off * tick + inside * tick : q.ask + off * tick - inside * tick;
    // At least edgeBps from the mid (edge: a round trip earns twice it); the skew still steps back from there.
    // Measured from the safer of the mid and the mark (the oracle-led fair price): a book that lags the market
    // cannot put a quote on the wrong side of where the price really is.
    const edge = s.edgeBps ?? 0;
    if (edge > 0) {
      const midP = (q.bid + q.ask) / 2;
      const markP = mark > 0 ? mark : midP;
      price = side === 'buy' ? Math.min(price, Math.min(midP, markP) * (1 - edge / 10_000) - skew * tick) : Math.max(price, Math.max(midP, markP) * (1 + edge / 10_000) + skew * tick);
    }
    if (fair !== null && fair > 0) {
      const at = refLine(side, fair, adds ? s.refBps ?? 0 : (s.refBps ?? 0) / 4);
      // refBps above 0: there, wherever the touch is (inside a wide spread, or behind a touch too close to fair).
      if ((s.refBps ?? 0) > 0) price = side === 'buy' ? at - skew * tick : at + skew * tick;
      // Never past the fair price's line: the side that adds not within pullBps of it (at the touch: not quoted
      // while the touch is that close), the side that unwinds not through it.
      const line = adds ? refLine(side, fair, s.pullBps ?? 0) : fair;
      if (adds && (s.refBps ?? 0) <= 0 && (side === 'buy' ? price > line + 1e-12 : price < line - 1e-12)) continue;
      price = side === 'buy' ? Math.min(price, line) : Math.max(price, line);
    }
    // Never at or through the other side: post-only would be refused.
    price = side === 'buy' ? Math.min(price, q.ask - tick) : Math.max(price, q.bid + tick);
    price = side === 'buy' ? snapDown(price, m.tickSize) : snapUp(price, m.tickSize);
    if (!(price > 0)) continue;
    let qty = floorStep(s.orderUsd / price, m);
    // The unwinding side: no more than it holds where that is less than an order (it ends flat, not the other way).
    if (!adds && Math.abs(inventory) > 0 && Math.abs(inventory) < qty) qty = floorStep(Math.abs(inventory), m);
    qty = Math.max(qty, minChildQty(m, price));
    out.push({ side, price, quantity: qty });
  }
  return out;
}

/** `bps` from the fair price on `side`'s side of it: below it for a bid, above for an ask. */
export const refLine = (side: Side, fair: number, bps: number): number => (side === 'buy' ? fair * (1 - bps / 10_000) : fair * (1 + bps / 10_000));

/**
 * Whether a resting quote is past where the fair price allows it (the Binance-led maker's fast pull): a bid above
 * fair - pullBps (the side that adds) or above fair (the side that unwinds), an ask the same way up.
 */
export function pastFair(side: Side, price: number, fair: number, adds: boolean, pullBps: number): boolean {
  const line = refLine(side, fair, adds ? pullBps : 0);
  return side === 'buy' ? price > line + 1e-12 : price < line - 1e-12;
}

/** What rests at `side`'s best price, as a share of both best prices (null: the feed gives no sizes). */
export function queueShare(q: Quote, side: Side): number | null {
  const own = side === 'buy' ? q.bidSz : q.askSz;
  const other = side === 'buy' ? q.askSz : q.bidSz;
  if (own === undefined || other === undefined || !(own + other > 0)) return null;
  return own / (own + other);
}

/* ------------------------------------------------------------------ cost ----- */

export interface BotCostModel {
  /** SoDEX's fee for a resting fill, and ours: fractions of the notional. */
  makerFee: number;
  builderFee: number;
}

/** What $1M of maker volume costs in fees alone (USD): SoDEX's and ours. */
export const feesPerMillion = (c: BotCostModel): { trade: number; builder: number; total: number } => ({
  trade: c.makerFee * 1_000_000,
  builder: c.builderFee * 1_000_000,
  total: (c.makerFee + c.builderFee) * 1_000_000,
});
