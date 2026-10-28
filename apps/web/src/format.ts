/**
 * Display helpers.
 *
 * Formatting is presentation-only. Values sent BACK to the backend are always
 * the raw strings the user typed or the API returned - never a reformatted
 * float - because the backend canonicalises them for signing and any rounding
 * here would silently change an order.
 */

import { formatNumber } from './intlCache';
import { localize } from './numStyle';

/** Decimal places implied by a tick/step size like "0.0001". */
export const precisionOf = (step: string | undefined): number =>
  step ? (step.split('.')[1] ?? '').replace(/0+$/, '').length || (step.includes('.') ? 0 : 0) : 2;

/**
 * The separators follow the app's number format (numStyle.ts, Settings >
 * Appearance), NOT the browser locale.
 *
 * The figure is built in en-US and its two separators swapped for the chosen
 * ones, so a de-DE browser with the 1,234.56 setting still reads 79,290 - and
 * the default 1.234,56 reads 79.290 on every browser. Market data is
 * unambiguous or it is dangerous: one setting, applied everywhere, never the
 * system locale's guess.
 */
export function fmt(value: string | number | undefined | null, dp?: number): string {
  if (value === undefined || value === null || value === '') return DASH;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return String(value);
  return localize(fmtEn(n, dp));
}

/** `fmt`'s figure in en-US (the machine-side half; `localize` makes it the user's). */
function fmtEn(n: number, dp?: number): string {
  return formatNumber(n, 'en-US', {
    minimumFractionDigits: dp ?? 0,
    maximumFractionDigits: dp ?? 8,
  });
}

/** Format to a symbol's tick precision. */
export const fmtPrice = (v: string | number | undefined, tickSize?: string): string =>
  fmt(v, precisionOf(tickSize));

export const fmtQty = (v: string | number | undefined, stepSize?: string): string =>
  fmt(v, precisionOf(stepSize));

/**
 * Cents on dollar amounts below five figures. From $10,000 up the cents are
 * noise — $84,824 rather than $84,824.00 — so the default drops to none.
 * A caller that passes `dp` still gets exactly that.
 */
export const USD_WHOLE_FROM = 10_000;

export function usdDigits(n: number, dp?: number): number {
  if (dp !== undefined) return dp;
  return Math.abs(n) >= USD_WHOLE_FROM ? 0 : 2;
}

export function fmtUsd(v: string | number | undefined | null, dp?: number): string {
  if (v === undefined || v === null || v === '') return DASH;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) return DASH;
  const digits = usdDigits(n, dp);
  const sign = n < 0 ? MINUS : '';
  return `${sign}$${localize(formatNumber(Math.abs(n), 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }))}`;
}

/**
 * The quote currency's glyph, or none.
 *
 * Same test as `quoteGlyph` in Market.tsx, lifted here so the ticket, the chart
 * readout and the book cannot disagree about what currency a market settles in.
 * A quote asset we cannot recognise as a dollar gets no glyph and the label
 * beside it carries the unit instead - inventing a `$` is the failure mode this
 * exists to prevent.
 */
export const isDollarQuote = (quoteCoin: string | undefined | null): boolean =>
  /^(v?usd|usdt|usdc|busd|dai|pyusd)/i.test(quoteCoin ?? '');

/**
 * A value in a market's own quote currency.
 *
 * `fmtUsd` prints `$` unconditionally, which is wrong the moment a market is not
 * dollar-quoted - and it was being used for order value, margin required and the
 * chart's move readout, i.e. three of the numbers a trader acts on.
 */
export function fmtQuote(
  v: number | string | undefined | null,
  quoteCoin: string | undefined | null,
  dp?: number,
): string {
  if (v === undefined || v === null || v === '') return DASH;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) return DASH;
  const digits = usdDigits(n, dp);
  const sign = n < 0 ? MINUS : '';
  const body = localize(formatNumber(Math.abs(n), 'en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }));
  return isDollarQuote(quoteCoin)
    ? `${sign}$${body}`
    : `${sign}${body} ${coinLabel(quoteCoin) || ''}`.trim();
}

export function fmtPct(v: number | string | undefined | null, dp = 2): string {
  if (v === undefined || v === null || v === '') return DASH;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) return DASH;
  return `${n >= 0 ? '+' : ''}${localize(n.toFixed(dp))}%`;
}

export const fmtTime = (ms: number | undefined): string =>
  ms ? new Date(ms).toLocaleTimeString() : '-';

export const fmtDateTime = (ms: number | undefined): string =>
  ms ? new Date(ms).toLocaleString() : '-';

