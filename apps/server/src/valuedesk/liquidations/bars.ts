/**
 * The heatmap's bar widths, one rule for the server and the web (web chart/liqMap.ts re-exports groupFor): a bar is a
 * round multiple of the engine's bucket that holds a fixed share of the price (owner, 2026-10-29: fine, medium and
 * coarse "shouldn't change granularity when scrolling in and out"), and the buckets summed to it.
 *
 * The trade chart's Liquidation map draws the levels now at the Fine bar (BTC $100) and polled the engine's 0.02%
 * buckets ($20) every 30 s: 5,494 BTC buckets, 49.5 KB br5 an answer, where the map draws 1,787 (19.6 KB). `bar=fine`
 * on /api/vs/liquidations sends them summed to the bar (barHeatmap), the same bars the map summed itself.
 */
import { addRow, type LiqRow } from './levels.js';

export type BarRes = 'fine' | 'medium' | 'coarse';
/** Each resolution's bar as a share of the price. */
export const RES_PCT: Record<BarRes, number> = { fine: 0.001, medium: 0.0025, coarse: 0.005 };
/** Multiples of the engine's bucket a bar may span (the live socket's widths too: routes/liqWs.ts). */
export const BAR_MULTIPLES: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const isBarRes = (x: unknown): x is BarRes => x === 'fine' || x === 'medium' || x === 'coarse';

/**
 * How many engine buckets (`step` wide) make one bar at `price`: the first round multiple that holds the resolution's
 * share - and each resolution at least one multiple wider than the one before, so Medium and Coarse never come out the
 * same where the multiples jump (10 to 25).
 */
export function groupFor(step: number, price: number, res: BarRes): number {
  const last = BAR_MULTIPLES.length - 1;
  const first = (r: BarRes) => {
    const i = BAR_MULTIPLES.findIndex((k) => step * k >= price * RES_PCT[r] * (1 - 1e-9));
    return i < 0 ? last : i;
  };
  let i = first('fine');
  if (res !== 'fine') i = Math.min(last, Math.max(first('medium'), i + 1));
  if (res === 'coarse') i = Math.min(last, Math.max(first('coarse'), i + 1));
  return BAR_MULTIPLES[i]!;
}

/** Buckets summed k at a time: LiqRows at index i / k, bands and all. */
export function aggregate(rows: ReadonlyArray<LiqRow>, k: number): LiqRow[] {
  if (k <= 1) return rows.slice();
  const by = new Map<number, LiqRow>();
  for (const r of rows) {
    const j = Math.floor(r[0] / k);
    const x = by.get(j);
    if (x) addRow(x, r); else { const y = r.slice() as LiqRow; y[0] = j; by.set(j, y); }
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}

/** A LiqRow's long fields (USD, count, the USD per band) and its short ones (levels.ts LiqRow, rowBand). */
const LONG_AT = [1, 3, 5, 6, 7];
const SHORT_AT = [2, 4, 8, 9, 10];

/**
 * A heatmap answer summed to the `res` bar at its own price (groupFor), with the levels the price has crossed left out
 * first, each at its own engine bucket - as the web's map leaves them out (liqMap.ts mapData: a long from a bucket at or
 * above the price, a short from one at or below it) - so the map draws exactly the bars it drew from the buckets. A
 * bucket's rows are whole dollars (levels.ts), so the sums do not depend on their order. No price: as it is.
 */
export function barHeatmap<T extends { price: number | null; step: number; buckets: LiqRow[] }>(heat: T, res: BarRes): T & { bar: BarRes } {
  const p = heat.price;
  if (!p || !(heat.step > 0)) return { ...heat, bar: res };
  const k = groupFor(heat.step, p, res);
  const kept: LiqRow[] = [];
  for (const r of heat.buckets) {
    const lo = r[0] * heat.step;
    const pastL = lo >= p;
    const pastS = lo + heat.step <= p;
    if (!pastL && !pastS) { kept.push(r); continue; }
    if (pastL && pastS) continue;
    const y = r.slice() as LiqRow;
    for (const at of pastL ? LONG_AT : SHORT_AT) if (at < y.length) y[at] = 0;
    if (y[1] || y[2]) kept.push(y);
  }
  return { ...heat, step: +(heat.step * k).toPrecision(12), buckets: aggregate(kept, k), bar: res };
}
