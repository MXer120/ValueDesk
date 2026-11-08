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
import type { BotBook, GridSpec, MmSpec, NewsEvent, NewsGate, QuietWindow, Side } from './types.ts';

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
export const bookInventory = (b: BotBook): number => b.buyQty - b.sellQty + (b.carryQty ?? 0);
/** Before fees, at the price `mark`. */
export const bookGross = (b: BotBook, mark: number): number => b.sellValue - b.buyValue - (b.carryValue ?? 0) + bookInventory(b) * mark;
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

/* ------------------------------------------------- volume maker: gates and quiet windows ----- */

/**
 * The patient taker: SoDEX account 1002, the taker whose fills cost a maker little (it takes resting size and does not
 * run the price on; measured live 2026-11-04/05, docs/BOTS-LIVE-RUNS.md). While it is away or quiet on a market, the
 * flow left is mostly the takers that pick makers off, so MmSpec.flowGate pauses or shrinks the quotes there.
 */
export const PATIENT_TAKER_ACCOUNT = 1002;

const ZONES: Readonly<Record<QuietWindow['zone'], string>> = { utc: 'UTC', new_york: 'America/New_York', london: 'Europe/London' };
const ZONE_WORDS: Readonly<Record<QuietWindow['zone'], string>> = { utc: 'UTC', new_york: 'New York', london: 'London' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * The local time in a zone at `at` (ms): minutes since midnight, the weekday (0 Sunday .. 6 Saturday) and the date
 * ('YYYY-MM-DD'), DST included.
 */
export function zoneTime(at: number, zone: QuietWindow['zone']): { minutes: number; weekday: number; date: string } {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[zone], hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(zone, f);
  }
  let h = 0;
  let m = 0;
  let wd = 0;
  let y = '1970';
  let mo = '01';
  let dd = '01';
  for (const p of f.formatToParts(new Date(at))) {
    if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') m = Number(p.value);
    else if (p.type === 'weekday') wd = Math.max(0, DAYS.indexOf(p.value));
    else if (p.type === 'year') y = p.value;
    else if (p.type === 'month') mo = p.value;
    else if (p.type === 'day') dd = p.value;
  }
  return { minutes: h * 60 + m, weekday: wd, date: `${y}-${mo}-${dd}` };
}

