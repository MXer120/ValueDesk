/**
 * REBUILDING COHORT HISTORY the index did not record.
 *
 * The 15-minute series (cohort_series) and the hourly mix (cohort_mix) are
 * recorded live, so a span the indexer was down for is a hole in every 7D and
 * 30D chart: 2026-10-16 17:30 to 2026-10-23 12:30 UTC (the move to Tokyo) left
 * the 7D chart with a day and a half. Hyperliquid's funding history fills it:
 * `userFunding` lists, for every hour a wallet held a position, the coin and its
 * size (`szi`) - trade.xyz's `xyz:` markets included - however often the
 * wallet traded in between. With hourly prices (1h candles), that is every
 * wallet's positions, hour by hour.
 *
 * WHAT IS REBUILT. Every missing hour of a span (no recorded point within 45
 * minutes, between two recorded points, at least MIN_SPAN_HOURS of them, and a
 * span that stays in the 30-day window for another MIN_SHOWN_MS), in every scope
 * that holds Hyperliquid or trade.xyz:
 *   - Hyperliquid and trade.xyz: from the reads, netted and summed as a
 *     recording is (netWallet, Aggregator). Membership is the wallet's as it is
 *     now (all-time PnL, perp equity) - unless the positions it held then were
 *     far beyond what its equity now carries (it has withdrawn since): then its
 *     equity then, from its portfolio's account-value history.
 *   - Lighter, SoDEX and Arcus - about a tenth of the money, and not readable
 *     this way (a Lighter main account's funding history needs its owner's key):
 *     drawn straight from their last recorded point before the span to the
 *     first after it, inside a netted scope only. A scope of those venues alone
 *     keeps its gap.
 * Rebuilt rows are marked (src = 1), and the chart says so.
 *
 * WHICH WALLETS. Reading every member (Hyperliquid alone has 111k, at 20+ weight
 * each) would take days of the budget. Wallets are stratified by what they could
 * have held - max(equity now, 30-day volume / 10) - and read: $1M+ every one,
 * $100K+ one in four, $10K+ one in ten, the rest one in fifty, a sampled wallet
 * standing for 1 / rate (sampleHash: the same wallets every time). Each is read
 * for the span plus EDGE_HOURS either side, where the rebuild is checked
 * against what was recorded (RebuildCheck).
 */
import {
  Aggregator, COHORTS, longShare, netWallet, sampleHash, scopeKey, sectorTotals,
  type Position, type WalletVenue,
} from '../valuedesk/cohorts/model.js';
import { VENUES, type Venue } from '../valuedesk/types.js';
import { DAY_MS } from './windows.js';

export const HOUR_MS = 3_600_000;
/** An hour with a recorded point this close is not missing. */
const NEAR_MS = 45 * 60_000;
/** Shorter gaps are left alone. */
export const MIN_SPAN_HOURS = 2;
/** Hours read past each edge of a span, where the rebuild is checked against the recording. */
export const EDGE_HOURS = 3;
/** The longest range a chart shows. */
export const REBUILD_WINDOW_MS = 30 * DAY_MS;
/** A span leaving the window sooner than this is not worth its reads (~30 weight a wallet). */
export const MIN_SHOWN_MS = 7 * DAY_MS;
/** The venues the reads rebuild. */
export const REBUILT_VENUES: readonly Venue[] = ['hyperliquid', 'tradexyz'];
/** Positions this many times the equity a wallet has now: it was larger then, and its equity then is read. */
export const EQUITY_HISTORY_LEVERAGE = 25;
/** Coins kept per cohort in a rebuilt mix row (cohortTracker MIX_COINS). */
const MIX_COINS = 120;

/** First and last missing hour. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The spans to rebuild between recorded points (sorted, ms): hours with no
 * recorded point within 45 minutes, at least MIN_SPAN_HOURS of them, starting
 * no earlier than MIN_SHOWN_MS inside the window.
 */
