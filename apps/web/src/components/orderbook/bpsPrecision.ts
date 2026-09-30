/**
 * How many decimals the order book prints a spread in basis points with.
 * Pure and DOM-free:  npx tsx --test src/components/orderbook/bpsPrecision.test.ts
 *
 * THE RULE: THREE SIGNIFICANT FIGURES OF THE SMALLEST RECENT READING, CLAMPED
 * TO [1, 4] DECIMALS, WITH A 10% DEAD BAND AT EVERY DECADE EDGE.
 *
 *   decimals = clamp(2 - floor(log10(m)), 1, 4)
 *
 * where `m` is the smallest positive spread (bps) among the readings the mid
 * row's recorder holds - the last minute of 1s averages, which is exactly what
 * the spread chart draws - plus the live reading. That prints 12.3, 1.03,
 * 0.119 and 0.0412, and on this venue's own books (1 tick at the live mid):
 *
 *   BTC-USD  tick 1       @ 83,859  -> 0.119 bps  -> 3 dp  "0.119"
 *   ETH-USD  tick 0.1     @ 2,687.5 -> 0.372 bps  -> 3 dp  "0.372"
 *   SOL-USD  tick 0.01    @ 121.2   -> 0.825 bps  -> 3 dp  "0.825"
 *   DOGE-USD tick 0.00001 @ 0.09708 -> 1.03 bps   -> 2 dp  "1.03"
 *
 * WHY THE VALUE AND NOT THE TICK QUANTUM. The owner asked for decimals that
 * "adapt depending on value". A rule derived only from the 1-tick quantum
 * (tick / mid x 10^4) cannot do that: an illiquid market quoting 25 bps wide
 * on a 0.5 bps tick would print "25.000". Three significant figures of the
 * smallest recent reading answers the quantum's question too: the spread is a
 * whole number of ticks, so the smallest reading is at least one quantum, and
 * its third significant digit is at most a hundredth of it - consecutive tick
 * steps, and the 1s averages the chart draws between them, always print
 * differently (up to spreads of ~100 ticks, where single ticks stop mattering).
 * Every reading in the window then prints with the SAME decimals, so the
 * readout and the chart's tooltip never disagree about precision.
 *
 * WHY THE SMALLEST RECENT READING, NOT THE CURRENT ONE. A book that alternates
 * between one and two ticks - the normal state of a liquid market - would flip
 * decimals on every tick whenever one tick sits just under a decade edge
 * (0.09 / 0.18 bps). The minimum over the recorder's window moves slowly, and
 * the dead band stops a minimum that hovers ON an edge (SOL at a mid of 100.0
 * is exactly 1 tick = 0.1 bps) from toggling as the mid drifts across it.
 */

export const BPS_MIN_DECIMALS = 1;
export const BPS_MAX_DECIMALS = 4;
/** Significant figures the smallest recent reading is printed to. */
export const BPS_SIG_FIGS = 3;
/** Dead band at each decade edge, as a fraction of the edge. */
export const BPS_HYSTERESIS = 0.1;

const clampDp = (d: number): number => Math.min(BPS_MAX_DECIMALS, Math.max(BPS_MIN_DECIMALS, d));

/**
 * floor(log10(v)) for v > 0, exact at powers of ten. `Math.log10` is not
 * correctly rounded everywhere (log10(1e-3) can come back as -2.9999999999999996),
 * so the estimate is corrected against the decade edges it implies.
 */
export function decadeOf(v: number): number {
  let e = Math.floor(Math.log10(v));
  if (10 ** (e + 1) <= v) e += 1;
  else if (10 ** e > v) e -= 1;
  return e;
}

/** Decimals that print `v` to BPS_SIG_FIGS significant figures, clamped. Null for no usable magnitude. */
export function decimalsForMagnitude(v: number): number | null {
  if (!(v > 0) || !Number.isFinite(v)) return null;
  return clampDp(BPS_SIG_FIGS - 1 - decadeOf(v));
}

/**
 * The magnitude decimals are chosen from: the smallest positive, finite value
 * among `values`. Null when there is none (no readings yet, or a locked book
 * whose every reading is 0).
 */
export function referenceMagnitude(values: Iterable<number | null | undefined>): number | null {
  let m = Infinity;
  for (const v of values) if (typeof v === 'number' && v > 0 && Number.isFinite(v) && v < m) m = v;
  return m === Infinity ? null : m;
}

/**
 * The magnitudes `d` decimals is the unclamped answer for: [lo, hi). The two
 * clamped ends are open-ended - 1 dp covers everything from 10 bps up, 4 dp
 * everything under 0.1 bps.
 */
function decadeRange(d: number): { lo: number; hi: number } {
  const lo = d >= BPS_MAX_DECIMALS ? 0 : 10 ** (BPS_SIG_FIGS - 1 - d);
  const hi = d <= BPS_MIN_DECIMALS ? Infinity : 10 ** (BPS_SIG_FIGS - d);
  return { lo, hi };
}

/**
 * The decimals to print with now, given the reference magnitude and the
 * decimals currently in use. `prev` is kept while `ref` stays inside its own
 * decade widened by the dead band on both edges; outside it the plain answer
 * for `ref` is taken. With no reference, `prev` stands (or 2 on a first call -
 * the precision the readout used before this rule existed).
 */
export function stableBpsDecimals(ref: number | null, prev: number | null): number {
  const want = ref === null ? null : decimalsForMagnitude(ref);
  if (want === null) return prev ?? 2;
  if (prev === null || want === prev) return want;
  const { lo, hi } = decadeRange(prev);
  if (ref! >= lo / (1 + BPS_HYSTERESIS) && ref! < hi * (1 + BPS_HYSTERESIS)) return prev;
  return want;
}

/** "0.119 bps" - the mid row's readout and the spread chart's tooltip. */
export function fmtBps(v: number, decimals: number): string {
  return `${v.toFixed(clampDp(decimals))} bps`;
}

/**
 * The resolution the chart's y-scale should never zoom past: ten units of the
 * last printed digit. A wobble finer than the readout can show - one tick's bps
 * value drifting in its fifth decimal as the mid moves - is drawn as the flat
 * line the printed figures say it is, instead of being stretched to fill the
 * chart while every tooltip on it reads the same number.
 */
export function bpsMinSpan(decimals: number): number {
  return 10 * 10 ** -clampDp(decimals);
}
