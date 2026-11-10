/**
 * GET /api/vs/bots/markets (docs/BOTS-UI.md): for every SoDEX perp, what a NEW small market-making bot would pay per
 * $1M all-in, from public prints only (the trade flow, store.ts: every print names buyer, seller and which side took).
 *
 * THE ESTIMATE. A new small bot rests in the book like the market's other small makers, so it is filled like them:
 *
 *   estCostBps = makerBps + builderBps - smallMakers.markout30Bps
 *
 * - Maker = the passive side: a print whose taker bought was sold by its maker (maker side -1), one whose taker sold was
 *   bought by its maker (+1). Prints that do not say who took, and self-trades, are left out.
 * - markout30 of a maker fill = side x (mid30 - px) / px x 1e4, positive = the maker earned (half spread minus what the
 *   market ran against it in 30 s). Volume-weighted (notional px x sz) everywhere.
 * - THE MID. There is no book on the server (no bookTickers are sampled anywhere; /api/md only proxies), so the mid is a
 *   proxy from prints: (last taker-buy price + last taker-sell price) / 2 when both are under 10 s apart (the last buy
 *   lifted the ask, the last sell hit the bid), else the last print. It is held per second (carried forward over
 *   seconds without prints). mid30 = median of that per-second mid over the seconds t+25 s .. t+35 s: the brief's "median
 *   of the prints around t+30 s, else the last print before", with the bid/ask bounce averaged out by the proxy too.
 * - smallMakers = every maker account EXCEPT those with >= 10 % of the market's maker volume in the window (that takes
 *   out 23342 on BTC/ETH and any other dominant maker). When EVERY maker is dominant (a market with < 10 makers) there
 *   are no small makers: the markout then falls back to all makers' (fills = 0, so confidence says low).
 * - Range (estCostLow/High): the same estimate per UTC hour of the window, its volume-weighted 10th / 90th percentile
 *   (weights = the hour's small-maker volume): what an hour-to-hour run actually sees.
 * - gateCostBps: the estimate over the small-maker fills whose preceding minute was still: the path (sum of |per-second
 *   mid moves| in bp over the 60 s before the fill) under 12 bp, as the bots' stillBps gate (copy-engine runtime.ts
 *   refPath) quotes. The bots gate on a reference price (Binance); here the SoDEX mid proxy stands in. null under 300.
 * - spreadBps: no sampled quotes exist, so from prints: the median gap between consecutive prints of opposite taker side
 *   within 2 s (|px - prev px| / px in bp): one lifted the ask, the next hit the bid.
 * - volBpsH: sum of |1-minute moves| of the per-second mid (sampled at each minute's end) per hour, in bp.
 * - Per hour figures divide by the window's hours since the market's first print in the loaded 7 d (a market or the
 *   recorder younger than the window is not diluted). Recorder downtime inside the window is not taken out.
 * - Weekday / weekend (UTC Sat + Sun) and the 24-hour UTC profile always come from the 7 d window, with the 7 d dominant
 *   set; hourly costBps is null under 50 fills in that hour of day, volumeUsdH there is all prints (as the top level).
 *
 * THE API THREAD: one pass over 7 d of every SoDEX perp's chunks yields both windows; the loop is given back every
 * YIELD_MS (as flow/read.ts), the decoded prints are not put in read.ts's LRU (one market at a time, then dropped).
 * Answers are kept 5 min; a stale answer is served while a new one is computed, and while someone asked in the last
 * 30 min it is kept warm every 5 min (keepBotMarketsWarm, as Explore and the screener).
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CHUNK_MS, DAY_MS, HOUR_MS, TAKER_BUYER, TAKER_SELLER, decodeChunk, type PrintCols } from './codec.js';
import { flowReader, type FlowStore } from './store.js';
import { flowHoles, kindOf } from './read.js';
import { coinOf } from '../valuedesk/cohorts/model.js';
import { symbols as sodexSymbols, type Symbol as SodexSymbol } from '../sodex/symbols.js';
import { findSymbol } from '../sodex/symbolRef.js';
import { shareUnder, startSampling, stopSampling, typicalBps } from './bookSpread.js';

export type BotWindow = '1h' | '6h' | '24h' | '7d';
export const BOT_WINDOWS: readonly BotWindow[] = ['1h', '6h', '24h', '7d'];
/** Each window's length (h). */
export const WINDOW_H: Record<BotWindow, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

export interface BotMarket {
  symbol: string;
  base: string;
  tick: number; tickBps: number;
  price: number;
  volumeUsdH: number;
  spreadBps: number;
  volBpsH: number;
  takers: { t1002: number; t23342: number; other: number };
  smallMakers: { count: number; volumeUsdH: number; fills: number; markout30Bps: number; on1002Bps: number | null; on23342Bps: number | null };
  estCostBps: number;
  estCostLowBps: number; estCostHighBps: number;
  gateCostBps: number | null;
  /** The share of small makers' volume the market gate keeps (null with gateCostBps). */
  gateShare?: number | null;
  /**
   * The flow gate: the estimate over the small-maker fills while uninformed flow (1002) traded at least minUsd here
   * over the 10 minutes before, and the share of volume that keeps. costBps null under GATE_MIN_FILLS.
   */
  flowGate?: Array<{ minUsd: number; costBps: number | null; share: number }>;
  /** The spread limit: the same over the fills while the last measured spread was at most maxBps. */
  spreadGate?: Array<{ maxBps: number; costBps: number | null; share: number }>;
  /** Where spreadBps and the spread gate's shares come from: SoDEX's book (sampled, bookSpread.ts) or the prints. */
  spreadFrom?: 'book' | 'prints';
  capacityUsdH: number;
  confidence: 'high' | 'medium' | 'low';
  weekdayCostBps: number | null; weekendCostBps: number | null;
  hourly: Array<{ h: number; costBps: number | null; volumeUsdH: number }>;
  /**
   * The price the Binance-led maker (R10) quotes off: 'binance' when Binance lists the coin's USDT perpetual, null
   * when it does not (that market gets the plain maker, quoting off SoDEX's own book), absent when Binance's list
   * could not be read.
   */
  lead?: 'binance' | null;
}

/** SoDEX market -> the Binance USD-M symbol the executor's feed reads (executor feed/reference.ts binanceSymbolOf). */
export const binanceSymbolOf = (market: string): string | null => {
  const m = /^([A-Z0-9]+)-USD$/.exec(market);
  return m ? `${m[1]}USDT` : null;
};

