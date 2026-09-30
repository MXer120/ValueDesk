/**
 * The order book's price arithmetic, pure and DOM-free so it can be tested:
 *   npx tsx --test src/components/bookDepth.test.ts
 *
 * The steps Book() in Market.tsx takes:
 *
 *   aggregate      raw [price, qty] levels   -> grouped buckets (the rows)
 *   withCumulative grouped buckets           -> buckets with running totals
 *   rowFigures     one bucket + display unit -> what that row prints
 *   depthFiguresThrough the RENDERED ladder + the focused row -> what the
 *                  hover popup PRINTS: the focused level's own price and the
 *                  exact running sums (`depthThrough` is their float core)
 *
 * ONE SOURCE OF TRUTH. The popup is computed from the very array the rows are
 * drawn from, with the very prices and sizes they print, so a user adding up
 * the visible rows from the touch to the hovered one gets the popup's Sum
 * figures EXACTLY, at every grouping step and in either display unit.
 *
 * ONE FORMATTER PER COLUMN. The popup prints each figure through the formatter
 * of the book column it belongs to - Price through the Price cell's
 * `fmtPrice`, Sum <BASE> through the base Size/Sum cells' `fmtQty`, Sum USDC
 * through the quote Size/Sum cells' `fmtNotional` - at the market's own tick
 * and step, which are also what the order ticket's price field is filled at.
 * So the popup has exactly the book's decimals, never more and never fewer,
 * and its Price is the focused row's Price cell, character for character.
 */
import { DASH, fmtPrice, fmtQty, num, precisionOf } from '../format';

export type BookSide = 'bid' | 'ask';
/** The book's display unit: sizes in the quote coin (USDC) or the base coin (BTC). */
export type BookUnit = 'quote' | 'base';

/** One level as a row renders it: its label price and its BASE size. */
export interface RenderedLevel {
  price: number;
  qty: number;
}

/** One grouped bucket as `aggregate` returns it, best price first. */
export interface BookBucket extends RenderedLevel {
  /** The bucket's label price - see `aggregate` for why asks ceil and bids floor. */
  price: number;
  /** Base quantity resting in this bucket. */
  qty: number;
}

export interface BookLevel extends BookBucket {
  /** Running total of `qty` over this bucket and every one nearer the touch. BASE units. */
  cum: number;
  /** Running total of `price * qty` over the same buckets. QUOTE units. */
  cumQuote: number;
}

/**
 * The bucket a raw price falls into at `increment`. Exported so tests can pin
 * the bucket edges; `aggregate` is the only production caller.
 *
 * Asks round UP and bids round DOWN - see `aggregate` for the argument. The
 * result is rounded to 8dp so float dust (0.1 + 0.2 style) cannot split one
 * bucket into two map keys.
 *
 * A PRICE ALREADY ON A BUCKET EDGE STAYS THERE. `0.07 / 0.01` is
 * 7.000000000000001 in binary floating point, so a bare `Math.ceil` put a
 * tick-aligned 0.07 ask into the 0.08 bucket - at the 1x step, where every
 * level should be its own row, it merged two levels and printed a price one
 * tick off the one resting in the book. The quotient is snapped to the nearest
 * whole step when it is within float noise of one, and only then rounded
 * outward.
 */
export function bucketOf(price: number, increment: number, side: BookSide): number {
  const raw = price / increment;
  const whole = Math.round(raw);
  const steps = Math.abs(raw - whole) <= 1e-9 * Math.max(1, Math.abs(raw))
    ? whole
    : side === 'ask' ? Math.ceil(raw) : Math.floor(raw);
  return Math.round(steps * increment * 1e8) / 1e8;
}

/**
 * Buckets raw [price, qty] levels into `increment`-wide bands and sums quantity
 * per band.
 *
 * ASKS CEIL, BIDS FLOOR, so both labels move AWAY from the touch:
 *
 *  1. NO BUCKET STRADDLES THE TOUCH - each band is built from its own side.
 *  2. THE DISPLAYED SPREAD CANNOT CLOSE OR INVERT at any increment.
 *  3. THE LABEL IS A PRICE YOU CAN ACTUALLY GET: every level summed into an ask
 *     bucket is at or below that bucket's label.
 *
 * At a coarse increment the displayed spread is the bucket pitch, not the real
 * spread; the real figure stays on the mid row, which is not aggregated.
 */