/* Exchange holidays, by rule (so no table runs out): NYSE, and the London Stock Exchange (England's bank holidays). */
const ymd = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const shiftDay = (y: number, m: number, d: number, by: number): string => {
  const t = new Date(Date.UTC(y, m - 1, d + by));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
/** The n-th (1-based; -1 the last) weekday `wd` of a month. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) return ymd(y, m, 1 + ((wd - dow(y, m, 1) + 7) % 7) + (n - 1) * 7);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ymd(y, m, days - ((dow(y, m, days) - wd + 7) % 7));
}
/** Easter Sunday (Gregorian): [month, day]. */
function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}
/** A US fixed holiday as NYSE observes it: Saturday to Friday, Sunday to Monday. */
const usObserved = (y: number, m: number, d: number): string => {
  const w = dow(y, m, d);
  return w === 6 ? shiftDay(y, m, d, -1) : w === 0 ? shiftDay(y, m, d, 1) : ymd(y, m, d);
};
const holidayCache = new Map<string, Set<string>>();
/** NYSE's full-day closures in a year (a Saturday New Year is not moved back into December, as NYSE does). */
export function nyseHolidays(y: number): Set<string> {
  const key = `ny${y}`;
  const hit = holidayCache.get(key);
  if (hit) return hit;
  const [em, ed] = easter(y);
  const s = new Set([
    dow(y, 1, 1) === 6 ? '' : usObserved(y, 1, 1),
    nthWeekday(y, 1, 1, 3),
    nthWeekday(y, 2, 1, 3),
    shiftDay(y, em, ed, -2),
    nthWeekday(y, 5, 1, -1),
    ...(y >= 2022 ? [usObserved(y, 6, 19)] : []),
    usObserved(y, 7, 4),
    nthWeekday(y, 9, 1, 1),
    nthWeekday(y, 11, 4, 4),
    usObserved(y, 12, 25),
  ].filter(Boolean));
  holidayCache.set(key, s);
  return s;
}
/** The London Stock Exchange's closures in a year: England's bank holidays, weekend ones moved to the next weekday. */
export function lseHolidays(y: number): Set<string> {
  const key = `ldn${y}`;
  const hit = holidayCache.get(key);
  if (hit) return hit;
  const [em, ed] = easter(y);
  const ny = dow(y, 1, 1);
  const xmas = dow(y, 12, 25);
  const xs = xmas === 6 ? [ymd(y, 12, 27), ymd(y, 12, 28)] : xmas === 0 ? [ymd(y, 12, 26), ymd(y, 12, 27)] : xmas === 5 ? [ymd(y, 12, 25), ymd(y, 12, 28)] : [ymd(y, 12, 25), ymd(y, 12, 26)];
  const s = new Set([
    ny === 6 ? ymd(y, 1, 3) : ny === 0 ? ymd(y, 1, 2) : ymd(y, 1, 1),
    shiftDay(y, em, ed, -2),
    shiftDay(y, em, ed, 1),
    nthWeekday(y, 5, 1, 1),
    nthWeekday(y, 5, 1, -1),
    nthWeekday(y, 8, 1, -1),
    ...xs,
  ]);
  holidayCache.set(key, s);
  return s;
}
/** Whether a zone's exchange trades on a local date (a weekday, no holiday). UTC: Monday to Friday. */
export function tradingDay(zone: QuietWindow['zone'], date: string, weekday: number): boolean {
  if (weekday === 0 || weekday === 6) return false;
  const y = Number(date.slice(0, 4));
  if (zone === 'new_york') return !nyseHolidays(y).has(date);
  if (zone === 'london') return !lseHolidays(y).has(date);
  return true;
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The quiet window `at` is inside (the first of them), or null. One past midnight counts by the day it began. */
export function quietWindowAt(windows: readonly QuietWindow[] | undefined, at: number): QuietWindow | null {
  for (const w of windows ?? []) {
    const { minutes, weekday, date } = zoneTime(at, w.zone);
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    // The day the window began: today, or (past midnight, before `to`) yesterday.
    const dayOk = (back: boolean): boolean => {
      if (w.days === 'all') return true;
      const d = back ? (weekday + 6) % 7 : weekday;
      if (w.days === 'weekdays') return d >= 1 && d <= 5;
      return tradingDay(w.zone, back ? zoneTime(at - 86_400_000, w.zone).date : date, d);
    };
    const inside = from < to ? minutes >= from && minutes < to && dayOk(false) : (minutes >= from && dayOk(false)) || (minutes < to && dayOk(true));
    if (inside) return w;
  }
  return null;
}

/** The release a news gate holds for at `at` (of its level or above, timed, not all-day), or null. */
export function newsAt(gate: NewsGate | undefined, events: readonly NewsEvent[], at: number): NewsEvent | null {
  if (!gate) return null;
  for (const ev of events) {
    if (ev.allDay || ev.importance === 'low' || (gate.level === 'high' && ev.importance !== 'high')) continue;
    if (at >= ev.time - gate.beforeMin * 60_000 && at < ev.time + gate.afterMin * 60_000) return ev;
  }
  return null;
}

/** '09:20–09:45 New York'. */
export const quietWords = (w: QuietWindow): string => `${w.from}–${w.to} ${ZONE_WORDS[w.zone]}`;

/** '$950', '$12.5k', '$3.2M'. */
export function usdWords(x: number): string {
  const a = Math.abs(x);
  const cut = (n: number, d: number) => n.toFixed(d).replace(/\.0+$/, '');
  if (a < 1_000) return `$${Math.round(x)}`;
  if (a < 1_000_000) return `$${cut(x / 1_000, a < 10_000 ? 1 : 0)}k`;
  return `$${cut(x / 1_000_000, a < 10_000_000 ? 1 : 0)}M`;
}

/** '10 min', '1 h', '90 min'. */
export const windowWords = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`;
};