const LEAD_TTL = 6 * 3_600_000;
let leadSet: { at: number; symbols: Set<string> } | null = null;
let leadRun: Promise<void> | null = null;

/** Binance's USD-M symbols (one small public list, about 40 KB), read at most every 6 h; null until read once. */
async function binanceSymbols(): Promise<Set<string> | null> {
  if (!leadSet || Date.now() - leadSet.at > LEAD_TTL) {
    leadRun ??= (async () => {
      try {
        const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/price', { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) return;
        const rows = (await r.json()) as Array<{ symbol?: unknown }>;
        const symbols = new Set(rows.map((x) => String(x.symbol ?? '')).filter(Boolean));
        if (symbols.size > 50) leadSet = { at: Date.now(), symbols };
      } catch {
        /* the last list stands; none yet: lead stays unknown */
      } finally {
        leadRun = null;
      }
    })();
    if (!leadSet) await leadRun;
  }
  return leadSet?.symbols ?? null;
}

export interface BotMarketsResponse {
  at: number;
  window: BotWindow;
  fee: { makerBps: number; builderBps: number };
  markets: BotMarket[];
}

/** SoDEX's default maker fee in bp, when its symbols list cannot be read. */
export const DEFAULT_MAKER_BPS = 1.2;
/** Our bot's builder fee: executor BOT_FEE = 1 tenth of a bp. */
export const BOT_BUILDER_BPS = 0.1;
export const DOMINANT_SHARE = 0.1;
/**
 * A maker counts as one like our bot only if it fills often: at least this many fills a day in the window. A limit
 * order a person left far from the price fills only when a sweep runs through it, which is the worst fill there is;
 * a bot quoting at the touch fills all day. Without this the estimate read BTC 0.3-0.4 bp dearer than our own live
 * runs measured (owner check 2026-11-07); with it the two agree (see the calibration in docs/BOTS-UI.md).
 */
export const BOTLIKE_FILLS_PER_DAY = 40;
export const GATE_PATH_BPS = 12;
export const GATE_MIN_FILLS = 300;
export const SPLIT_MIN_FILLS = 300;
export const HOURLY_MIN_FILLS = 50;
const MID30_FROM = 25_000;
const MID30_TO = 35_000;
const PAIR_MS = 10_000;
const SPREAD_PAIR_MS = 2_000;
const GATE_S = 60;
/** The flow gate's thresholds (1002's USD over FLOW_MS) and the spread limit's (bp), as the bot settings offer them. */
export const FLOW_GATE_USD = [100_000, 250_000, 500_000, 1_000_000] as const;
export const SPREAD_GATE_BPS = [5, 10, 20] as const;
const FLOW_MS = 10 * 60_000;
const SPREAD_SAMPLES = 50_000;
const YIELD_MS = 8;
export const BOT_MARKETS_TTL = 5 * 60_000;
/**
 * An answer older than this is never served: the asker waits for the fresh one (~25 s on production). 2026-11-10: the
 * board was kept warm only while someone had asked in the last 30 min, so after a quiet night the first visitor got the
 * 00:12 answer at 09:00 and the web's next poll came 5 min later ("the most recent data point is from yesterday").
 */
export const BOT_MARKETS_MAX_AGE = 15 * 60_000;
/** Kept warm this often when nobody has asked for 30 min (so the first visitor's answer is at most this old). */
export const BOT_MARKETS_IDLE_EVERY = 10 * 60_000;
const W7 = 7 * DAY_MS;
const W24 = DAY_MS;

// --- the pure part (tests) --------------------------------------------------------------------------

/** Gives the loop back once YIELD_MS has gone by (call it often, it is cheap). */
export function yielder(ms = YIELD_MS): () => Promise<void> | undefined {
  let at = Date.now();
  return () => {
    if (Date.now() - at <= ms) return undefined;
    return nextTurn().then(() => { at = Date.now(); });
  };
}

export interface AnalyzeOpts {
  /** The end of both windows (ms). */
  now: number;
  makerBps: number;
  builderBps: number;
  /** flow_party ids of SoDEX accounts 1002 and 23342 (null: not seen). */
  id1002: number | null;
  id23342: number | null;
  /** Calibration only (BOTS_MARKETS_WATCH): flow_party ids whose own cost is reported next to the estimate. */
  watch?: number[];
  /**
   * Spans the flow does not hold whole (read.ts flowHoles: the coverage ledger's short slots), sorted and disjoint. Their
   * prints are left out of every figure and their time out of every per-hour divisor, so a recorder outage (SoDEX lost
   * 21-87% of its prints a day from 2026-10-31 to 11-06) neither lowers the volume nor skews who takes. Absent: all held.
   */
  holes?: ReadonlyArray<readonly [number, number]>;
}

/** Whether t falls in one of the sorted, disjoint spans (binary search). */
export function inSpans(spans: ReadonlyArray<readonly [number, number]>, t: number): boolean {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const s = spans[m]!;
    if (t < s[0]) hi = m - 1;
    else if (t >= s[1]) lo = m + 1;
    else return true;
  }
  return false;
}

/** How much of [a, b) the sorted, disjoint spans cover (ms). */
export function overlapMs(spans: ReadonlyArray<readonly [number, number]>, a: number, b: number): number {
  let x = 0;
  for (const [s, e] of spans) {
    if (e <= a) continue;
    if (s >= b) break;
    x += Math.min(e, b) - Math.max(s, a);
  }
  return x;
}

/** Eligible maker fills of one market, column per field, time order. */
interface Fills {
  n: number;
  t: Float64Array;
  ntl: Float64Array;
  mk: Float64Array;
  maker: Uint32Array;
  /** 0 taken by 1002, 1 by 23342, 2 anyone else. */
  cls: Uint8Array;
  path: Float64Array;
}

export interface WindowStats {
  volumeUsdH: number;
  /** Hours of the window the flow holds for this market (since its first print, less unrecorded spans): the market map
   * shows the rest of the window as not recorded. */
  heldH: number;
  spreadBps: number;
  volBpsH: number;
  takers: BotMarket['takers'];
  smallMakers: BotMarket['smallMakers'];
  estCostBps: number;
  estCostLowBps: number;
  estCostHighBps: number;
  gateCostBps: number | null;
  gateShare: number | null;
  flowGate: NonNullable<BotMarket['flowGate']>;
  spreadGate: NonNullable<BotMarket['spreadGate']>;
  capacityUsdH: number;
  confidence: BotMarket['confidence'];
  /** Calibration only: each watched maker's own fills and cost, on the same measure. */
  watched?: Array<{ id: number; fills: number; costBps: number }>;
}