export function missingSpans(recorded: readonly number[], now: number): Span[] {
  const lo = now - REBUILD_WINDOW_MS + MIN_SHOWN_MS;
  const out: Span[] = [];
  for (let i = 1; i < recorded.length; i++) {
    const from = (Math.floor((recorded[i - 1]! + NEAR_MS) / HOUR_MS) + 1) * HOUR_MS;
    const to = (Math.ceil((recorded[i]! - NEAR_MS) / HOUR_MS) - 1) * HOUR_MS;
    if (to - from + HOUR_MS < MIN_SPAN_HOURS * HOUR_MS || from < lo) continue;
    out.push({ from, to });
  }
  return out;
}

/** A gap in the recording this long or longer was an outage: the books missed its prints. */
export const OUTAGE_GAP_MS = HOUR_MS;

/**
 * When the recording resumed after its last outage (a gap of OUTAGE_GAP_MS or
 * more between recorded points; 0 = none). A streamed book read before then
 * missed that outage's prints, whatever its size (2026-10-25: a quarter of
 * Hyperliquid's gross and half of trade.xyz's were books read before the
 * 2026-10-16 outage, holding positions closed since).
 *
 * `upSince`: when this run of the indexer started. Only the gap across that start is an
 * outage then: one that opened while it ran was a slow recording pass - the streams ran
 * on and the books followed every print (2026-10-27: 70k more books made one pass take
 * 100 minutes, and each gap it left had every book re-read as stale) - and one before it
 * was the last run's to settle.
 */
export function resumedAfterOutage(recorded: readonly number[], upSince?: number): number {
  for (let i = recorded.length - 1; i > 0; i--) {
    if (recorded[i]! - recorded[i - 1]! < OUTAGE_GAP_MS) continue;
    if (upSince === undefined || (recorded[i - 1]! < upSince && recorded[i]! >= upSince)) return recorded[i]!;
  }
  return 0;
}

/** What a span's reads cover: the span and EDGE_HOURS either side. */
export const readRange = (s: Span): { from: number; to: number } => ({ from: s.from - EDGE_HOURS * HOUR_MS, to: s.to + EDGE_HOURS * HOUR_MS });

// --- which wallets ----------------------------------------------------------------------------

/** What a wallet could have held: its equity now, or its 30-day volume / 10. */
export function sizeProxy(equity: number | null | undefined, volume30d: number | null | undefined): number {
  const e = typeof equity === 'number' && Number.isFinite(equity) ? equity : 0;
  const v = typeof volume30d === 'number' && Number.isFinite(volume30d) ? volume30d : 0;
  return Math.max(e, v / 10);
}

/** The share of wallets of a size that is read. */
export function rebuildRate(proxy: number): number {
  if (proxy >= 1_000_000) return 1;
  if (proxy >= 100_000) return 0.25;
  if (proxy >= 10_000) return 0.1;
  return 0.02;
}

/** Whether a wallet is read for a rebuild, and how many wallets it stands for. */
export function rebuildSample(address: string, proxy: number): { counts: boolean; weight: number } {
  const rate = rebuildRate(proxy);
  if (rate >= 1) return { counts: true, weight: 1 };
  return sampleHash(address) < rate ? { counts: true, weight: 1 / rate } : { counts: false, weight: 1 };
}

// --- one wallet's reads -----------------------------------------------------------------------

/**
 * A wallet's positions over a span's reads: per symbol, runs of [first hour,
 * size, hours]. `eq`: its account value [t, value] where its equity then was
 * read. `w`: the wallets it stands for.
 */
export interface WalletHist {
  p: Record<string, Array<[number, number, number]>>;
  eq?: Array<[number, number]>;
  w: number;
}

export interface FundingRow {
  time: number;
  coin: string;
  szi: number;
}

