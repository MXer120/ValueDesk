/**
 * The liquidation layers' leverage and scales, without React (the tests run them in node).
 *
 * LEVERAGE (owner 2026-10-31: "switch from by side to by leverage ... filter view of high,
 * middle and low leverage"). The bands are the server's (valuedesk/liquidations/math.ts
 * levBand): Low up to 5x, Mid over 5x to 20x, High over 20x - a position's distance to its
 * liquidation is about 1/leverage, so roughly 18%+, 4-18% and under 4% away. Each row carries
 * the USD per band after its counts (server levels.ts LiqRow, SnapRow); what a side's bands
 * leave of it is of unknown leverage - a row from an indexer before the bands, or a position
 * whose margin is not known. A filter shows the bands it names; unknown leverage only shows
 * with every band on (it cannot be told to be in any one of them).
 *
 * SCALES (owner 2026-10-31: a single huge wallet must not flatten the map). Bars and cells
 * are scaled to robustMax, not to the largest value: one level many times the rest (SoDEX
 * BTC: two mirrored accounts of ~$70M each, every other level under $0.3M) is drawn at full
 * and its figure told on hover, and the rest stays readable.
 */

export type LevBand = 'low' | 'mid' | 'high';
export const LEV_BANDS: readonly LevBand[] = ['low', 'mid', 'high'];
export type LevKey = LevBand | 'unknown';
export const LEV_LABEL: Record<LevKey, string> = { low: 'Low ≤5×', mid: 'Mid 5–20×', high: 'High >20×', unknown: 'Leverage unknown' };
/** Ordinal, so a mixed cell reads between its bands: blue (far), amber, rose (close); grey not known. */
export const LEV_COLOR: Record<LevKey, string> = { low: '#3d8bfd', mid: '#f0b429', high: '#ec4d7f', unknown: '#7d8590' };
const RGB: Record<LevKey, [number, number, number]> = { low: [61, 139, 253], mid: [240, 180, 41], high: [236, 77, 127], unknown: [125, 133, 144] };
/** The thresholds (server math.ts LEV_LOW_MAX, LEV_MID_MAX). */
export const LEV_LOW_MAX = 5;
export const LEV_MID_MAX = 20;

export type ColorBy = 'side' | 'lev';
/** The bands shown; all three is no filter. */
export type LevFilter = readonly LevBand[];

/** A stored filter made sane: known bands, each once, in order; none at all means all. */
export function levFilterOf(x: unknown): LevBand[] {
  const set = new Set(Array.isArray(x) ? x : []);
  const out = LEV_BANDS.filter((b) => set.has(b));
  return out.length ? out : [...LEV_BANDS];
}
export const isAllLev = (f: LevFilter): boolean => LEV_BANDS.every((b) => f.includes(b));

/** A leverage's band (null: not known). */
export function levBandOf(lev: number | null | undefined): LevBand | null {
  if (lev == null || !(lev > 0)) return null;
  return lev <= LEV_LOW_MAX ? 'low' : lev <= LEV_MID_MAX ? 'mid' : 'high';
}

/** USD by band: [low, mid, high, unknown]. */
export type Bands = [number, number, number, number];

/**
 * One side of a row by band. `total` is the side's USD, `at` where its three bands begin in
 * the row (LiqRow: long 5, short 8; SnapRow: long 3, short 6). The rest is unknown, less the
 * dollar each venue's figures were rounded to apart.
 */
export function sideBands(total: number, row: ArrayLike<number>, at: number): Bands {
  const lo = row[at] ?? 0;
  const mid = row[at + 1] ?? 0;
  const hi = row[at + 2] ?? 0;
  let unk = total - lo - mid - hi;
  if (unk <= Math.max(25, total * 1e-4)) unk = 0;
  return [lo, mid, hi, unk];
}

/** What a filter shows of a side's bands: the bands named; unknown only with all three. */
export function shownBands(b: Bands, f: LevFilter): Bands {
  if (isAllLev(f)) return b;
  return [f.includes('low') ? b[0] : 0, f.includes('mid') ? b[1] : 0, f.includes('high') ? b[2] : 0, 0];
}

