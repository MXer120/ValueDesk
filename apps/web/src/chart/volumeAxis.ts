/**
 * The volume pane's scale, read the way SoDEX's own chart reads it.
 *
 * The numbers were never the problem - the pane plots the gateway's `v`, the
 * base-asset volume, exactly as sodex.com does (checked bar for bar on BTC-USD
 * 5m and 1D, REST and the live stream alike). The SCALE was: klinecharts gave
 * the pane its price-style ladder, and our big-number formatter forced two
 * decimals above 1 and four below, so a 1m pane read "1.50 / 0.9000 / 0.3000"
 * and a daily one "3.20K / 800.00", where SoDEX prints "1" and "5K  2.5K".
 * Mixed decimals on one axis read as different units, and an axis that starts
 * at 0.3 reads as one that does not start at zero.
 *
 * So this pane gets round steps (1, 2, 2.5, 5 x 10^n) counted up from zero, at
 * most one label per ~32px, printed compact with no padding zeros: 0.5, 1,
 * 750, 2.5K, 1.2M. Zero itself is not labelled - the bars stand on it.
 */
import type { AxisCreateTicksCallback, AxisTick } from 'klinecharts';
import { localize } from '../numStyle';

/** Round steps inside a decade. */
const LADDER = [1, 2, 2.5, 5];
/** Minimum distance between two labels, px. */
const MIN_PITCH = 32;
/** Labels closer than this to the pane's top edge would be clipped. */
const EDGE = 8;

/** Trim "2.50" -> "2.5", "5.00" -> "5". */
const trim = (s: string): string => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/**
 * A volume as a short number: 0.28465, 696.16, 1.28K, 4.8M, 1.05B.
 *
 * Under a thousand the value keeps up to `decimals` places (trailing zeros
 * dropped) - those digits are real units of the asset, and SoDEX's own legend
 * shows them. From a thousand up it folds to K/M/B with at most two.
 */
export function compactNumber(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}${trim((a / 1e9).toFixed(2))}B`;
  if (a >= 1e6) return `${sign}${trim((a / 1e6).toFixed(2))}M`;
  if (a >= 1e3) return `${sign}${trim((a / 1e3).toFixed(2))}K`;
  return `${sign}${trim(a.toFixed(Math.max(0, decimals)))}`;
}

/** Decimal places a step needs to print exactly (2.5 -> 1, 0.05 -> 2). */
const placesOf = (step: number): number => {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
};

/** The smallest ladder step at least `MIN_PITCH` px tall. */
export function volumeStep(span: number, height: number): number {
  if (!(span > 0) || !(height > 0)) return 0;
  const pxPerUnit = height / span;
  const ideal = MIN_PITCH / pxPerUnit;
  let e = 10 ** Math.floor(Math.log10(ideal));
  for (let guard = 0; guard < 4; guard++, e *= 10) {
    for (const k of LADDER) {
      const step = Number((k * e).toPrecision(12));
      if (step * pxPerUnit >= MIN_PITCH) return step;
    }
  }
  return 0;
}

/** Ticks for a volume pane: 0-based round steps, compact labels. */
export const createVolumeTicks: AxisCreateTicksCallback = ({ range, bounding, defaultTicks }) => {
  const height = bounding.height;
  const { realFrom, realRange } = range;
  if (!(realRange > 0) || !(height > 0)) return defaultTicks;
  const step = volumeStep(realRange, height);
  if (step <= 0) return defaultTicks;
  const places = placesOf(step);
  const ticks: AxisTick[] = [];
  const top = realFrom + realRange;
  for (let k = 1; k * step <= top && ticks.length < 16; k++) {
    const v = Number((k * step).toFixed(places));
    const coord = Math.round((1 - (v - realFrom) / realRange) * height);
    if (coord < EDGE || coord >= height) continue;
    ticks.push({ coord, value: v, text: localize(compactNumber(v, places)) });
  }
  return ticks;
};