export function aggregate(levels: [string, string][], increment: number, side: BookSide): BookBucket[] {
  if (!levels.length || increment <= 0) return [];
  const buckets = new Map<number, BookBucket>();
  for (const [pStr, qStr] of levels) {
    const p = num(pStr);
    const q = num(qStr);
    if (!q) continue;
    const bucket = bucketOf(p, increment, side);
    const b = buckets.get(bucket);
    if (b) b.qty += q;
    else buckets.set(bucket, { price: bucket, qty: q });
  }
  return [...buckets.values()].sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price));
}

/**
 * The Sum column: ONE RUNNING TOTAL PER UNIT, both accumulated per bucket from
 * the touch outward.
 *
 * The quote total is Σ(price_i · qty_i), not price_n · Σ(qty_i) - the two agree
 * only when every bucket in the fold sits at the same price, which is why the
 * row no longer multiplies anything itself (see `rowFigures`).
 */
export function withCumulative(buckets: readonly BookBucket[]): BookLevel[] {
  let cum = 0;
  let cumQuote = 0;
  return buckets.map((b) => {
    cum += b.qty;
    cumQuote += b.price * b.qty;
    return { ...b, cum, cumQuote };
  });
}

/**
 * What one book row prints in `unit`: its Size cell and its Sum cell. BookRow
 * renders exactly these, so the popup's figures can be checked against them.
 *
 *   quote: size = price · qty (USDC)   total = Σ price·qty from the touch
 *   base:  size = qty         (BTC)    total = Σ qty       from the touch
 */
export function rowFigures(level: BookLevel, unit: BookUnit): { size: number; total: number } {
  return unit === 'quote'
    ? { size: level.price * level.qty, total: level.cumQuote }
    : { size: level.qty, total: level.cum };
}

/** What the hover popup shows for one focused level. */
export interface DepthStats {
  /** The focused level's own price - the bucket label its row prints and a click on it fills the ticket with. */
  price: number;
  /** Σ size in BASE units, whatever unit the book displays. */
  sumBase: number;
  /** Σ price · size in QUOTE units. */
  sumQuote: number;
  /** How many rendered levels the sums cover (touch = 1). */
  levels: number;
}

/**
 * Cumulative figures from the touch through `ladder[index]` INCLUSIVE.
 *
 * `ladder` is one side of the book EXACTLY as rendered, BEST FIRST (the touch
 * at index 0) - the grouped buckets with their label prices, never the raw
 * venue levels. Asks render worst-first top-down, so the caller passes the
 * best-first array the rows were sliced from, not the reversed one.
 *
 * Summed here rather than read off `cum`/`cumQuote` so the function stands on
 * its own over any rendered-level array; the accumulation order is the same as
 * `withCumulative`'s, so the results are bit-identical to the Sum column.
 */
export function depthThrough(ladder: readonly RenderedLevel[], index: number): DepthStats | null {
  if (!Number.isInteger(index) || index < 0 || index >= ladder.length) return null;
  let sumBase = 0;
  let sumQuote = 0;
  for (let i = 0; i <= index; i++) {
    const l = ladder[i]!;
    sumBase += l.qty;
    sumQuote += l.price * l.qty;
  }
  if (!(sumBase > 0)) return null;
  return { price: ladder[index]!.price, sumBase, sumQuote, levels: index + 1 };
}

/**
 * `depthThrough` for the rendered level labelled `price`. Matched by exact
 * equality, which is safe for a price taken from this same ladder (BookRow
 * writes its `data-price` from these numbers). The book itself focuses a row
 * by its RANK and calls `depthFiguresThrough`. Returns null for a price that
 * is not on the rendered ladder.
 */
export function depthAt(ladder: readonly RenderedLevel[], price: number): DepthStats | null {
  return depthThrough(ladder, ladder.findIndex((l) => l.price === price));
}

// --- what a book cell PRINTS -------------------------------------------------