/**
 * One UTC hour of a market for the regime board (Explore, owner 2026-11-09: "a market board made out of 1002 share and
 * volatility"): all prints whose taker is known (USD), of it taken by 1002 and by 23342, and the volatility as in
 * volBpsH (|moves| of the mid sampled at each minute's end, bp, over the hour). Hours the flow does not hold whole are
 * left out (null volume).
 */
export interface RegimeHour { t: number; volumeUsd: number | null; t1002Usd: number; t23342Usd: number; volBps: number }

/**
 * A market's last 7 d minute by minute (the regime board's raw form; buckets are cut from it per window): traded
 * volume with a known taker, of it 1002's and 23342's, |move| of the mid over the minute (bp), and whether the flow
 * holds the minute whole. Index 0 is the minute starting at m0 * 60 000.
 */
export interface MinuteSeries { m0: number; tot: Float32Array; u: Float32Array; f: Float32Array; vol: Float32Array; held: Uint8Array }

/** The board's windows and the bucket each is cut into. */
export const REGIME_STEP_MIN: Record<BotWindow, number> = { '1h': 5, '6h': 5, '24h': 15, '7d': 60 };

export interface MarketAnalysis {
  price: number;
  w1: WindowStats;
  w6: WindowStats;
  /** The 7 d window minute by minute (the regime board). */
  series: MinuteSeries;
  w24: WindowStats;
  w7: WindowStats;
  weekdayCostBps: number | null;
  weekendCostBps: number | null;
  hourly: BotMarket['hourly'];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Median of a small array, in place (insertion sort: 11 values). */
function smallMedian(a: Float64Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) { a[j + 1] = a[j]!; j--; }
    a[j + 1] = v;
  }
  return n % 2 ? a[(n - 1) >> 1]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
}

/** Volume-weighted percentile of (value, weight) pairs. */
export function weightedPercentile(vals: readonly number[], weights: readonly number[], p: number): number {
  const idx = vals.map((_, i) => i).filter((i) => weights[i]! > 0).sort((a, b) => vals[a]! - vals[b]!);
  if (!idx.length) return NaN;
  const total = idx.reduce((s, i) => s + weights[i]!, 0);
  let cum = 0;
  for (const i of idx) {
    cum += weights[i]!;
    if (cum >= p * total - 1e-12) return vals[i]!;
  }
  return vals[idx[idx.length - 1]!]!;
}

/** UTC weekday of a ms time: 0 Sunday .. 6 Saturday (1970-01-01 was a Thursday). */
const dowOf = (t: number): number => (Math.floor(t / DAY_MS) + 4) % 7;

/**
 * Both windows of one market from its prints over the last 7 d (time order; more before `now - 7 d` is ignored).
 * Prints from `now - 7 d - 60 s` help the first fills' gate path.
 */