/** Funding rows (one per hour and coin held) as runs. */
export function histOf(rows: readonly FundingRow[], weight: number): WalletHist {
  const by = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (!Number.isFinite(r.szi) || !r.szi || !r.coin) continue;
    const h = Math.round(r.time / HOUR_MS) * HOUR_MS;
    const m = by.get(r.coin) ?? new Map<number, number>();
    m.set(h, r.szi);
    by.set(r.coin, m);
  }
  const p: WalletHist['p'] = {};
  for (const [coin, m] of by) {
    const runs: Array<[number, number, number]> = [];
    for (const h of [...m.keys()].sort((a, b) => a - b)) {
      const szi = m.get(h)!;
      const last = runs[runs.length - 1];
      if (last && last[1] === szi && last[0] + last[2] * HOUR_MS === h) last[2]++;
      else runs.push([h, szi, 1]);
    }
    p[coin] = runs;
  }
  return { p, w: weight };
}

/** The positions held at hour `t` (no entry price: the rebuild has none). */
export function positionsAt(w: WalletHist, t: number): Position[] {
  const out: Position[] = [];
  for (const [symbol, runs] of Object.entries(w.p)) {
    for (const [h, szi, n] of runs) {
      if (h > t) break;
      if (t < h + n * HOUR_MS) {
        out.push({ symbol, szi, entry: null });
        break;
      }
    }
  }
  return out;
}

/** A value at `t` from [t, value] points (sorted): linear between them, the nearest beyond them. */
export function valueAt(points: ReadonlyArray<readonly [number, number]>, t: number): number | null {
  if (!points.length) return null;
  if (t <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]!;
    if (t1 < t) continue;
    const [t0, v0] = points[i - 1]!;
    return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return points[points.length - 1]![1];
}

/** The largest gross notional the wallet held in any hour, at `price`. */
export function peakNotional(w: WalletHist, price: (symbol: string) => number | null): number {
  const byHour = new Map<number, number>();
  for (const [symbol, runs] of Object.entries(w.p)) {
    const px = price(symbol);
    if (!px || !(px > 0)) continue;
    for (const [h, szi, n] of runs) {
      for (let i = 0; i < n; i++) {
        const t = h + i * HOUR_MS;
        byHour.set(t, (byHour.get(t) ?? 0) + Math.abs(szi) * px);
      }
    }
  }
  let peak = 0;
  for (const v of byHour.values()) peak = Math.max(peak, v);
  return peak;
}

/** Positions far beyond the equity now: the equity then decides the wallet's size cohort. */
export const needsEquityHistory = (peak: number, equityNow: number | null): boolean =>
  peak > EQUITY_HISTORY_LEVERAGE * Math.max(equityNow ?? 0, 1_000);

/** Which venue a Hyperliquid funding row's coin belongs to (other HIP-3 dexes: none, as the books). */
export function venueOfSymbol(symbol: string): Venue | null {
  if (!symbol.includes(':')) return 'hyperliquid';
  return symbol.startsWith('xyz:') ? 'tradexyz' : null;
}

/** An hourly price series' value at `t`: that hour's, else the nearest within two hours. */
export function priceAt(px: ReadonlyMap<number, number> | undefined, t: number): number | null {
  if (!px) return null;
  for (const d of [0, -1, 1, -2, 2]) {
    const v = px.get(t + d * HOUR_MS);
    if (v && v > 0) return v;
  }
  return null;
}

// --- the hours --------------------------------------------------------------------------------

/** A wallet as it is now on a rebuilt venue: what decides its cohorts. */
export interface NowFigures {
  pnl: number | null;
  equity: number | null;
  label: string | null;
}

export interface RebuildWallet {
  address: string;
  hist: WalletHist;
  now: Partial<Record<Venue, NowFigures>>;
}

/** A recorded point of a venue's own scope: series and mix, per cohort. */
export interface EdgePoint {
  t: number;
  series: Map<string, [number, number]>;
}
export interface EdgeMix {
  t: number;
  mix: Map<string, { c: Record<string, [number, number]>; s: Record<string, [number, number]> }>;
}

