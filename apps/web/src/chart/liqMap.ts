/**
 * The liquidation layers' shared rules, without React (the tests run them in node): a market's
 * coin, the heatmap widget's bar sizes (fine, medium, coarse: a fixed share of the price), and
 * the Liquidation map indicator - the levels now as bars along the price scale, growing left
 * from it, longs (red) below the price and shorts (green) above. The chart feeds it and the
 * Liquidation heatmap layer (liqHeatIndicator.ts) in liqIndicators.tsx.
 */
import type { IndicatorTemplate } from 'klinecharts';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import { LIQ_HEAT, unboxed, type Boxed } from './liqHeatIndicator';
import { groupFor } from '@sign/valuedesk/liquidations/bars.js';
import { LEV_BANDS, addBands, shownBands, shownTotal, sideBands, type Bands, type ColorBy, type LevFilter } from './liqLev';
import { drawProfile, type LiqMapData } from './liqProfile';

export type { LiqMapData };

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
 * Each resolution's bar as a share of the price, and how many server buckets make one bar
 * (groupFor). Fixed: zooming and panning change how wide a bar is drawn, never how much of the
 * price it holds (owner, 2026-10-29: fine, medium and coarse "shouldn't change granularity when
 * scrolling in and out"). The same in the live and the chart view - and on the server, which sums
 * the trade chart's map to the Fine bar itself (server valuedesk/liquidations/bars.ts: one rule).
 */
export { RES_PCT, groupFor } from '@sign/valuedesk/liquidations/bars.js';

/**
 * The levels now for the map, in the heatmap's Fine bars: fixed, as there, whatever the zoom or
 * the timeframe. `o`: which side, which leverage bands, coloured how (the historical view's strip).
 */
export function mapData(a: HeatApi | null | undefined, o: { side?: 'both' | 'long' | 'short'; lev?: LevFilter; colorBy?: ColorBy } = {}): LiqMapData | null {
  if (!a?.price || !(a.step > 0)) return null;
  const p = a.price;
  const lev = o.lev ?? LEV_BANDS;
  const side = o.side ?? 'both';
  const st = +(a.step * groupFor(a.step, p, 'fine')).toPrecision(12);
  const by = new Map<number, { l: number; s: number; b: Bands }>();
  for (const r of a.buckets) {
    const lo = r[0] * a.step;
    const l0 = lo >= p || side === 'short' ? 0 : r[1];
    const s0 = lo + a.step <= p || side === 'long' ? 0 : r[2];
    if (!l0 && !s0) continue;
    const lb = l0 ? sideBands(l0, r, 5) : NONE;
    const sb = s0 ? sideBands(s0, r, 8) : NONE;
    const l = shownTotal(l0, lb, lev);
    const s = shownTotal(s0, sb, lev);
    if (!l && !s) continue;
    const j = Math.floor(lo / st + 1e-9);
    const x = by.get(j) ?? { l: 0, s: 0, b: [0, 0, 0, 0] as Bands };
    x.l += l;
    x.s += s;
    x.b = addBands(x.b, addBands(shownBands(lb, lev), shownBands(sb, lev)));
    by.set(j, x);
  }
  const keys = [...by.keys()].sort((x, y) => x - y);
  return {
    price: p, step: st,
    rows: keys.map((j) => { const x = by.get(j)!; return [+(j * st).toPrecision(12), x.l, x.s]; }),
    bands: keys.map((j) => by.get(j)!.b),
    colorBy: o.colorBy ?? 'side',
  };
}
const NONE: Bands = [0, 0, 0, 0];

export const liqMapTemplate: IndicatorTemplate<unknown, unknown, Boxed<LiqMapData | null>> = {
  name: LIQ_MAP,
  shortName: 'Liq. map',
  series: 'price',
  // Under the candles, as the heatmap's cells are.
  zLevel: -1,
  figures: [],
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, indicator, bounding, yAxis }) => {
    const d = unboxed<LiqMapData>(indicator.extendData);
    if (d) drawProfile(ctx, bounding, yAxis, d, { maxW: Math.min(260, bounding.width * 0.24), alpha: 0.5 });
    return true;
  },
};
