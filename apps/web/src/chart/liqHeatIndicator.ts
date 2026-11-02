/**
 * The liquidation heatmap as a klinecharts indicator on the candle pane: the
 * historical view (components/liqmap/LiqHeatmap.tsx) is the app's own chart
 * (components/Chart.tsx, `bare`) with this drawn on it, so it scrolls, zooms,
 * changes timeframe, switches to log / percentage scale and follows the chart's
 * clock exactly as the chart does - the chart's own axes place every cell.
 *
 * Each bar shows the snapshot in force at its close: the newest of the indexer's
 * snapshots (15-minutely for 3 days, hourly to 30) taken before the bar ends, if
 * it is not older than STALE_MS. A cell is a price bucket of that snapshot, its
 * colour its notional's share of the scale (`scale`: heatScale) - dark violet
 * through teal to yellow, transparent below a floor - or, by leverage, its mix of
 * bands (liqLev.ts levRgb) at a strength by the same share.
 *
 * The historical view also asks (`fit`) that the price axis take in each bar's levels,
 * as the live view's window does (liqLev.ts levelWindow): the figures `lo` / `hi`
 * below are what the chart fits its axis to, besides the candles. Nothing draws
 * them. And it may lay the levels now over the pane's right edge (`strip`), on the
 * same axis, so a level now lines up with its band in the history.
 */
import type { IndicatorTemplate, KLineData } from 'klinecharts';
import { LEV_BANDS, addBands, isAllLev, levRgb, levelWindow, robustMax, shownBands, sideBands, type Bands, type ColorBy, type LevFilter } from './liqLev';
import { drawProfile, type LiqMapData } from './liqProfile';

export const LIQ_HEAT = 'VS_LIQHEAT';

/**
 * One snapshot as the history API sends it: time, price, bucket width, rows of [bucket, long
 * USD, short USD] and, from 2026-10-31, USD per leverage band (server levels.ts SnapRow).
 */
export interface HeatPoint {
  t: number;
  p: number;
  st: number;
  b: Array<[number, number, number, ...number[]]>;
  /**
   * The same snapshot at a finer step over part of its range (the history's fine layers, server
   * liqRead.ts liqHistoryFine: BTC $10 / $1 near the price then): inside [lo, hi) these cells are
   * drawn instead of the snapshot's own (cellsOf).
   */
  f?: { st: number; lo: number; hi: number; b: HeatPoint['b'] } | null;
}

export interface HeatData {
  points: HeatPoint[];
  /** The notional a cell must reach to be drawn at full strength. */
  scale: number;
  /** Only longs, only shorts, or both. */
  side?: 'long' | 'short' | 'both';
  /** By side (viridis, by notional) or by leverage (the cell's mix of bands); default side. */
  colorBy?: ColorBy;
  /** The leverage bands shown (default all). */
  lev?: LevFilter;
  /** The price axis takes in each bar's levels, not the candles alone (the historical view). */
  fit?: boolean;
  /** The levels now as a strip on the pane's right edge (the historical view's toggle). */
  strip?: LiqMapData | null;
  /** The width the colours are of (default the newest snapshot's, refStep): the fine step while fine parts are drawn. */
  ref?: number | null;
  /** The strip as the chart view's profile: wider, unlabelled, with the cumulative curves (liqProfile.ts). */
  profile?: boolean;
}

/** A snapshot older than this before a bar's end does not stand for it. */
const STALE_MS = 2 * 60 * 60_000;

const RAMP: ReadonlyArray<[number, number, number]> = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export const HEAT_FLOOR = 0.03;

/** A cell's colour by its share of the scale (null: below the floor, not drawn). Past the scale: the top colour. */
export function heatColor(x: number): string | null {
  if (!(x > HEAT_FLOOR)) return null;
  const t = Math.min(1, x);
  const f = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f));
  const k = f - i;
  const [r1, g1, b1] = RAMP[i]!;
  const [r2, g2, b2] = RAMP[i + 1]!;
  const a = 0.3 + 0.55 * Math.min(1, t * 1.6);
  return `rgba(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)},${a.toFixed(3)})`;
}

/** A cell's colour by its leverage mix, as strong as its share of the scale (null: below the floor). */
export function levHeatColor(x: number, b: Bands): string | null {
  if (!(x > HEAT_FLOOR)) return null;
  const c = levRgb(b);
  if (!c) return null;
  const a = 0.2 + 0.7 * Math.min(1, x) ** 0.7;
  return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
}

const ZERO: Bands = [0, 0, 0, 0];

/**
 * One cell as shown: its notional on the side(s) and leverage bands shown, and that by band
 * ([low, mid, high, unknown]). Every band on: the whole of each side.
 */