export async function analyzeMarket(p: PrintCols, o: AnalyzeOpts, yieldNow: () => Promise<void> | undefined = yielder()): Promise<MarketAnalysis | null> {
  const from7 = o.now - W7;
  const from24 = o.now - W24;
  const from6 = o.now - 6 * HOUR_MS;
  const from1 = o.now - HOUR_MS;
  const fee = o.makerBps + o.builderBps;
  const holes = o.holes ?? [];
  const held = (t: number): boolean => !holes.length || !inSpans(holes, t);
  // First print inside the 7 d window.
  let i0 = 0;
  while (i0 < p.n && p.t[i0]! < from7 - GATE_S * 1000) i0++;
  let first = i0;
  while (first < p.n && p.t[first]! < from7) first++;
  if (first >= p.n) return null;
  const firstT = p.t[first]!;
  const lastI = p.n - 1;

  // The per-second mid (carried forward; before the first print, the first mid).
  const s0 = Math.floor(p.t[i0]! / 1000);
  const sEnd = Math.floor(o.now / 1000) + 1;
  const ns = Math.max(1, sEnd - s0 + 1);
  const mid = new Float64Array(ns).fill(NaN);
  let lastBuy = NaN, lastBuyT = -Infinity, lastSell = NaN, lastSellT = -Infinity;
  // Spread samples (consecutive prints of opposite taker side within 2 s), and all-print volume per window and hour.
  const gapT: number[] = [];
  const gapV: number[] = [];
  let vol24 = 0, vol7 = 0, vol6 = 0, vol1 = 0;
  const volByHod = new Float64Array(24);
  const m0 = Math.floor(from7 / 60_000);
  const nm = Math.max(1, Math.floor((o.now - 1) / 60_000) - m0 + 1);
  const mTot = new Float32Array(nm), m1002 = new Float32Array(nm), m23342 = new Float32Array(nm);
  let prevTaker = 0, prevPx = NaN, prevT = -Infinity;
  for (let i = i0; i < p.n; i++) {
    if ((i & 4095) === 0) await yieldNow();
    const t = p.t[i]!, px = p.px[i]!, tk = p.taker[i]!;
    if (tk === TAKER_BUYER) { lastBuy = px; lastBuyT = t; }
    else if (tk === TAKER_SELLER) { lastSell = px; lastSellT = t; }
    const m = Math.abs(lastBuyT - lastSellT) < PAIR_MS ? (lastBuy + lastSell) / 2 : px;
    const s = Math.floor(t / 1000) - s0;
    if (s >= 0 && s < ns) mid[s] = m;
    if (t >= from7 && t < o.now && held(t)) {
      const ntl = px * p.sz[i]!;
      vol7 += ntl;
      if (t >= from24) vol24 += ntl;
      if (t >= from6) vol6 += ntl;
      if (t >= from1) vol1 += ntl;
      { const k = Math.floor(t / HOUR_MS) % 24; volByHod[k] = volByHod[k]! + ntl; }
      if (tk === TAKER_BUYER || tk === TAKER_SELLER) {
        const mi = Math.floor(t / 60_000) - m0;
        if (mi >= 0 && mi < nm) {
          mTot[mi] = mTot[mi]! + ntl;
          const who = tk === TAKER_BUYER ? p.buyer[i]! : p.seller[i]!;
          if (who === o.id1002) m1002[mi] = m1002[mi]! + ntl;
          else if (who === o.id23342) m23342[mi] = m23342[mi]! + ntl;
        }
      }
      if (tk && prevTaker && tk !== prevTaker && t - prevT <= SPREAD_PAIR_MS && px > 0) {
        gapT.push(t);
        gapV.push((Math.abs(px - prevPx) / px) * 1e4);
      }
    }
    if (tk) { prevTaker = tk; prevPx = px; prevT = t; }
  }
  let carry = NaN;
  for (let s = 0; s < ns; s++) if (!Number.isNaN(mid[s]!)) { carry = mid[s]!; break; }
  for (let s = 0; s < ns; s++) {
    if (Number.isNaN(mid[s]!)) mid[s] = carry; else carry = mid[s]!;
  }
  // Prefix sums of |per-second moves| in bp: the path of any span of seconds in O(1).
  const pre = new Float64Array(ns);
  for (let s = 1; s < ns; s++) pre[s] = pre[s - 1]! + (mid[s - 1]! > 0 ? (Math.abs(mid[s]! - mid[s - 1]!) / mid[s - 1]!) * 1e4 : 0);
  await yieldNow();

  // Maker fills whose t+35 s has been seen (the recorder flushes every FLUSH_MS; a minute of slack).
  const cut = o.now - 60_000 - MID30_TO;
  const cap = p.n - first;
  const f: Fills = { n: 0, t: new Float64Array(cap), ntl: new Float64Array(cap), mk: new Float64Array(cap), maker: new Uint32Array(cap), cls: new Uint8Array(cap), path: new Float64Array(cap) };
  const win = new Float64Array(16);
  for (let i = first; i < p.n; i++) {
    if ((i & 4095) === 0) await yieldNow();
    const t = p.t[i]!;
    if (t > cut) break;
    if (!held(t)) continue;
    const tk = p.taker[i]!;
    if (tk !== TAKER_BUYER && tk !== TAKER_SELLER) continue;
    const buyer = p.buyer[i]!, seller = p.seller[i]!;
    if (buyer === seller) continue;
    const side = tk === TAKER_BUYER ? -1 : 1;
    const maker = tk === TAKER_BUYER ? seller : buyer;
    const taker = tk === TAKER_BUYER ? buyer : seller;
    const px = p.px[i]!;
    if (!(px > 0)) continue;
    const a = Math.floor((t + MID30_FROM) / 1000) - s0;
    const b = Math.min(ns - 1, Math.floor((t + MID30_TO) / 1000) - s0);
    let k = 0;
    for (let s = a; s <= b && k < win.length; s++) win[k++] = mid[s]!;
    if (!k) continue;
    const m30 = smallMedian(win, k);
    const sNow = Math.floor(t / 1000) - s0 - 1;
    const path = sNow > 0 ? pre[sNow]! - pre[Math.max(0, sNow - GATE_S)]! : 0;
    const j = f.n++;
    f.t[j] = t;
    f.ntl[j] = px * p.sz[i]!;
    f.mk[j] = side * ((m30 - px) / px) * 1e4;
    f.maker[j] = maker;
    f.cls[j] = taker === o.id1002 ? 0 : taker === o.id23342 ? 1 : 2;
    f.path[j] = path;
  }

  // Per fill: 1002's taker USD over the 10 minutes before (the flow gate) and the last measured spread (the limit).
  const u10 = new Float64Array(f.n);
  const sprAt = new Float64Array(f.n);
  {
    let lo = 0, sum = 0, g = 0;
    for (let j = 0; j < f.n; j++) {
      if ((j & 4095) === 0) await yieldNow();
      while (lo < j && f.t[lo]! <= f.t[j]! - FLOW_MS) { if (f.cls[lo] === 0) sum -= f.ntl[lo]!; lo++; }
      u10[j] = sum;
      if (f.cls[j] === 0) sum += f.ntl[j]!;
      while (g < gapT.length && gapT[g]! <= f.t[j]!) g++;
      // The median of the last three readings in the minute before: one opposite-side pair alone is noisy.
      if (g > 0 && f.t[j]! - gapT[g - 1]! < 60_000) {
        const x = gapV[g - 1]!, y = g > 1 ? gapV[g - 2]! : x, z = g > 2 ? gapV[g - 3]! : y;
        sprAt[j] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
      } else sprAt[j] = 0; // no reading in the minute before: the limit has nothing to pause on, as the bot (it sees the book).
    }
  }
  // The window's hours since the first print, less the time the flow does not hold whole.
  const spanH = (from: number): number => { const a = Math.max(from, firstT); return Math.max(1 / 60, (o.now - a - overlapMs(holes, a, o.now)) / HOUR_MS); };
  const spreadOf = (from: number): number => {
    let lo = 0;
    while (lo < gapT.length && gapT[lo]! < from) lo++;
    const n = gapT.length - lo;
    if (!n) return 0;
    const step = Math.max(1, Math.floor(n / SPREAD_SAMPLES));
    const a: number[] = [];
    for (let i = lo; i < gapT.length; i += step) a.push(gapV[i]!);
    a.sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) >> 1]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
  };
  const volOf = (from: number): number => {
    // |moves| of the mid sampled at each minute's end, from the market's first minute in the window.
    const start = Math.max(from, firstT);
    let sum = 0;
    let prev = NaN;
    for (let t = Math.floor(start / 60_000) * 60_000 + 59_999; t < o.now; t += 60_000) {
      const s = Math.floor(t / 1000) - s0;
      if (s < 0 || s >= ns) continue;
      const m = mid[s]!;
      if (prev > 0) sum += (Math.abs(m - prev) / prev) * 1e4;
      prev = m;
    }
    return sum / spanH(from);
  };

  const stats = async (from: number, volume: number): Promise<{ st: WindowStats; small: (j: number) => boolean }> => {
    const hours = spanH(from);
    const byMaker = new Map<number, number>();
    const fillsBy = new Map<number, number>();
    let lo = 0;
    while (lo < f.n && f.t[lo]! < from) lo++;
    let total = 0, allMk = 0;
    const takerVol = [0, 0, 0];
    for (let j = lo; j < f.n; j++) {
      if ((j & 4095) === 0) await yieldNow();
      const v = f.ntl[j]!;
      total += v;
      allMk += v * f.mk[j]!;
      takerVol[f.cls[j]!]! += v;
      byMaker.set(f.maker[j]!, (byMaker.get(f.maker[j]!) ?? 0) + v);
      fillsBy.set(f.maker[j]!, (fillsBy.get(f.maker[j]!) ?? 0) + 1);
    }
    const dominant = new Set<number>();
    for (const [id, v] of byMaker) if (total > 0 && v / total >= DOMINANT_SHARE) dominant.add(id);
    const minFills = Math.max(5, Math.round(BOTLIKE_FILLS_PER_DAY * Math.min(7, hours / 24)));
    const small = (j: number): boolean => !dominant.has(f.maker[j]!) && (fillsBy.get(f.maker[j]!) ?? 0) >= minFills;
    const perMaker = new Map<number, { v: number; mk: number; n: number }>();
    const makers = new Set<number>();
    let sv = 0, smk = 0, sn = 0, gv = 0, gmk = 0, gn = 0;
    const fg = FLOW_GATE_USD.map(() => ({ v: 0, mk: 0, n: 0 }));
    const sg = SPREAD_GATE_BPS.map(() => ({ v: 0, mk: 0, n: 0 }));
    const cv = [0, 0, 0], cmk = [0, 0, 0];
    const hourV = new Map<number, number>();
    const hourMk = new Map<number, number>();
    for (let j = lo; j < f.n; j++) {
      if ((j & 4095) === 0) await yieldNow();
      if (!small(j)) continue;
      const v = f.ntl[j]!, mk = f.mk[j]!;
      makers.add(f.maker[j]!);
      sv += v; smk += v * mk; sn++;
      if (o.watch?.includes(f.maker[j]!)) { const w = perMaker.get(f.maker[j]!) ?? { v: 0, mk: 0, n: 0 }; w.v += v; w.mk += v * mk; w.n++; perMaker.set(f.maker[j]!, w); }
      cv[f.cls[j]!]! += v; cmk[f.cls[j]!]! += v * mk;
      const h = Math.floor(f.t[j]! / HOUR_MS);
      hourV.set(h, (hourV.get(h) ?? 0) + v);
      hourMk.set(h, (hourMk.get(h) ?? 0) + v * mk);
      if (f.path[j]! < GATE_PATH_BPS) { gv += v; gmk += v * mk; gn++; }
      for (let k = 0; k < FLOW_GATE_USD.length; k++) if (u10[j]! >= FLOW_GATE_USD[k]!) { const x = fg[k]!; x.v += v; x.mk += v * mk; x.n++; }
      for (let k = 0; k < SPREAD_GATE_BPS.length; k++) if (sprAt[j]! <= SPREAD_GATE_BPS[k]!) { const x = sg[k]!; x.v += v; x.mk += v * mk; x.n++; }
    }
    // No small maker at all: all makers' markout stands in (fills 0 says how little it rests on).
    const markout = sv > 0 ? smk / sv : total > 0 ? allMk / total : 0;
    const est = fee - markout;
    const hv: number[] = [], hc: number[] = [];
    for (const [h, v] of hourV) { hv.push(v); hc.push(fee - hourMk.get(h)! / v); }
    const low = hc.length ? weightedPercentile(hc, hv, 0.1) : est;
    const high = hc.length ? weightedPercentile(hc, hv, 0.9) : est;
    const st: WindowStats = {
      volumeUsdH: r2(volume / hours),
      heldH: r2(hours),
      spreadBps: r2(spreadOf(from)),
      volBpsH: r2(volOf(from)),
      // Who takes makers OUR size: their fills by taker (all makers' when there is none). 23342 is the dominant
      // maker on BTC and ETH, so the share of all maker volume would hide that it is also the taker small makers meet.
      takers: sv > 0
        ? { t1002: r2(cv[0]! / sv), t23342: r2(cv[1]! / sv), other: r2(cv[2]! / sv) }
        : total > 0
          ? { t1002: r2(takerVol[0]! / total), t23342: r2(takerVol[1]! / total), other: r2(takerVol[2]! / total) }
          : { t1002: 0, t23342: 0, other: 0 },
      smallMakers: {
        count: makers.size,
        volumeUsdH: r2(sv / hours),
        fills: sn,
        markout30Bps: r2(markout),
        on1002Bps: cv[0]! > 0 ? r2(cmk[0]! / cv[0]!) : null,
        on23342Bps: cv[1]! > 0 ? r2(cmk[1]! / cv[1]!) : null,
      },
      estCostBps: r2(est),
      estCostLowBps: r2(low),
      estCostHighBps: r2(high),
      gateCostBps: gn >= GATE_MIN_FILLS ? r2(fee - gmk / gv) : null,
      gateShare: gn >= GATE_MIN_FILLS && sv > 0 ? r2(gv / sv) : null,
      flowGate: FLOW_GATE_USD.map((minUsd, k) => ({ minUsd, costBps: fg[k]!.n >= GATE_MIN_FILLS ? r2(fee - fg[k]!.mk / fg[k]!.v) : null, share: sv > 0 ? r2(fg[k]!.v / sv) : 0 })),
      spreadGate: SPREAD_GATE_BPS.map((maxBps, k) => ({ maxBps, costBps: sg[k]!.n >= GATE_MIN_FILLS ? r2(fee - sg[k]!.mk / sg[k]!.v) : null, share: sv > 0 ? r2(sg[k]!.v / sv) : 0 })),
      capacityUsdH: r2(sv / hours),
      confidence: sn >= 2000 ? 'high' : sn >= 300 ? 'medium' : 'low',
    };
    if (o.watch?.length) st.watched = [...perMaker].map(([id, w]) => ({ id, fills: w.n, costBps: r2(fee - w.mk / w.v) }));
    return { st, small };
  };

  const a7 = await stats(from7, vol7);
  await yieldNow();
  const a24 = await stats(from24, vol24);
  await yieldNow();
  const a6 = await stats(from6, vol6);
  const a1 = await stats(from1, vol1);

  // The 7 d profile: weekday / weekend and the hour of day, small makers by the 7 d dominant set.
  const split = [{ v: 0, mk: 0, n: 0 }, { v: 0, mk: 0, n: 0 }];
  const hod = Array.from({ length: 24 }, () => ({ v: 0, mk: 0, n: 0 }));
  for (let j = 0; j < f.n; j++) {
    if ((j & 4095) === 0) await yieldNow();
    if (f.t[j]! < from7 || !a7.small(j)) continue;
    const v = f.ntl[j]!, mk = f.mk[j]!;
    const dow = dowOf(f.t[j]!);
    const w = split[dow === 0 || dow === 6 ? 1 : 0]!;
    w.v += v; w.mk += v * mk; w.n++;
    const h = hod[Math.floor(f.t[j]! / HOUR_MS) % 24]!;
    h.v += v; h.mk += v * mk; h.n++;
  }
  // How many of each UTC hour of day the 7 d window holds since the first print (the per hour divisor).
  const hodCount = new Float64Array(24);
  for (let h = Math.floor(Math.max(from7, firstT) / HOUR_MS); h * HOUR_MS < o.now; h++) {
    const a = Math.max(h * HOUR_MS, from7, firstT);
    const b = Math.min((h + 1) * HOUR_MS, o.now);
    if (b > a) hodCount[h % 24] = hodCount[h % 24]! + (b - a - overlapMs(holes, a, b)) / HOUR_MS;
  }
  // The regime board: the 7 d window minute by minute. A minute before the market's first print, or one the flow does
  // not hold whole, is not held. Its move: the mid at its end against the mid at the previous minute's end.
  const mVol = new Float32Array(nm), mHeld = new Uint8Array(nm);
  {
    const firstM = Math.floor(firstT / 60_000) - m0;
    let prev = NaN;
    for (let mi = 0; mi < nm; mi++) {
      const a = (m0 + mi) * 60_000;
      const s = Math.floor((a + 59_999) / 1000) - s0;
      const m = s >= 0 && s < ns ? mid[s]! : NaN;
      if (prev > 0 && m > 0) mVol[mi] = (Math.abs(m - prev) / prev) * 1e4;
      if (m > 0) prev = m;
      mHeld[mi] = mi >= firstM && overlapMs(holes, a, Math.min(a + 60_000, o.now)) === 0 ? 1 : 0;
    }
  }
  const series: MinuteSeries = { m0, tot: mTot, u: m1002, f: m23342, vol: mVol, held: mHeld };
  const costOf = (x: { v: number; mk: number; n: number }, min: number): number | null => (x.n >= min && x.v > 0 ? r2(fee - x.mk / x.v) : null);
  return {
    price: p.px[lastI]!,
    series,
    w24: a24.st,
    w7: a7.st,
    w6: a6.st,
    w1: a1.st,
    weekdayCostBps: costOf(split[0]!, SPLIT_MIN_FILLS),
    weekendCostBps: costOf(split[1]!, SPLIT_MIN_FILLS),
    hourly: hod.map((x, h) => ({ h, costBps: costOf(x, HOURLY_MIN_FILLS), volumeUsdH: r2(hodCount[h]! > 0 ? volByHod[h]! / hodCount[h]! : 0) })),
  };
}

