/**
 * klinecharts' numbers in the app's number format (numStyle.ts).
 *
 * klinecharts 10 has no decimal-sign option: every figure it paints (price
 * axis, crosshair tag, last-price mark, high/low marks, built-in overlays and
 * our own drawing readouts) goes through
 * `decimalFold.format(thousandsSeparator.format(enUsText))`, where the inner
 * text is a plain machine number ("1234.5", "1.28K"). So the thousands
 * separator's `format` is replaced by one that groups in en-US and then
 * `localize`s - the one place both separators are chosen - and the decimal
 * fold ("0.0{4}12") accepts either mark. Both read the setting at call time,
 * so a change needs only a redraw (`followNumStyle`).
 *
 * `localize` is not idempotent ("1.234,5" would flip back), so nothing that is
 * already localized may be passed through `thousandsSeparator.format` again.
 */
import type { Chart as KChart, DecimalFold, ThousandsSeparator } from 'klinecharts';
import { getNumSeps, localize, subscribeNumStyle } from '../numStyle';

/** A machine number text ("-1234.5", "1.28K", "1,234.5") grouped and in the chosen format. */
export function groupLocalized(value: string | number): string {
  const s = String(value);
  if (s.includes(',')) return localize(s);
  const dot = s.indexOf('.');
  const head = dot === -1 ? s : s.slice(0, dot);
  const tail = dot === -1 ? '' : s.slice(dot);
  return localize(`${head.replace(/(\d)(?=(\d{3})+$)/g, '$1,')}${tail}`);
}

/** The library's decimal fold, for either decimal mark ("0,0000012" -> "0,0{5}12"). */
export function foldDecimal(value: string | number, threshold = 3): string {
  const s = String(value);
  // A grouping segment is exactly three digits, so it can never match: the fold
  // needs `threshold` (>= 3) zeros AND a non-zero digit after the mark.
  const m = new RegExp(`([.,])(0{${threshold},})([1-9]\\d*)$`).exec(s);
  if (!m) return s;
  return `${s.slice(0, m.index)}${m[1]}0{${m[2]!.length}}${m[3]}`;
}

export const thousandsSeparatorOption = (): Partial<ThousandsSeparator> => ({
  sign: getNumSeps().group,
  format: groupLocalized,
});

export const decimalFoldOption = (threshold = 3): Partial<DecimalFold> => ({
  threshold,
  format: (v) => foldDecimal(v, threshold),
});

/**
 * Re-apply (and so redraw) when the format changes. Returns the unsubscribe.
 * `setThousandsSeparator` goes through the chart's option path, which rebuilds
 * the axis ticks and repaints. `sign` is for a chart that keeps the library's
 * grouping off (the data charts print their caller's own format): it is
 * restated as is, only for the repaint.
 */
export function followNumStyle(chart: KChart, sign: () => string = () => getNumSeps().group): () => void {
  return subscribeNumStyle(() => chart.setThousandsSeparator({ sign: sign() }));
}