/** A venue the reads do not rebuild, at the recorded points either side of the span. */
export interface Bridge {
  left: EdgePoint;
  right: EdgePoint;
  mixLeft: EdgeMix | null;
  mixRight: EdgeMix | null;
}

export interface SeriesRow {
  scope: string;
  cohort: string;
  t: number;
  long: number;
  short: number;
  rebuilt: true;
}
export interface MixRow {
  scope: string;
  cohort: string;
  t: number;
  data: string;
  rebuilt: true;
}

type MixData = { c: Record<string, [number, number]>; s: Record<string, [number, number]> };

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function bridged(b: Bridge, cohort: string, t: number): [number, number] {
  const l = b.left.series.get(cohort) ?? [0, 0];
  const r = b.right.series.get(cohort) ?? [0, 0];
  const f = b.right.t === b.left.t ? 0 : (t - b.left.t) / (b.right.t - b.left.t);
  return [lerp(l[0], r[0], f), lerp(l[1], r[1], f)];
}

function bridgedMix(b: Bridge, cohort: string, t: number): MixData | null {
  if (!b.mixLeft || !b.mixRight) return null;
  const l = b.mixLeft.mix.get(cohort) ?? { c: {}, s: {} };
  const r = b.mixRight.mix.get(cohort) ?? { c: {}, s: {} };
  const f = b.mixRight.t === b.mixLeft.t ? 0 : (t - b.mixLeft.t) / (b.mixRight.t - b.mixLeft.t);
  const one = (x: Record<string, [number, number]>, y: Record<string, [number, number]>) => {
    const out: Record<string, [number, number]> = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const a = x[k] ?? [0, 0];
      const c = y[k] ?? [0, 0];
      out[k] = [Math.round(lerp(a[0], c[0], f)), Math.round(lerp(a[1], c[1], f))];
    }
    return out;
  };
  return { c: one(l.c, r.c), s: one(l.s, r.s) };
}

function addMix(into: MixData, add: MixData): void {
  for (const part of ['c', 's'] as const) {
    for (const [k, [l, s]] of Object.entries(add[part])) {
      const cur = into[part][k] ?? [0, 0];
      into[part][k] = [cur[0] + l, cur[1] + s];
    }
  }
}

/** The non-empty subsets of the rebuilt venues: what the reads sum on their own. */
const BASES: Venue[][] = [['hyperliquid'], ['tradexyz'], ['hyperliquid', 'tradexyz']];

export interface HourResult {
  series: SeriesRow[];
  mix: MixRow[];
  /** The base scopes' figures per cohort ([long, short]), for the check. */
  base: Map<string, Map<string, [number, number]>>;
}

/**
 * One hour, every scope that holds a rebuilt venue: the reads netted and summed,
 * plus the other venues bridged. A scope with another venue that has no bridge
 * is left out (keeps its gap).
 */