/** Prints of several chunks as one set of columns (chunks come oldest first and are each in time order). */
export function concatCols(parts: readonly PrintCols[]): PrintCols {
  const n = parts.reduce((s, c) => s + c.n, 0);
  const out: PrintCols = { n, t: new Float64Array(n), px: new Float64Array(n), sz: new Float64Array(n), buyer: new Uint32Array(n), seller: new Uint32Array(n), taker: new Uint8Array(n) };
  let o = 0;
  for (const c of parts) {
    out.t.set(c.t.subarray(0, c.n), o); out.px.set(c.px.subarray(0, c.n), o); out.sz.set(c.sz.subarray(0, c.n), o);
    out.buyer.set(c.buyer.subarray(0, c.n), o); out.seller.set(c.seller.subarray(0, c.n), o); out.taker.set(c.taker.subarray(0, c.n), o);
    o += c.n;
  }
  return out;
}

/** One market's row from its analysis. */
export function rowOf(symbol: string, base: string, tick: number, a: MarketAnalysis, window: BotWindow): BotMarket {
  const w = window === '7d' ? a.w7 : window === '6h' ? a.w6 : window === '1h' ? a.w1 : a.w24;
  return {
    symbol, base, tick,
    tickBps: a.price > 0 && tick > 0 ? r2((tick / a.price) * 1e4) : 0,
    price: a.price,
    ...w,
    weekdayCostBps: a.weekdayCostBps,
    weekendCostBps: a.weekendCostBps,
    hourly: a.hourly,
  };
}