/**
 * Countdown to the next funding timestamp, as a zero-padded HH:MM:SS clock.
 *
 * It read "42m 10s" / "9m 5s" / "29m 36s" before. Two problems, both of which
 * the reference terminal's "00:02:33" avoids:
 *
 * 1. THE WIDTH CHANGED EVERY TICK. "10m 5s" is a character narrower than
 *    "10m 15s", and this string sits in the middle of the symbol header's stat
 *    row - so once a second the funding cell resized and every stat to its
 *    right shuffled. A fixed-width clock is the same 8 characters at 00:00:00
 *    and at 07:59:59.
 * 2. IT DROPPED THE SECONDS ONCE AN HOUR WAS LEFT ("7h 59m"), so the same cell
 *    changed UNIT as well as width depending on how far out funding was.
 *
 * Hours are kept even at zero for reason 1: they are what makes the width
 * constant across the whole eight-hour funding interval.
 */
export function fmtCountdown(target: number | undefined): string {
  if (!target) return DASH;
  const s = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Read the first field that exists from a list of candidate names.
 *
 * The gateway uses terse keys that differ between REST and WebSocket payloads
 * (e.g. a position's entry price appears as `entryPrice`, `ep`, or `avgPrice`
 * depending on the surface). Rather than guess one and render "-" everywhere,
 * accept all the plausible spellings.
 */
export function pick<T = any>(obj: any, ...names: string[]): T | undefined {
  if (!obj) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

/**
 * The placeholder for "the venue reported nothing here".
 *
 * EM DASH, and defined once. Six components had their own `const DASH = '—'`
 * and two of them carried a `dash()` helper whose whole job was to launder the
 * ASCII hyphen these formatters used to return. The glyph was already the app's
 * decision; the formatters just disagreed with it. Fixing it at source is what
 * lets those copies go.
 *
 * It is deliberately not an empty string: a blank cell reads as a rendering
 * fault, and a zero would be a claim the venue never made.
 */
export const DASH = '—';

/**
 * A market as people say it. Hyperliquid names its builder-deployed (HIP-3)
 * markets `<dex>:<COIN>` - `xyz:TSLA` is trade.xyz's TSLA. The prefix is its
 * internal routing, not the name: shown as TSLA (the full name stays in titles).
 */
export const marketName = (symbol: string): string => {
  const i = symbol.indexOf(':');
  return i > 0 ? symbol.slice(i + 1) : symbol;
};

/**
 * The MINUS SIGN, U+2212 - not the hyphen U+002D.
 *
 * In both faces this app uses, U+2212 and U+002B are the same advance width
 * (560 in Asap, 600 in Plex) while the hyphen is roughly half that. In a column
 * of signed figures the hyphen shifts every negative row sideways by half a
 * digit - the ragged left edge that made the PnL columns look misaligned. Two
 * signs of equal width make the sign column a clean vertical stripe.
 */
export const MINUS = '−';

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** Sign-aware colour class for PnL-style numbers. */
export const signClass = (v: unknown): string => {
  const n = num(v);
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
};

export const shortAddr = (a: string | undefined): string =>
  a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-';

/**
 * A coin ticker as a PERSON should read it.
 *
 * The venue signs and quotes in `vUSDC` - its own wrapped ledger unit - and
 * names perp markets `BTC-USD`, so the same balance can appear as "vUSDC" beside
 * the size field and "USD" beside the price on one screen. Both are the same
 * dollar, and the venue's own spot markets are already displayed as `SUI/USDC`,
 * so USDC is the name it actually goes by.
 *
 * DISPLAY ONLY. Nothing derived from this is ever sent: orders carry the
 * symbol's real `quoteCoin`, and mapping on the way out would sign for a coin
 * that does not exist. Every call site is a label.
 */
export const coinLabel = (coin: string | undefined | null): string => {
  if (!coin) return '';
  const u = coin.toUpperCase();
  return u === 'VUSDC' || u === 'USD' ? 'USDC' : coin;
};

/**
 * A balance as people read one: dollar coins to the cent below five figures
 * and with no cents from $10,000 up, anything else to at most 6 decimals with
 * the trailing zeros dropped ("0.0125", not "0.012500").
 */
export function fmtBalance(v: string | number | undefined | null, coin: string | undefined): string {
  const stable = /^v?(USDC|USDT|USD\w*|DAI)$/i.test(coin ?? '');
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  if (v === undefined || v === null || v === '') return DASH;
  if (!Number.isFinite(n)) return String(v);
  const s = fmtEn(n, stable ? usdDigits(n) : 6);
  return localize(stable || !/\.\d/.test(s) ? s : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
}