export function cellOf(r: HeatPoint['b'][number], side: HeatData['side'] = 'both', lev: LevFilter = LEV_BANDS): { v: number; bands: Bands } {
  const all = isAllLev(lev);
  const useL = side !== 'short' && r[1] > 0;
  const useS = side !== 'long' && r[2] > 0;
  const lb = useL ? shownBands(sideBands(r[1], r, 3), lev) : ZERO;
  const sb = useS ? shownBands(sideBands(r[2], r, 6), lev) : ZERO;
  const bands = addBands(lb, sb);
  const v = all ? (useL ? r[1] : 0) + (useS ? r[2] : 0) : bands[0] + bands[1] + bands[2];
  return { v, bands };
}

/**
 * The scale: each snapshot's own robust scale (liqLev.ts robustMax: the 95th percentile of its
 * cells, raised to the largest within 3x of it, at least two cells above), the median over the
 * snapshots. A level that sits in every snapshot (SoDEX BTC's two $70M accounts, all of 30
 * days) is two cells of each and never sets it, as it did once it made up the top 1.5% of every
 * cell loaded; a one-off spike in time does not either. Checked on production 2026-10-31 (BTC,
 * 30 days): SoDEX $52K (the whales drawn at full), every venue $83M (the percentile over every
 * cell gave $83K and $76M).
 */
export function heatScale(points: readonly HeatPoint[], side: HeatData['side'] = 'both', lev: LevFilter = LEV_BANDS): number {
  const per: number[] = [];
  const ref = refStep(points);
  for (const q of points) {
    const k = stepNorm(q, ref);
    const s = robustMax(q.b.map((r) => cellOf(r, side, lev).v * k), { q: 0.95, ratio: 3 });
    if (s > 0) per.push(s);
  }
  if (!per.length) return 1;
  per.sort((a, b) => a - b);
  return per[per.length >> 1] || 1;
}

/**
 * MIXED STEPS. Each snapshot keeps its own bucket width (`st`): 0.25% of the price until
 * 2026-10-31, 0.125% after (server levels.ts HIST_STEP), and a price that moves across a round
 * width changes it too. A cell is drawn over its own snapshot's range (cellRange), and coloured by
 * its notional per the newest snapshot's width (stepNorm): a $200 cell of last week holds about
 * what two $100 cells of today hold, and without this it read twice as hot where the step changed.
 * Tooltips and details keep each cell's own figure.
 */
export const cellRange = (r: HeatPoint['b'][number], st: number): [number, number] => [r[0] * st, (r[0] + 1) * st];
/** The width the colours are of: the newest snapshot's (null: none). */
export const refStep = (points: readonly HeatPoint[]): number | null => points.at(-1)?.st ?? null;
/** What a snapshot's cells are multiplied by to be read per `ref` of price (1 at the same width). */
export const stepNorm = (q: HeatPoint, ref: number | null): number => (ref && q.st > 0 ? ref / q.st : 1);

/**
 * Stream rows (LiqRow at `step`) as snapshot rows (SnapRow) at `st`, as the indexer makes a snapshot
 * (levels.ts snapOfNow): a level the price `p` has crossed is left out, a long above it or a short below.
 */
export function snapRowsOf(rows: ReadonlyArray<ArrayLike<number>>, step: number, st: number, p: number): HeatPoint['b'] {
  const by = new Map<number, number[]>();
  for (const r of rows) {
    const lo = r[0]! * step;
    const keepL = lo < p;
    const keepS = lo + step > p;
    const l = keepL ? r[1] ?? 0 : 0;
    const s = keepS ? r[2] ?? 0 : 0;
    if (!l && !s) continue;
    const j = Math.floor(lo / st + 1e-9);
    let b = by.get(j);
    if (!b) { b = [j, 0, 0, 0, 0, 0, 0, 0, 0]; by.set(j, b); }
    b[1]! += l;
    b[2]! += s;
    for (let k = 0; k < 3; k++) {
      if (keepL) b[3 + k]! += r[5 + k] ?? 0;
      if (keepS) b[6 + k]! += r[8 + k] ?? 0;
    }
  }
  return [...by.values()].sort((a, b) => a[0]! - b[0]!) as HeatPoint['b'];
}

/** A drawn cell: its price range, its row, and the step it is of (the snapshot's or its fine part's). */
export type HeatCell = { lo: number; hi: number; r: HeatPoint['b'][number]; st: number };

/**
 * A snapshot's cells as drawn: its own rows, but inside its fine part's range - widened to whole
 * cells of its own step, so the two never overlap nor leave a gap - the fine part's rows instead.
 * Lowest first. Kept per point (a point is not changed once handed to the layer).
 */