/**
 * The market's own tick and step, exactly as the venue publishes them ("1",
 * "0.00001"). Every book cell takes its places from these through
 * `precisionOf` - the Price cell at the tick's, a base Size/Sum cell at the
 * step's - and so does the order ticket's price field when a row fills it, so
 * a price has one number of decimals everywhere it is printed.
 */
export interface BookFormat {
  tickSize?: string;
  stepSize?: string;
}

/** A finite number as a plain decimal string - its shortest round-trip digits, never exponent notation. */
function plainDecimal(v: number): string {
  const s = String(v);
  return /e/i.test(s) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : s;
}

/** Non-negative decimal digits `int.frac` rounded HALF-UP to `dp` places - the first dropped digit decides. */
function roundDecimal(int: string, frac: string, dp: number): { int: string; frac: string } {
  const kept = BigInt((int || '0') + frac.padEnd(dp, '0').slice(0, dp));
  const q = (frac[dp] ?? '0') >= '5' ? kept + 1n : kept;
  const s = q.toString().padStart(dp + 1, '0');
  return { int: s.slice(0, s.length - dp), frac: s.slice(s.length - dp) };
}

/** The compact steps, largest first: 1,234,567 -> 1.23M. */
const NOTIONAL_STEPS: ReadonlyArray<readonly [number, string]> = [[9, 'B'], [6, 'M'], [3, 'K'], [0, '']];

/**
 * THE BOOK'S NOTIONAL CELL - the quote-unit (USDC) Size and Sum columns, and
 * the popup's Sum USDC: two places of K / M / B, `922.47K`, `2.11M`. A 395px
 * book has room for about seven characters a column, and depth is compared by
 * magnitude, not by nine significant digits.
 *
 * HALF-UP ON THE DECIMAL DIGITS, never on a binary float: `(1005 / 1e3)
 * .toFixed(2)` is "1.00" because 1.005 is 1.00499999... in binary, which is a
 * floor, not a rounding. A number is taken at its shortest round-trip digits
 * and a string (the popup's exact sums) exactly as written. A rounding that
 * carries to 1000 moves up a step - 999,999 is `1.00M`, not `1000.00K`.
 */
export function fmtNotional(v: number | string): string {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? plainDecimal(v) : '') : v.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || !(m[2] || m[3])) return DASH;
  const int = (m[2] ?? '').replace(/^0+/, '');
  const frac = m[3] ?? '';
  let k = NOTIONAL_STEPS.findIndex(([e]) => int.length > e);
  if (k < 0) k = NOTIONAL_STEPS.length - 1;
  for (;;) {
    const [e, suffix] = NOTIONAL_STEPS[k]!;
    const whole = int.padStart(e, '0');
    const r = roundDecimal(whole.slice(0, whole.length - e), whole.slice(whole.length - e) + frac, 2);
    if (r.int.length > 3 && k > 0) {
      k--; // 999.995K rounds to 1000.00K: one step up instead
      continue;
    }
    const sign = m[1] && (r.int !== '0' || /[1-9]/.test(r.frac)) ? '-' : '';
    return `${sign}${r.int}.${r.frac}${suffix}`;
  }
}

/**
 * `cell(exact)` for an exact decimal ALREADY at the cell's own places. The
 * cell formatters parse to a double, and below 2^53 at those places that is
 * exact, so this is the formatter's own output digit for digit - checked, and
 * only a figure too long for a double is grouped here instead (the same en-US
 * separators `fmt` pins).
 */
function asCell(exact: string, cell: (v: string) => string): string {
  const out = cell(exact);
  if (out.replace(/,/g, '') === exact) return out;
  const [int, frac] = exact.split('.') as [string, string?];
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? g : `${g}.${frac}`;
}

// --- what the popup PRINTS ---------------------------------------------------

/** What the popup PRINTS, plus the float figures behind it. */
export interface DepthFigures extends DepthStats {
  text: {
    /** The focused level's price, through the Price cell's own `fmtPrice` - the row's text, character for character. */
    price: string;
    /** Exact Σ of the printed base sizes, through the base cells' `fmtQty` (the step's places). */
    sumBase: string;
    /** Exact Σ printed price x printed size, through the quote cells' `fmtNotional`. */
    sumQuote: string;
  };
}