/** The total a side shows under a filter: all of it with every band on, else its bands named. */
export function shownTotal(total: number, b: Bands, f: LevFilter): number {
  if (isAllLev(f)) return total;
  const s = shownBands(b, f);
  return s[0] + s[1] + s[2];
}

export const addBands = (a: Bands, b: Bands): Bands => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];

/**
 * A cell's colour by its leverage mix: its USD-weighted place on low - mid - high, greyed by the
 * share of unknown leverage. [r, g, b], or null when it holds nothing.
 */
export function levRgb(b: Bands): [number, number, number] | null {
  const known = b[0] + b[1] + b[2];
  const all = known + b[3];
  if (!(all > 0)) return null;
  let c: [number, number, number] = RGB.unknown;
  if (known > 0) {
    const t = (b[1] * 0.5 + b[2]) / known;
    const [x, y, k] = t <= 0.5 ? [RGB.low, RGB.mid, t / 0.5] : [RGB.mid, RGB.high, (t - 0.5) / 0.5];
    c = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  }
  const u = b[3] / all;
  const g = RGB.unknown;
  return [Math.round(c[0] + (g[0] - c[0]) * u), Math.round(c[1] + (g[1] - c[1]) * u), Math.round(c[2] + (g[2] - c[2]) * u)];
}

/**
 * The value bars and cells are scaled to: the `q` quantile of the non-zero values, raised to the
 * largest value within `ratio` of it - so an ordinary peak still reaches full (no clipping where
 * the tail is only a tail), while a value far past every other is drawn at full and the scale
 * stays with the rest. At least `keep` values are always above the quantile taken: a single
 * level, or a mirrored pair (SoDEX BTC's two $70M accounts), never sets it. Under 5 values: the
 * largest.
 *
 * Checked on production 2026-10-31 (BTC, $100 bars): every venue, max $316M -> scale $316M (no
 * clipping); SoDEX alone, max $78M and the next $0.08M -> scale $0.08M.
 */
export function robustMax(values: Iterable<number>, o: { q?: number; ratio?: number; keep?: number } = {}): number {
  const q = o.q ?? 0.99;
  const ratio = o.ratio ?? 8;
  const keep = o.keep ?? 2;
  const v: number[] = [];
  for (const x of values) if (x > 0 && Number.isFinite(x)) v.push(x);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  const n = v.length;
  if (n < 5) return v[n - 1]!;
  const ref = v[Math.max(0, Math.min(Math.floor((n - 1) * q), n - 1 - keep))]!;
  let s = ref;
  for (let i = n - 1; i >= 0; i--) if (v[i]! <= ref * ratio) { s = v[i]!; break; }
  return s;
}

/**
 * The price window the levels fill (the live view's, and the historical view's price axis):
 * from the lowest to the highest level once the thinnest 0.5% of the notional each side is left
 * out (one far order does not stretch it), always 10% either side of the price, never past 0.4x
 * or 1.8x of it, with 2% to spare. `cells`: [low price, notional], sorted by price.
 */
export function levelWindow(cells: ReadonlyArray<readonly [number, number]>, step: number, p: number): [number, number] {
  let lo = p;
  let hi = p;
  let total = 0;
  for (const c of cells) total += c[1];
  let acc = 0;
  for (const c of cells) {
    acc += c[1];
    if (acc >= total * 0.005 && acc > 0) { lo = Math.min(lo, c[0]); break; }
  }
  acc = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    acc += c[1];
    if (acc >= total * 0.005 && acc > 0) { hi = Math.max(hi, c[0] + step); break; }
  }
  lo = Math.max(p * 0.4, Math.min(lo, p * 0.9));
  hi = Math.min(p * 1.8, Math.max(hi, p * 1.1));
  const pad = (hi - lo) * 0.02;
  return [lo - pad, hi + pad];
}
