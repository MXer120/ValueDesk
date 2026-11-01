/**
 * The levels now drawn as a profile on a candle pane (no React, no klinecharts state): the
 * Liquidation map indicator (liqMap.ts) and the historical view's strip of the levels now
 * (liqHeatIndicator.ts) draw with the same code, so they read the same.
 */
import { LEV_COLOR, robustMax, type Bands, type ColorBy } from './liqLev';

/**
 * The levels now: bucket width, and per bucket [low price, long USD, short USD] - levels the
 * price has crossed left out, and only the leverage bands the filter shows. `bands` (aligned
 * with `rows`): both sides' USD by band, drawn stacked when `colorBy` is 'lev'.
 */
export interface LiqMapData {
  price: number;
  step: number;
  rows: Array<[number, number, number]>;
  bands?: Bands[];
  colorBy?: ColorBy;
  /**
   * The cumulative curves (the chart view): everything liquidated as the price falls to each
   * level (longs, [price, sum] from the price down) and as it rises (shorts, from the price up).
   */
  cum?: { long: Array<[number, number]>; short: Array<[number, number]> } | null;
}

/** A CSS colour token of the page (canvas needs the value), read once. */
const tokens = new Map<string, string>();
function token(name: string, fallback: string): string {
  let v = tokens.get(name);
  if (v === undefined) {
    v = (typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '') || fallback;
    tokens.set(name, v);
  }
  return v;
}

const LEV_KEYS = ['low', 'mid', 'high', 'unknown'] as const;

/**
 * The levels now as bars growing left from the right edge of a pane, `maxW` long at most: the
 * Liquidation map indicator, and the historical view's strip (`backdrop`: labelled "Levels now", drawn
 * straight over the cells). By side the longs (red) and shorts (green) overlap; by leverage a
 * bar is both sides stacked by band. The lengths are scaled to the rows on screen (their middle
 * inside the pane) by robustMax: a level far past the rest is drawn full, with a tick at its end,
 * and the rest keep their length.
 */
export function drawProfile(
  ctx: CanvasRenderingContext2D,
  bounding: { width: number; height: number },
  yAxis: { convertToPixel: (v: number) => number },
  d: LiqMapData,
  o: { maxW: number; alpha: number; backdrop?: boolean; cum?: boolean },
): void {
  if (!d.rows.length) return;
  if (o.cum && d.cum) drawCum(ctx, bounding, yAxis, d, o.maxW);
  const lev = d.colorBy === 'lev' && !!d.bands;
  const shown: Array<[number, number, number, number, number]> = [];
  const vals: number[] = [];
  d.rows.forEach(([lo, l, s], k) => {
    const top = yAxis.convertToPixel(lo + d.step);
    const bot = yAxis.convertToPixel(lo);
    if (bot < 0 || top > bounding.height) return;
    shown.push([top, bot, l, s, k]);
    const mid = (top + bot) / 2;
    if (mid >= 0 && mid <= bounding.height) vals.push(lev ? l + s : Math.max(l, s));
  });
  const max = robustMax(vals);
  if (!(max > 0)) return;
  const W = o.maxW;
  const x0 = bounding.width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  // Its name only: no panel behind it - the bars lie on the chart itself (owner 2026-10-31: a dark panel
  // covered the newest candles and the heat).
  if (o.backdrop) {
    ctx.fillStyle = token('--muted', '#9aa0a6');
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Levels now', x0 - 6, 12);
  }
  ctx.globalAlpha = o.alpha;
  const long = token('--neg', '#f6465d');
  const short = token('--pos', '#2ebd85');
  const tick = token('--text', '#e6e6e6');
  const len = (v: number) => Math.max(1, Math.min(1, v / max) * W);
  for (const [top, bot, l, s, k] of shown) {
    const h = Math.max(1, bot - top > 3 ? bot - top - 1 : bot - top);
    if (lev) {
      const b = d.bands![k]!;
      const total = l + s;
      if (!(total > 0)) continue;
      // Stacked from the edge: low, mid, high, then unknown; the whole bar as long as its total.
      const full = len(total);
      let x = x0;
      const sum = b[0] + b[1] + b[2] + b[3] || total;
      LEV_KEYS.forEach((key, i) => {
        const w = (b[i]! / sum) * full;
        if (!(w > 0)) return;
        ctx.fillStyle = LEV_COLOR[key];
        ctx.fillRect(x - w, top, w, h);
        x -= w;
      });
      if (total > max) { ctx.fillStyle = tick; ctx.fillRect(x0 - full, top, 2, h); }
    } else {
      for (const [v, col] of [[l, long], [s, short]] as const) {
        if (!(v > 0)) continue;
        const w = len(v);
        ctx.fillStyle = col;
        ctx.fillRect(x0 - w, top, w, h);
        if (v > max) { ctx.fillStyle = tick; ctx.fillRect(x0 - w, top, 2, h); }
      }
    }
  }
  ctx.restore();
}


/**
 * The cumulative curves behind the bars, growing left from the right edge as they do: a step line
 * and a light area per side from the price outward, scaled to the largest sum on screen.
 */
function drawCum(
  ctx: CanvasRenderingContext2D,
  bounding: { width: number; height: number },
  yAxis: { convertToPixel: (v: number) => number },
  d: LiqMapData,
  maxW: number,
): void {
  const c = d.cum!;
  const x0 = bounding.width;
  const yp = yAxis.convertToPixel(d.price);
  const inView = (pts: Array<[number, number]>) => pts.filter(([v]) => { const y = yAxis.convertToPixel(v); return y >= -bounding.height && y <= bounding.height * 2; });
  const sides = [[inView(c.long), token('--neg', '#f6465d')], [inView(c.short), token('--pos', '#2ebd85')]] as const;
  let max = 0;
  for (const [pts] of sides) for (const [v, sum] of pts) { const y = yAxis.convertToPixel(v); if (y >= 0 && y <= bounding.height) max = Math.max(max, sum); }
  if (!(max > 0)) return;
  const xOf = (sum: number) => x0 - Math.min(1, sum / max) * (maxW - 8);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  ctx.lineWidth = 1.25;
  for (const [pts, col] of sides) {
    if (!pts.length) continue;
    ctx.beginPath();
    ctx.moveTo(x0, yp);
    // A step line: along the price to each level, then out to its sum.
    let x = x0;
    for (const [v, sum] of pts) {
      const y = yAxis.convertToPixel(v);
      ctx.lineTo(x, y);
      x = xOf(sum);
      ctx.lineTo(x, y);
    }
    const yEnd = yAxis.convertToPixel(pts.at(-1)![0]);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.lineTo(x0, yEnd);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.08;
    ctx.fill();
  }
  ctx.restore();
}