// --- reading the flow -------------------------------------------------------------------------------

const feeBpsOf = (s: SodexSymbol | undefined): number | null => {
  const r = Number(s?.makerFee);
  // makerFee is a rate ("0.00012" = 1.2 bp).
  return s && Number.isFinite(r) && r >= 0 && r < 0.01 ? r * 1e4 : null;
};

interface Computed {
  at: number;
  fee: { makerBps: number; builderBps: number };
  /** Rows with trades in each window (a market whose prints are all older than 24 h is in 7d only). */
  rows: Record<BotWindow, BotMarket[]>;
  /** The regime board's minutes per market (SoDEX name). */
  series: Map<string, MinuteSeries>;
}

/** Calibration rows from the last compute (BOTS_MARKETS_WATCH only). */
export const calibration: Array<{ symbol: string; w7: NonNullable<WindowStats['watched']>; w24: NonNullable<WindowStats['watched']>; est7: number; est24: number }> = [];

async function compute(s: FlowStore, now: number): Promise<Computed> {
  calibration.length = 0;
  let list: SodexSymbol[] = [];
  try { list = await sodexSymbols('perps'); } catch { /* fees default, ticks 0 */ }
  const fees = list.map(feeBpsOf).filter((x): x is number => x !== null);
  // The fee most perps charge (SoDEX's default), else 1.2.
  const counts = new Map<number, number>();
  for (const x of fees) counts.set(x, (counts.get(x) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_MAKER_BPS;
  const id = (key: string): number | null => s.partiesOf(key).find((p) => p.venue === 'sodex')?.id ?? null;
  const id1002 = id('1002');
  const id23342 = id('23342');
  // Calibration (never in production): accounts whose own measured cost is set next to the estimate, e.g. our test
  // wallet, whose real cost the live runs know. BOTS_MARKETS_WATCH=231928,1061
  const watch = (process.env.BOTS_MARKETS_WATCH ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(id).filter((x): x is number => x !== null);
  const from = now - W7 - GATE_S * 1000;
  const active = new Set(s.marketsWithChunks(Math.floor(from / CHUNK_MS) * CHUNK_MS, now + 1));
  const markets = s.markets().filter((m) => m.venue === 'sodex' && kindOf(m.symbol) === 'perp' && active.has(m.id));
  const y = yielder();
  const rows: Computed['rows'] = { '1h': [], '6h': [], '24h': [], '7d': [] };
  const series: Computed['series'] = new Map();
  for (const m of markets) {
    const parts: PrintCols[] = [];
    // A day of blobs at a time: never all 7 d of compressed chunks at once.
    for (let d = Math.floor(from / CHUNK_MS) * CHUNK_MS; d <= now; d += DAY_MS) {
      for (const c of s.chunks(m.id, d, Math.min(d + DAY_MS, now + 1))) {
        parts.push(decodeChunk(c.data));
        await y();
      }
    }
    const cols = concatCols(parts);
    parts.length = 0;
    const sym = findSymbol(list, m.symbol);
    const makerBps = feeBpsOf(sym) ?? common;
    const holes = flowHoles(m.symbol, now - W7, now, now) ?? undefined;
    const a = await analyzeMarket(cols, { now, makerBps, builderBps: BOT_BUILDER_BPS, id1002, id23342, watch, holes }, y);
    if (!a) continue;
    if (watch.length) calibration.push({ symbol: m.symbol, w7: a.w7.watched ?? [], w24: a.w24.watched ?? [], est7: a.w7.estCostBps, est24: a.w24.estCostBps });
    const base = sym?.baseCoin?.replace(/^v(?=[A-Z])/, '') || coinOf(m.symbol);
    const tick = Number(sym?.tickSize) || 0;
    const name = sym?.name ?? m.symbol;
    rows['7d'].push(rowOf(name, base, tick, a, '7d'));
    series.set(name, a.series);
    if (a.w24.volumeUsdH > 0) rows['24h'].push(rowOf(name, base, tick, a, '24h'));
    if (a.w6.volumeUsdH > 0) rows['6h'].push(rowOf(name, base, tick, a, '6h'));
    if (a.w1.volumeUsdH > 0) rows['1h'].push(rowOf(name, base, tick, a, '1h'));
  }
  for (const k of BOT_WINDOWS) rows[k].sort((a, b) => a.estCostBps - b.estCostBps);
  return { at: now, fee: { makerBps: r2(common), builderBps: BOT_BUILDER_BPS }, rows, series };
}

let kept: Computed | null = null;
let running: Promise<Computed> | null = null;
let askedAt = 0;
let lastFailLog = 0;

function refresh(s: FlowStore): Promise<Computed> {
  if (!running) {
    const t0 = Date.now();
    running = compute(s, t0)
      .then((c) => { kept = c; return c; })
      .catch((e: unknown) => {
        // Never silent: a failing compute is what leaves the board on an old answer.
        if (Date.now() - lastFailLog > 10 * 60_000) {
          lastFailLog = Date.now();
          console.warn(`[bots] market estimate failed after ${Date.now() - t0} ms; the answer from ${kept ? new Date(kept.at).toISOString() : 'nothing'} stands: ${String((e as Error)?.stack ?? e)}`);
        }
        throw e;
      })
      .finally(() => { running = null; });
  }
  return running;
}

/** What a request does with the kept answer made at `keptAt` (null: none): serve it, serve it and compute anew behind it, or wait for a fresh one. */
export function servePlan(keptAt: number | null, now: number): 'serve' | 'serve-refresh' | 'wait' {
  if (keptAt === null || now - keptAt > BOT_MARKETS_MAX_AGE) return 'wait';
  return now - keptAt > BOT_MARKETS_TTL ? 'serve-refresh' : 'serve';
}

/** Whether the warm timer computes now: always while someone asked in the last 30 min, else once the kept answer nears BOT_MARKETS_IDLE_EVERY. */
export function warmDue(now: number, askedAt: number, keptAt: number | null): boolean {
  if (now - askedAt <= 30 * 60_000) return true;
  return keptAt === null || now - keptAt >= BOT_MARKETS_IDLE_EVERY - 30_000;
}

/** The answer to serve: the kept one while it is young (a new one computing behind it once past the TTL), else the fresh one. */
async function current(s: FlowStore, now = Date.now()): Promise<Computed> {
  askedAt = now;
  const c = kept;
  const plan = servePlan(c?.at ?? null, now);
  if (c && plan !== 'wait') {
    if (plan === 'serve-refresh') void refresh(s).catch(() => { /* logged; the kept answer stands */ });
    return c;
  }
  // None yet, or too old to show: wait for the fresh one; if that fails, the old one is still better than nothing.
  try {
    return await refresh(s);
  } catch (e) {
    if (kept) return kept;
    throw e;
  }
}

/** The answer for a window: null when the flow is not recorded on this server. Fresh within 5 min; older is served while a new one computes. */
export async function botMarkets(window: BotWindow): Promise<BotMarketsResponse | null> {
  const s = flowReader();
  if (!s) return null;
  startSampling();
  const c = await current(s);
  const lead = await binanceSymbols();
  const withLead = lead ? c.rows[window].map((m) => ({ ...m, lead: lead.has(binanceSymbolOf(m.symbol) ?? '') ? ('binance' as const) : null })) : c.rows[window];
  // SoDEX's sampled book, where there are enough samples: the real spread and the share of time a limit lets a bot
  // quote. The print-based figures only where the book has not been sampled long enough yet.
  const from = Date.now() - WINDOW_H[window] * 3_600_000;
  const markets = withLead.map((m) => {
    const typical = typicalBps(m.symbol, from);
    if (typical === null) return { ...m, spreadFrom: 'prints' as const };
    return {
      ...m,
      spreadBps: Math.round(typical * 100) / 100,
      spreadFrom: 'book' as const,
      ...(m.spreadGate ? { spreadGate: m.spreadGate.map((g) => ({ ...g, share: Math.round((shareUnder(m.symbol, g.maxBps, from) ?? g.share) * 100) / 100 })) } : {}),
    };
  });
  return { at: c.at, window, fee: c.fee, markets };
}

export interface BotRegimeResponse {
  at: number;
  /** 'ALL' or a SoDEX market. */
  symbol: string;
  window: BotWindow;
  /** Each bucket's length (ms): 5 min for 1h and 6h, 15 min for 24h, an hour for 7d. */
  stepMs: number;
  /** Markets the board can show, by 7 d volume (largest first). */
  markets: string[];
  /**
   * Bucket by bucket over the window, oldest first (the field keeps its first name). volBps is in bp per hour (the
   * bucket's minute moves scaled to an hour), so every window reads on one scale. A bucket not held whole: volume null.
   * ALL: volumes summed, volatility weighted by each market's volume in the bucket.
   */
  hours: RegimeHour[];
  /** The typical hour's volatility over 7 d (median, bp/h): what "calm" is measured against. */
  typicalVolBps: number | null;
}

/** One market's buckets over the last `win` from its minutes (bp per hour volatility; null volume when not held whole). */
export function bucketsOf(ms: MinuteSeries, now: number, win: BotWindow): RegimeHour[] {
  const step = REGIME_STEP_MIN[win];
  const endM = Math.floor(now / 60_000);
  const lastB = Math.floor(endM / step) * step;            // the bucket now runs in
  const firstB = lastB - (WINDOW_H[win] * 60) + step;
  const out: RegimeHour[] = [];
  for (let b = firstB; b <= lastB; b += step) {
    let tot = 0, u = 0, f = 0, vol = 0, n = 0;
    const due = Math.min(step, endM - b + 1);               // the running bucket has had fewer minutes
    for (let m = b; m < b + due; m++) {
      const i = m - ms.m0;
      if (i < 0 || i >= ms.tot.length || !ms.held[i]) continue;
      tot += ms.tot[i]!; u += ms.u[i]!; f += ms.f[i]!; vol += ms.vol[i]!; n++;
    }
    // Held: at least half its minutes are (a short recorder gap does not blank a bucket; a missing hour does).
    out.push({ t: b * 60_000, volumeUsd: n > 0 && n >= due / 2 ? Math.round(tot) : null, t1002Usd: Math.round(u), t23342Usd: Math.round(f), volBps: r2(n > 0 ? (vol / n) * 60 : 0) });
  }
  return out;
}

/** The median hour's volatility over the series (bp/h), from held hours only. */
export function typicalOf(ms: MinuteSeries): number | null {
  const hours: number[] = [];
  for (let i = 0; i + 60 <= ms.tot.length; i += 60) {
    let v = 0, n = 0;
    for (let j = i; j < i + 60; j++) if (ms.held[j]) { v += ms.vol[j]!; n++; }
    if (n >= 50) hours.push((v / n) * 60);
  }
  if (!hours.length) return null;
  hours.sort((a, b) => a - b);
  return r2(hours[hours.length >> 1]!);
}

/** The regime board (Explore): one market's window bucket by bucket, or every market together ('ALL'). Null: no flow here. */
export async function botRegime(symbol: string, win: BotWindow = '7d'): Promise<BotRegimeResponse | null> {
  const s = flowReader();
  if (!s) return null;
  const c = await current(s);
  const markets = [...c.rows['7d']].sort((a, b) => b.volumeUsdH - a.volumeUsdH).map((m) => m.symbol).filter((m) => c.series.has(m));
  const base = { at: c.at, window: win, stepMs: REGIME_STEP_MIN[win] * 60_000, markets };
  const want = symbol.toUpperCase();
  if (want !== 'ALL') {
    const name = markets.find((m) => m.toUpperCase() === want);
    const one = name ? c.series.get(name) : undefined;
    return one ? { ...base, symbol: name!, hours: bucketsOf(one, c.at, win), typicalVolBps: typicalOf(one) } : { ...base, symbol: want, hours: [], typicalVolBps: null };
  }
  return { ...base, symbol: 'ALL', ...regimeAll(c.series, markets, c.at, win) };
}

/** Every market together: volumes summed, volatility weighted by each market's volume in the bucket (and the typical hour's by its window volume). */
export function regimeAll(series: ReadonlyMap<string, MinuteSeries>, markets: readonly string[], now: number, win: BotWindow): { hours: RegimeHour[]; typicalVolBps: number | null } {
  // A bucket is held when any market holds it (a market listed or recorded later does not blank the others).
  const by = new Map<number, { v: number; held: boolean; a: number; b: number; w: number; wv: number }>();
  const typ: Array<[number, number]> = [];
  for (const m of markets) {
    const ms = series.get(m);
    if (!ms) continue;
    const tv = typicalOf(ms);
    let wsum = 0;
    for (const h of bucketsOf(ms, now, win)) {
      const x = by.get(h.t) ?? { v: 0, held: false, a: 0, b: 0, w: 0, wv: 0 };
      if (h.volumeUsd !== null) {
        x.held = true; x.v += h.volumeUsd;
        x.a += h.t1002Usd; x.b += h.t23342Usd;
        x.w += h.volumeUsd; x.wv += h.volumeUsd * h.volBps; wsum += h.volumeUsd;
      }
      by.set(h.t, x);
    }
    if (tv !== null && wsum > 0) typ.push([tv, wsum]);
  }
  const hours = [...by].sort((a, b) => a[0] - b[0]).map(([t, x]) => ({ t, volumeUsd: x.held ? Math.round(x.v) : null, t1002Usd: Math.round(x.a), t23342Usd: Math.round(x.b), volBps: r2(x.w > 0 ? x.wv / x.w : 0) }));
  const tw = typ.reduce((a, [, w]) => a + w, 0);
  return { hours, typicalVolBps: tw > 0 ? r2(typ.reduce((a, [v, w]) => a + v * w, 0) / tw) : null };
}

/**
 * Kept warm every 5 min while someone asked in the last 30 min, and every BOT_MARKETS_IDLE_EVERY when nobody has (the
 * book sampling stops then): the first visitor after a quiet spell gets an answer at most that old, at once. The
 * compute gives the loop back every YIELD_MS, ~25 s of it every 10 min when idle.
 */
export function keepBotMarketsWarm(): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - askedAt > 30 * 60_000) stopSampling();
    if (!warmDue(now, askedAt, kept?.at ?? null)) return;
    const s = flowReader();
    if (s) void refresh(s).catch(() => { /* logged; next round */ });
  }, BOT_MARKETS_TTL);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Tests: forget the kept answer. */
export function clearBotMarkets(): void {
  kept = null;
  askedAt = 0;
}
