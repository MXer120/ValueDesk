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
 * colour its notional's share of the scale (`scale`, a high percentile of the
 * cells loaded) - dark violet through teal to yellow, transparent below a floor.
 */
import type { IndicatorTemplate, KLineData } from 'klinecharts';

export const LIQ_HEAT = 'VS_LIQHEAT';

/** One snapshot as the history API sends it: time, price, bucket width, [bucket, long USD, short USD]. */
export interface HeatPoint {
  t: number;
  p: number;
  st: number;
  b: Array<[number, number, number, ...number[]]>;
}

export interface HeatData {
  points: HeatPoint[];
  /** The notional a cell must reach to be drawn at full strength. */
  scale: number;
  /** Only longs, only shorts, or both. */
  side?: 'long' | 'short' | 'both';
}

/** A snapshot older than this before a bar's end does not stand for it. */
const STALE_MS = 2 * 60 * 60_000;

const RAMP: ReadonlyArray<[number, number, number]> = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export const HEAT_FLOOR = 0.03;

/** A cell's colour by its share of the scale (null: below the floor, not drawn). */
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

/** The scale: a high percentile of the cells, so one giant cluster does not wash out the rest. */
export function heatScale(points: readonly HeatPoint[], side: HeatData['side'] = 'both'): number {
  const v: number[] = [];
  for (const q of points) for (const [, l, s] of q.b) v.push(side === 'long' ? l : side === 'short' ? s : l + s);
  const nz = v.filter((x) => x > 0).sort((a, b) => a - b);
  if (!nz.length) return 1;
  return nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.985))]! || 1;
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
function barMsOf(list: readonly KLineData[]): number {
  for (let i = list.length - 1; i > 0; i--) {
    const d = list[i]!.timestamp - list[i - 1]!.timestamp;
    if (d > 0) return d;
  }
  return 60_000;
}

export const liqHeatTemplate: IndicatorTemplate<unknown, unknown, HeatData> = {
  name: LIQ_HEAT,
  shortName: 'Liquidations',
  series: 'price',
  // Under the candles: the cells are a backdrop the price moves through.
  zLevel: -1,
  figures: [],
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const data = indicator.extendData;
    if (!data?.points.length) return true;
    const list = chart.getDataList();
    if (!list.length) return true;
    const range = chart.getVisibleRange();
    const bar = chart.getBarSpace();
    const barMs = barMsOf(list);
    const times = data.points.map((q) => q.t);
    const side = data.side ?? 'both';
    const scale = data.scale || 1;
    const w = Math.max(1, bar.bar + bar.gapBar);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, bounding.width, bounding.height);
    ctx.clip();
    for (let i = Math.max(0, range.realFrom); i < Math.min(list.length, range.realTo); i++) {
      const k = list[i]!;
      const at = snapshotFor(times, k.timestamp, barMs);
      if (at < 0) continue;
      const q = data.points[at]!;
      const x = xAxis.convertTimestampToPixel(k.timestamp) - w / 2;
      for (const [bi, l, s] of q.b) {
        const v = side === 'long' ? l : side === 'short' ? s : l + s;
        const col = heatColor(v / scale);
        if (!col) continue;
        const top = yAxis.convertToPixel((bi + 1) * q.st);
        const bot = yAxis.convertToPixel(bi * q.st);
        if (bot < 0 || top > bounding.height) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x, top, w, Math.max(1, bot - top));
      }
    }
    ctx.restore();
    // Nothing of the library's own (no figures): true says the drawing is done.
    return true;
  },
};
