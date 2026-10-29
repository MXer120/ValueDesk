/**
 * The liquidation layers' shared rules, without React (the tests run them in node): a market's
 * coin, the heatmap widget's bar sizes (fine, medium, coarse: a fixed share of the price), and
 * the Liquidation map indicator - the levels now as bars along the price scale, growing left
 * from it, longs (red) below the price and shorts (green) above. The chart feeds it and the
 * Liquidation heatmap layer (liqHeatIndicator.ts) in liqIndicators.tsx.
 */
import type { IndicatorTemplate } from 'klinecharts';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import type { Res } from '../components/liqmap/WalletView';
import { LIQ_HEAT } from './liqHeatIndicator';

export const LIQ_MAP = 'VS_LIQMAP';
/** The indicators of ours that need a perps market and the indexer's data. */
export const LIQ_INDICATORS: ReadonlySet<string> = new Set([LIQ_HEAT, LIQ_MAP]);

/** A market's coin, as the server nets it (cohorts/model.ts coinOf): `BTC-USD` -> BTC, `vETH_vUSDC` -> ETH, `xyz:TSLA` -> TSLA. */
export function coinOfSymbol(symbol: string): string {
  const tail = symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : symbol;
  const head = tail.split(/[-/_]/)[0] ?? tail;
  return head.replace(/^v(?=[A-Z])/, '').toUpperCase();
}

/**
 * Each resolution's bar as a share of the price. Fixed: zooming and panning change how wide a
 * bar is drawn, never how much of the price it holds (owner, 2026-10-29: fine, medium and coarse
 * "shouldn't change granularity when scrolling in and out"). The same in the live and the chart view.
 */
export const RES_PCT: Record<Res, number> = { fine: 0.001, medium: 0.0025, coarse: 0.005 };
/** Multiples of the server's bucket a bar may span: the widths stay round numbers. */
const MULTIPLES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * How many server buckets (`step` wide) make one bar at `price`: the first round multiple that
 * holds the resolution's share - and each resolution at least one multiple wider than the one
 * before, so Medium and Coarse never come out the same where the multiples jump (10 to 25).
 */
export function groupFor(step: number, price: number, res: Res): number {
  const last = MULTIPLES.length - 1;
  const first = (r: Res) => {
    const i = MULTIPLES.findIndex((k) => step * k >= price * RES_PCT[r] * (1 - 1e-9));
    return i < 0 ? last : i;
  };
  let i = first('fine');
  if (res !== 'fine') i = Math.min(last, Math.max(first('medium'), i + 1));
  if (res === 'coarse') i = Math.min(last, Math.max(first('coarse'), i + 1));
  return MULTIPLES[i]!;
}

/** The levels now: bucket width, and per bucket [low price, long USD, short USD] - levels the price has crossed left out. */
export interface LiqMapData {
  price: number;
  step: number;
  rows: Array<[number, number, number]>;
}

/** The levels now for the map, in the heatmap's Fine bars: fixed, as there, whatever the zoom or the timeframe. */
export function mapData(a: HeatApi | null | undefined): LiqMapData | null {
  if (!a?.price || !(a.step > 0)) return null;
  const p = a.price;
  const st = +(a.step * groupFor(a.step, p, 'fine')).toPrecision(12);
  const by = new Map<number, [number, number]>();
  for (const [i, l0, s0] of a.buckets) {
    const lo = i * a.step;
    const l = lo >= p ? 0 : l0;
    const s = lo + a.step <= p ? 0 : s0;
    if (!l && !s) continue;
    const j = Math.floor(lo / st + 1e-9);
    const x = by.get(j) ?? [0, 0];
    x[0] += l;
    x[1] += s;
    by.set(j, x);
  }
  return { price: p, step: st, rows: [...by].map(([j, [l, s]]) => [+(j * st).toPrecision(12), l, s]) };
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

export const liqMapTemplate: IndicatorTemplate<unknown, unknown, LiqMapData | null> = {
  name: LIQ_MAP,
  shortName: 'Liq. map',
  series: 'price',
  // Under the candles, as the heatmap's cells are.
  zLevel: -1,
  figures: [],
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, indicator, bounding, yAxis }) => {
    const d = indicator.extendData;
    if (!d?.rows.length) return true;
    const maxW = Math.min(260, bounding.width * 0.24);
    const shown: Array<[number, number, number, number]> = [];
    let max = 0;
    for (const [lo, l, s] of d.rows) {
      const top = yAxis.convertToPixel(lo + d.step);
      const bot = yAxis.convertToPixel(lo);
      if (bot < 0 || top > bounding.height) continue;
      shown.push([top, bot, l, s]);
      // The widths are scaled to the rows on screen (their middle inside the pane), not to one far off.
      const mid = (top + bot) / 2;
      if (mid >= 0 && mid <= bounding.height) max = Math.max(max, l, s);
    }
    if (!(max > 0)) return true;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, bounding.width, bounding.height);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    const long = token('--neg', '#f6465d');
    const short = token('--pos', '#2ebd85');
    for (const [top, bot, l, s] of shown) {
      const h = Math.max(1, bot - top > 3 ? bot - top - 1 : bot - top);
      for (const [v, col] of [[l, long], [s, short]] as const) {
        if (!(v > 0)) continue;
        const w = Math.max(1, (v / max) * maxW);
        ctx.fillStyle = col;
        ctx.fillRect(bounding.width - w, top, w, h);
      }
    }
    ctx.restore();
    return true;
  },
};