export function rebuildHour(
  t: number,
  wallets: readonly RebuildWallet[],
  price: (symbol: string, t: number) => number | null,
  bridges: ReadonlyMap<Venue, Bridge>,
  withMix: boolean,
): HourResult {
  const base = new Map<string, Map<string, [number, number]>>();
  const baseMix = new Map<string, Map<string, MixData>>();
  const mark = (_v: Venue, symbol: string) => price(symbol, t);
  const heldAt = wallets.map((w) => positionsAt(w.hist, t));
  for (const scope of BASES) {
    const agg = new Aggregator();
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i]!;
      const held = heldAt[i]!;
      const per = new Map<Venue, WalletVenue>();
      for (const v of scope) {
        const mine = held.filter((p) => venueOfSymbol(p.symbol) === v);
        const now = w.now[v];
        if (!now && !mine.length) continue;
        const equity = w.hist.eq ? valueAt(w.hist.eq, t) : now?.equity ?? null;
        per.set(v, { pnl: now?.pnl ?? null, equity, label: now?.label ?? null, positions: mine, at: t, weight: w.hist.w });
      }
      if (per.size) agg.add(netWallet(w.address, per, mark));
    }
    const key = scopeKey(scope);
    const s = new Map<string, [number, number]>();
    const m = new Map<string, MixData>();
    for (const st of agg.result()) {
      s.set(st.id, [st.long, st.short]);
      if (!withMix) continue;
      const c: Record<string, [number, number]> = {};
      for (const x of st.markets.slice(0, MIX_COINS)) c[x.coin] = [Math.round(x.long), Math.round(x.short)];
      const sct: Record<string, [number, number]> = {};
      for (const x of sectorTotals(st.markets)) sct[x.sector] = [Math.round(x.long), Math.round(x.short)];
      m.set(st.id, { c, s: sct });
    }
    base.set(key, s);
    baseMix.set(key, m);
  }
  const series: SeriesRow[] = [];
  const mix: MixRow[] = [];
  for (let mask = 1; mask < 1 << VENUES.length; mask++) {
    const scope = VENUES.filter((_, i) => mask & (1 << i));
    const mine = scope.filter((v) => REBUILT_VENUES.includes(v));
    if (!mine.length) continue;
    const others = scope.filter((v) => !REBUILT_VENUES.includes(v));
    if (others.some((v) => !bridges.has(v))) continue;
    const key = scopeKey(scope);
    const b = base.get(scopeKey(mine))!;
    const bm = baseMix.get(scopeKey(mine))!;
    const mixOk = withMix && others.every((v) => bridges.get(v)!.mixLeft && bridges.get(v)!.mixRight);
    for (const c of COHORTS) {
      let [long, short] = b.get(c.id) ?? [0, 0];
      for (const v of others) {
        const [l, s] = bridged(bridges.get(v)!, c.id, t);
        long += l;
        short += s;
      }
      series.push({ scope: key, cohort: c.id, t, long, short, rebuilt: true });
      if (!mixOk) continue;
      const data: MixData = { c: { ...(bm.get(c.id)?.c ?? {}) }, s: { ...(bm.get(c.id)?.s ?? {}) } };
      for (const v of others) {
        const x = bridgedMix(bridges.get(v)!, c.id, t);
        if (x) addMix(data, x);
      }
      mix.push({ scope: key, cohort: c.id, t, data: JSON.stringify(data), rebuilt: true });
    }
  }
  return { series, mix, base };
}

// --- the check --------------------------------------------------------------------------------

/**
 * The rebuild against the recording at the span's edges (Hyperliquid's own
 * scope): per cohort, the largest gap in long share (percentage points) and in
 * gross ([long + short] rebuilt / recorded - 1, %), over every edge hour both have.
 */
export interface RebuildCheck {
  hours: number;
  cohorts: Record<string, { sharePts: number; grossPct: number }>;
}

export function checkEdges(
  rebuilt: ReadonlyMap<number, ReadonlyMap<string, [number, number]>>,
  recorded: ReadonlyMap<number, ReadonlyMap<string, [number, number]>>,
): RebuildCheck {
  const out: RebuildCheck = { hours: 0, cohorts: {} };
  for (const [t, reb] of rebuilt) {
    const rec = recorded.get(t);
    if (!rec) continue;
    out.hours++;
    for (const [cohort, [l, s]] of reb) {
      const r = rec.get(cohort);
      if (!r) continue;
      const a = longShare(l, s);
      const b = longShare(r[0], r[1]);
      const cur = out.cohorts[cohort] ?? { sharePts: 0, grossPct: 0 };
      if (a !== null && b !== null) cur.sharePts = Math.max(cur.sharePts, Math.round(Math.abs(a - b) * 1000) / 10);
      const g = r[0] + r[1];
      if (g > 0) cur.grossPct = Math.max(cur.grossPct, Math.round(Math.abs((l + s) / g - 1) * 1000) / 10);
      out.cohorts[cohort] = cur;
    }
  }
  return out;
}
