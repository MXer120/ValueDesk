/**
 * Interval <-> klinecharts `Period` mapping.
 *
 * The backend speaks Binance-style interval strings ("15m", "4h", "1D"); the
 * gateway rejects anything outside server/src/routes/market.ts KLINE_INTERVALS,
 * so this table IS the contract - the dropdown can never offer a value the
 * gateway would 400 on.
 *
 * klinecharts 10 replaced the old "set the data, tell me the interval" model
 * with a `DataLoader` that hands `getBars` a structured `Period`
 * ({ type: 'minute', span: 15 }). The loader therefore has to translate back to
 * the wire string, which is why the reverse map below exists: `getBars` derives
 * everything it needs from its own params instead of closing over React state
 * that may already have moved on.
 */
import type { Period } from 'klinecharts';

/** Buttons rendered inline in the toolbar. */
export const QUICK_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;

/** Every interval the backend actually accepts, grouped for the dropdown. */
export const INTERVAL_GROUPS: { label: string; items: string[] }[] = [
  { label: 'Minutes', items: ['1m', '3m', '5m', '15m', '30m'] },
  { label: 'Hours', items: ['1h', '2h', '4h', '6h', '8h', '12h'] },
  { label: 'Days', items: ['1D', '3D', '1W', '1M'] },
];

export const PERIOD_BY_INTERVAL: Record<string, Period> = {
  '1m': { type: 'minute', span: 1 },
  '3m': { type: 'minute', span: 3 },
  '5m': { type: 'minute', span: 5 },
  '15m': { type: 'minute', span: 15 },
  '30m': { type: 'minute', span: 30 },
  '1h': { type: 'hour', span: 1 },
  '2h': { type: 'hour', span: 2 },
  '4h': { type: 'hour', span: 4 },
  '6h': { type: 'hour', span: 6 },
  '8h': { type: 'hour', span: 8 },
  '12h': { type: 'hour', span: 12 },
  '1D': { type: 'day', span: 1 },
  '3D': { type: 'day', span: 3 },
  '1W': { type: 'week', span: 1 },
  '1M': { type: 'month', span: 1 },
};

/**
 * How an interval is SPELLED on screen. Never on the wire.
 *
 * The gateway's contract is lowercase for minutes and hours ("15m", "4h") and
 * uppercase for the longer units ("1D", "1W", "1M") — that asymmetry is not
 * ours to change, because KLINE_INTERVALS in server/src/routes/market.ts is
 * matched literally. But rendering it verbatim gives a row that is internally
 * inconsistent ("1m 5m 15m 1h 4h 1D"), and the reference capitalises the unit
 * on everything above minutes. So the label is uppercased for hours only, and
 * the raw key stays the single value that ever reaches an HTTP request.
 *
 * Minutes keep their lowercase m for the reason every trading UI does: "1M" is
 * one month, and a timeframe control where one minute and one month differ by
 * a shift key is a real way to load the wrong chart.
 */
export const intervalLabel = (interval: string): string =>
  /^\d+h$/.test(interval) ? interval.toUpperCase() : interval;

const INTERVAL_BY_PERIOD = new Map<string, string>(
  Object.entries(PERIOD_BY_INTERVAL).map(([interval, p]) => [`${p.type}:${p.span}`, interval]),
);

/**
 * Inverse of PERIOD_BY_INTERVAL. Returns undefined rather than a guess when the
 * period is one we never registered - the caller must then load nothing instead
 * of fetching a timeframe the user did not ask for.
 */
export const intervalOf = (period: Period | null | undefined): string | undefined =>
  period ? INTERVAL_BY_PERIOD.get(`${period.type}:${period.span}`) : undefined;