export function cellsOf(q: HeatPoint): HeatCell[] {
  const hit = cellCache.get(q);
  if (hit) return hit;
  const f = q.f;
  const eps = 1e-9;
  const flo = f ? Math.ceil(f.lo / q.st - eps) * q.st : 0;
  const fhi = f ? Math.floor(f.hi / q.st + eps) * q.st : 0;
  const fineOn = !!f && fhi > flo;
  const out: HeatCell[] = [];
  for (const r of q.b) {
    const [lo, hi] = cellRange(r, q.st);
    if (fineOn && lo >= flo - eps * q.st && hi <= fhi + eps * q.st) continue;
    out.push({ lo, hi, r, st: q.st });
  }
  if (fineOn) {
    for (const r of f.b) {
      const [lo, hi] = cellRange(r, f.st);
      if (lo < flo - eps * f.st || hi > fhi + eps * f.st) continue;
      out.push({ lo, hi, r, st: f.st });
    }
    out.sort((a, b) => a.lo - b.lo);
  }
  cellCache.set(q, out);
  return out;
}
const cellCache = new WeakMap<HeatPoint, HeatCell[]>();

/**
 * A column's cells as painted: pixel rows `top` to `bot` (from `y`, price to a whole pixel) and the
 * value against the scale (per `ref`'s width: a $1 cell is read as a hundredth of a $100 one).
 * Cells under a pixel tall share their row: the strongest is painted there (a cell of a pixel or
 * more as it is) - the pixel shows its strongest level, as the fine tiles pooled to it keep.
 */
export function pixelCells(cells: readonly HeatCell[], side: HeatData['side'], lev: LevFilter, ref: number | null, scale: number, y: (price: number) => number): Array<{ top: number; bot: number; v: number; bands: Bands }> {
  const out: Array<{ top: number; bot: number; v: number; bands: Bands }> = [];
  let row: { top: number; bot: number; v: number; bands: Bands } | null = null;
  for (const { lo, hi, r, st } of cells) {
    const { v, bands } = cellOf(r, side, lev);
    if (!(v > 0)) continue;
    const k = (ref && st > 0 ? ref / st : 1) / (scale || 1);
    const top = y(hi);
    const bot = y(lo);
    // A pixel or less: it shares its row (rounded, a cell a pixel tall may straddle two rows' worth).
    if (bot - top > 1) { out.push({ top, bot, v: v * k, bands }); continue; }
    if (row && row.top === top) { if (v * k > row.v) { row.v = v * k; row.bands = bands; } continue; }
    row = { top, bot: top + 1, v: v * k, bands };
    out.push(row);
  }
  return out;
}

/** The cell of a snapshot holding `price` (null: none there). */
export function cellAt(q: HeatPoint, price: number): HeatCell | null {
  const cells = cellsOf(q);
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cells[mid]!;
    if (price < c.lo) hi = mid - 1;
    else if (price >= c.hi) lo = mid + 1;
    else return c;
  }
  return null;
}

/** The snapshot in force at the close of a bar starting at `t` (`barMs` long): index into `times`, or -1. */
export function snapshotFor(times: readonly number[], t: number, barMs: number): number {
  const end = t + barMs;
  let lo = 0;
  let hi = times.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < end) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at >= 0 && end - times[at]! <= Math.max(STALE_MS, barMs) ? at : -1;
}

/** The bar length the chart's data shows (the gap between its last two bars). */
export function barMsOf(list: readonly KLineData[]): number {
  for (let i = list.length - 1; i > 0; i--) {
    const d = list[i]!.timestamp - list[i - 1]!.timestamp;
    if (d > 0) return d;
  }
  return 60_000;
}

/** Each snapshot's level window (liqLev.ts levelWindow) over what is shown of it; null: nothing shown. */
export function windowsOf(d: HeatData): Array<[number, number] | null> {
  const hit = windows.get(d);
  if (hit) return hit;
  const out = d.points.map((q) => {
    const cells: Array<[number, number]> = [];
    for (const r of q.b) {
      const { v } = cellOf(r, d.side, d.lev);
      if (v > 0) cells.push([r[0] * q.st, v]);
    }
    if (!cells.length || !(q.p > 0)) return null;
    cells.sort((a, b) => a[0] - b[0]);
    return levelWindow(cells, q.st, q.p);
  });
  windows.set(d, out);
  return out;
}
const windows = new WeakMap<HeatData, Array<[number, number] | null>>();

/** Per bar: the window of the snapshot in force, for the price axis to take in (`fit` only). */
export function fitRanges(list: readonly KLineData[], d: HeatData | null | undefined): Array<{ lo?: number; hi?: number }> {
  if (!d?.fit || !d.points.length) return list.map(() => ({}));
  const w = windowsOf(d);
  const times = d.points.map((q) => q.t);
  const barMs = barMsOf(list);
  return list.map((k) => {
    const i = snapshotFor(times, k.timestamp, barMs);
    const x = i >= 0 ? w[i] : null;
    return x ? { lo: x[0], hi: x[1] } : {};
  });
}