/** A figure as the book prints it, as an exact integer mantissa at `dp` places. */
function printed(v: number, dp: number): bigint {
  // toFixed rounds the float exactly as the row's Intl formatting does (nearest,
  // ties up for positives), so this is the cell's own digits, commas aside.
  return BigInt(v.toFixed(dp).replace('.', ''));
}

/** `num / den` (both > 0) rounded half-up to `dp` places, as a plain decimal string. */
function ratio(num: bigint, den: bigint, dp: number): string {
  const f = 10n ** BigInt(dp);
  const q = (num * f * 2n + den) / (den * 2n);
  const int = (q / f).toString();
  return dp ? `${int}.${(q % f).toString().padStart(dp, '0')}` : int;
}

/**
 * The popup's three printed figures for `ladder[0..index]`.
 *
 *   Price      = the focused level's own price -> fmtPrice (the Price cell)
 *   Sum BASE   = Σ size                         -> fmtQty      (the step's places)
 *   Sum QUOTE  = Σ price x size                 -> fmtNotional (the quote cells)
 *
 * PRICE IS THE ROW'S PRICE - the string the focused row's Price cell prints and
 * the price a click on that row fills the ticket with. It used to be the VWAP
 * from the touch through the level ("Avg. Price"), which after rounding lands
 * between rows and barely moves when the book shifts under a still cursor: read
 * as a price, it was wrong and it did not update.
 *
 * THE SUMS ARE EXACT: what a user gets by adding up the rows exactly as
 * printed, from the touch through the focused one - each row's Price cell (at
 * the tick's places) and base Size cell (at the step's places) are taken as the
 * exact decimals on screen, then summed and multiplied in BigInt.
 *
 * WHY NOT FLOATS: Σ price·size in binary floating point misses a tie that the
 * printed rows hit exactly - 83,840 x 0.01338 + 83,841 x 0.0938 is 8,986.065,
 * the float is 8986.064999999999. BigInt also keeps a DOGE-sized book
 * (billions of coins at 5dp prices) exact.
 *
 * ONE SNAPSHOT: `ladder` is the very array the rows were just rendered from,
 * read in the same render, so the popup cannot describe a different book than
 * the one on screen.
 */
export function depthFiguresThrough(
  ladder: readonly RenderedLevel[],
  index: number,
  fmt: BookFormat,
): DepthFigures | null {
  const stats = depthThrough(ladder, index);
  if (!stats) return null;
  const pd = precisionOf(fmt.tickSize);
  const qd = precisionOf(fmt.stepSize);
  let sumQ = 0n; // at qd places
  let sumPQ = 0n; // at pd + qd places
  for (let i = 0; i <= index; i++) {
    const l = ladder[i]!;
    // toFixed turns exponential at 1e21, which BigInt cannot parse: no popup rather than a render crash.
    if (!(Math.abs(l.price) < 1e21) || !(Math.abs(l.qty) < 1e21)) return null;
    const q = printed(l.qty, qd);
    sumQ += q;
    sumPQ += printed(l.price, pd) * q;
  }
  if (sumQ <= 0n || sumPQ < 0n) return null;
  const pScale = 10n ** BigInt(pd);
  const qScale = 10n ** BigInt(qd);
  const base = ratio(sumQ, qScale, qd); // exact: already at qd places
  const quote = ratio(sumPQ, pScale * qScale, pd + qd); // exact: every place kept
  return {
    ...stats,
    text: {
      price: fmtPrice(ladder[index]!.price, fmt.tickSize),
      sumBase: asCell(base, (v) => fmtQty(v, fmt.stepSize)),
      sumQuote: fmtNotional(quote),
    },
  };
}

/** `depthFiguresThrough` for the rendered level labelled `price` - matched exactly, as `depthAt`. */
export function depthFiguresAt(
  ladder: readonly RenderedLevel[],
  price: number,
  fmt: BookFormat,
): DepthFigures | null {
  return depthFiguresThrough(ladder, ladder.findIndex((l) => l.price === price), fmt);
}