/**
 * A layer's data as the chart holds it: in a function. klinecharts' overrideIndicator (and
 * createIndicator) DEEP-MERGES an object `extendData` into the one held, array by array: new
 * snapshots of fewer cells than the old kept the old cells past their end, coloured by the new
 * scale - one wallet's $12 scale over every wallet's cells painted the whole range in the top
 * colour (owner 2026-10-31, the wallet filter). It also deep-copied 30 days of snapshots on
 * every update. A function is neither merged nor copied: the layer reads exactly what was handed.
 */
export type Boxed<T> = () => T;
export const boxed = <T,>(v: T): Boxed<T> => () => v;
export const unboxed = <T,>(x: unknown): T | null => (typeof x === 'function' ? (x as Boxed<T>)() : null);

/** The strip of the levels now: this wide at most. */
export const stripWidth = (paneWidth: number): number => Math.min(220, paneWidth * 0.2);
/** The chart view's profile: this wide at most (its SVG drew 130-240 px, 28% of the width). */
export const profileWidth = (paneWidth: number): number => Math.min(240, Math.max(Math.min(130, paneWidth * 0.4), paneWidth * 0.28));

export const liqHeatTemplate: IndicatorTemplate<{ lo?: number; hi?: number }, unknown, Boxed<HeatData>> = {
  name: LIQ_HEAT,
  shortName: 'Liq. heatmap',
  series: 'price',
  // Under the candles: the cells are a backdrop the price moves through.
  zLevel: -1,
  // Read by the chart's price axis only (the axis fits every figure's values); never drawn:
  // draw() below returns true, which skips the library's own figures.
  figures: [{ key: 'lo' }, { key: 'hi' }],
  calc: (list, indicator) => fitRanges(list, unboxed<HeatData>(indicator.extendData)),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const data = unboxed<HeatData>(indicator.extendData);
    if (!data) return true;
    const list = chart.getDataList();
    if (data.points.length && list.length) {
      const range = chart.getVisibleRange();
      const bar = chart.getBarSpace();
      const barMs = barMsOf(list);
      const times = data.points.map((q) => q.t);
      const side = data.side ?? 'both';
      const lev = data.lev ?? LEV_BANDS;
      const byLev = data.colorBy === 'lev';
      const scale = data.scale || 1;
      const w = Math.max(1, bar.bar + bar.gapBar);
      const ref = data.ref ?? refStep(data.points);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      // Whole pixels, edge to edge: cells at fractional x / y with translucent colours left a darker
      // seam between every two columns (anti-aliased edges that do not add up to full cover) - the
      // "vertical stripes" at every zoom (owner 2026-10-31). A column's edges are the midpoints
      // between candle centres, rounded, so neighbours share one edge; the candles of one snapshot
      // are one block (a 15-minute snapshot spans fifteen 1m candles).
      const from = Math.max(0, range.realFrom);
      const to = Math.min(list.length, range.realTo);
      const cx = (i: number) => xAxis.convertTimestampToPixel(list[i]!.timestamp);
      const edge = (i: number) => Math.round(i <= from ? cx(from) - w / 2 : i >= to ? cx(to - 1) + w / 2 : (cx(i - 1) + cx(i)) / 2);
      for (let i = from; i < to;) {
        const at = snapshotFor(times, list[i]!.timestamp, barMs);
        let j = i + 1;
        while (j < to && snapshotFor(times, list[j]!.timestamp, barMs) === at) j++;
        if (at >= 0) {
          const q = data.points[at]!;
          const x0 = edge(i);
          const x1 = edge(j);
          // A cell thinner than a pixel shares its row with others: the strongest of them is drawn
          // (pixelCells), so the fine tiles pooled to the pixel draw what every cell would.
          for (const c of pixelCells(cellsOf(q), side, lev, ref, scale, (p) => Math.round(yAxis.convertToPixel(p)))) {
            if (c.bot < 0 || c.top > bounding.height) continue;
            const col = byLev ? levHeatColor(c.v, c.bands) : heatColor(c.v);
            if (!col) continue;
            ctx.fillStyle = col;
            ctx.fillRect(x0, c.top, Math.max(1, x1 - x0), Math.max(1, c.bot - c.top));
          }
        }
        i = j;
      }
      ctx.restore();
    }
    if (data.strip) {
      // The chart view's profile steps back under the candles (they are the same red and green), as its SVG did.
      if (data.profile) drawProfile(ctx, bounding, yAxis, data.strip, { maxW: profileWidth(bounding.width), alpha: 0.5, cum: true });
      else drawProfile(ctx, bounding, yAxis, data.strip, { maxW: stripWidth(bounding.width), alpha: 0.9, backdrop: true });
    }
    // Nothing of the library's own (the figures are for the axis): true says the drawing is done.
    return true;
  },
};
