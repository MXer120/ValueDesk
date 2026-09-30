/**
 * The pure half of the TradingView datafeed: every decision that can be made
 * without a network, a socket or a DOM. datafeed.ts wires these to the app's
 * data paths; datafeedCore.test.ts pins them.
 *
 * THE INTERVAL LIST IS NOT RESTATED HERE. It is derived from
 * PERIOD_BY_INTERVAL in ../intervals.ts, which is itself the mirror of the
 * gateway's KLINE_INTERVALS (server/src/routes/market.ts). One table, so the
 * TradingView resolution menu can never offer a timeframe the gateway would
 * 400 on, and adding an interval there adds it here.
 */
import type { Engine, Symbol as MarketSymbol } from '../../api';
import { PERIOD_BY_INTERVAL } from '../intervals';
import type {
  Bar,
  DatafeedConfiguration,
  HistoryMetadata,
  LibrarySymbolInfo,
  PeriodParams,
  ResolutionString,
  SearchSymbolResultItem,
} from './types';

export const EXCHANGE = 'SoDEX';
export const TIMEZONE = 'Etc/UTC';
export const SESSION = '24x7';

// --- resolutions ----------------------------------------------------------------

interface ResolutionRow {
  /** TradingView spelling: minutes as a bare number, then D / W / M. */
  resolution: ResolutionString;
  /** Gateway spelling, exactly as KLINE_INTERVALS has it. */
  interval: string;
  /** Nominal bar length. A month is taken as 30 days - only ever used to
   *  size a request, never to place a bar. */
  seconds: number;
  unit: 'minute' | 'day' | 'week' | 'month';
  span: number;
}

const UNIT_SECONDS = { minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_592_000 } as const;

function rowOf(interval: string, type: string, span: number): ResolutionRow | null {
  switch (type) {
    case 'minute':
      return { resolution: String(span), interval, seconds: span * UNIT_SECONDS.minute, unit: 'minute', span };
    case 'hour':
      // TradingView has no hour unit: 4h is resolution "240".
      return { resolution: String(span * 60), interval, seconds: span * UNIT_SECONDS.hour, unit: 'minute', span: span * 60 };
    case 'day':
      return { resolution: `${span}D`, interval, seconds: span * UNIT_SECONDS.day, unit: 'day', span };
    case 'week':
      return { resolution: `${span}W`, interval, seconds: span * UNIT_SECONDS.week, unit: 'week', span };
    case 'month':
      return { resolution: `${span}M`, interval, seconds: span * UNIT_SECONDS.month, unit: 'month', span };
    default:
      return null;
  }
}

export const RESOLUTION_TABLE: readonly ResolutionRow[] = Object.entries(PERIOD_BY_INTERVAL)
  .map(([interval, p]) => rowOf(interval, p.type, p.span))
  .filter((r): r is ResolutionRow => r !== null)
  .sort((a, b) => a.seconds - b.seconds);

const BY_RESOLUTION = new Map(RESOLUTION_TABLE.map((r) => [r.resolution, r]));
const BY_INTERVAL = new Map(RESOLUTION_TABLE.map((r) => [r.interval, r]));

export const SUPPORTED_RESOLUTIONS: ResolutionString[] = RESOLUTION_TABLE.map((r) => r.resolution);

const multipliers = (unit: ResolutionRow['unit']): string[] =>
  RESOLUTION_TABLE.filter((r) => r.unit === unit).map((r) => String(r.span));

/** Every base resolution we serve, by unit - the library builds any other
 *  multiple (e.g. "10" from "5") out of these on its own. */
export const INTRADAY_MULTIPLIERS = multipliers('minute');
export const DAILY_MULTIPLIERS = multipliers('day');
export const WEEKLY_MULTIPLIERS = multipliers('week');
export const MONTHLY_MULTIPLIERS = multipliers('month');

/**
 * Canonical spelling of a resolution. The library is inconsistent about the
 * leading 1 ("D" and "1D" both occur, as do "W"/"1W", "M"/"1M"), so this folds
 * them before any lookup. Returns null for something that is not a resolution.
 */
export function normalizeResolution(res: string): string | null {
  const s = res.trim().toUpperCase();
  const m = /^(\d*)([DWM])$/.exec(s);
  if (m) {
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    return n > 0 ? `${n}${m[2]}` : null;
  }
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    return n > 0 ? String(n) : null;
  }
  return null; // seconds ("1S"), ticks ("1T") - not something the gateway serves
}

/** TradingView resolution -> gateway interval, or undefined when unsupported. */
export function intervalForResolution(res: string): string | undefined {
  const n = normalizeResolution(res);
  return n === null ? undefined : BY_RESOLUTION.get(n)?.interval;
}

/** Gateway interval -> TradingView resolution. */
export function resolutionForInterval(interval: string): ResolutionString | undefined {
  return BY_INTERVAL.get(interval)?.resolution;
}

export function intervalSeconds(interval: string): number | undefined {
  return BY_INTERVAL.get(interval)?.seconds;
}

// --- price format ---------------------------------------------------------------

/**
 * A decimal string in plain positional notation, or null. Exponent notation
 * ("1e-8") is expanded through Number, which is exact enough for a tick size;
 * everything else stays a string so "0.1" never becomes 0.1000000000000000055.
 */
function plainDecimal(v: string | number | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    s = n.toFixed(20);
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  return s;
}

/** Decimal places of a step, ignoring trailing zeros ("0.0100" -> 2). */
export function decimalsOf(step: string | number | undefined | null): number | null {
  const s = plainDecimal(step);
  if (s === null) return null;
  const frac = (s.split('.')[1] ?? '').replace(/0+$/, '');
  return frac.length;
}

/**
 * TradingView's price format from the venue's tick size.
 *
 * The library draws prices as multiples of `minmov / pricescale`, and
 * `pricescale` must be a power of ten for a decimal market. So the tick's
 * decimal places become the exponent and its digits become `minmov`:
 *
 *   0.01    -> 100 / 1      0.5 -> 10 / 5      0.00025 -> 100000 / 25
 *   1       -> 1 / 1        10  -> 1 / 10
 *
 * Worked from the STRING, never from a float, so a tick of 0.1 cannot come out
 * as a scale of 10000000000000002.
 */
export function priceFormatOf(
  tickSize: string | number | undefined | null,
  fallbackDecimals = 2,
): { pricescale: number; minmov: number } {
  const s = plainDecimal(tickSize);
  const fallback = { pricescale: 10 ** fallbackDecimals, minmov: 1 };
  if (s === null) return fallback;
  const [int = '', rawFrac = ''] = s.split('.');
  const frac = rawFrac.replace(/0+$/, '');
  if (frac.length > 16) return fallback;
  const digits = `${int}${frac}`.replace(/^0+/, '');
  const minmov = digits ? Number.parseInt(digits, 10) : 0;
  if (!Number.isSafeInteger(minmov) || minmov <= 0) return fallback;
  return { pricescale: 10 ** frac.length, minmov };
}

/** Decimal places volume is shown with - the lot step's precision. */
export function volumePrecisionOf(stepSize: string | undefined | null, fallback = 2): number {
  return decimalsOf(stepSize) ?? fallback;
}

// --- symbols --------------------------------------------------------------------

/**
 * The ticker carries the engine, because a name alone is ambiguous across the
 * two books and `getBars` must never have to guess which market it is asked
 * about (it only ever sees the LibrarySymbolInfo, never React state).
 */
export const tickerOf = (engine: Engine, name: string): string => `${engine}:${name}`;

export function parseTicker(raw: string, defaultEngine: Engine): { engine: Engine; name: string } {
  const s = raw.trim();
  const m = /^([A-Za-z-]+):(.+)$/.exec(s);
  if (!m) return { engine: defaultEngine, name: s };
  const prefix = (m[1] ?? '').toLowerCase();
  const name = (m[2] ?? '').trim();
  if (prefix === 'perps' || prefix === 'spot') return { engine: prefix, name };
  return { engine: defaultEngine, name }; // "SODEX:BTC-USD" or any exchange prefix
}

const engineLabel = (engine: Engine): string => (engine === 'perps' ? 'Futures' : 'Spot');

export function toSymbolInfo(engine: Engine, sym: MarketSymbol): LibrarySymbolInfo {
  const ticker = tickerOf(engine, sym.name);
  return {
    name: sym.name,
    ticker,
    full_name: ticker,
    description: `${sym.displayName || sym.name} ${engineLabel(engine)}`,
    type: 'crypto',
    session: SESSION,
    exchange: EXCHANGE,
    listed_exchange: EXCHANGE,
    timezone: TIMEZONE,
    format: 'price',
    ...priceFormatOf(sym.tickSize, Number.isFinite(sym.pricePrecision) ? sym.pricePrecision : 2),
    has_intraday: true,
    has_weekly_and_monthly: true,
    has_empty_bars: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    intraday_multipliers: INTRADAY_MULTIPLIERS,
    daily_multipliers: DAILY_MULTIPLIERS,
    weekly_multipliers: WEEKLY_MULTIPLIERS,
    monthly_multipliers: MONTHLY_MULTIPLIERS,
    volume_precision: volumePrecisionOf(
      sym.stepSize,
      Number.isFinite(sym.quantityPrecision) ? sym.quantityPrecision : 2,
    ),
    data_status: 'streaming',
    visible_plots_set: 'ohlcv',
  };
}

export const DATAFEED_CONFIG: DatafeedConfiguration = {
  supported_resolutions: SUPPORTED_RESOLUTIONS,
  exchanges: [{ value: EXCHANGE, name: EXCHANGE, desc: EXCHANGE }],
  symbols_types: [
    { name: 'All', value: '' },
    { name: 'Futures', value: 'perps' },
    { name: 'Spot', value: 'spot' },
  ],
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: false,
};

export interface SearchEntry {
  engine: Engine;
  sym: MarketSymbol;
}

/**
 * Symbol search. Ranked, not merely filtered: an exact name beats an exact
 * base coin beats a prefix beats a substring, so typing "BTC" puts BTC-USD at
 * the top instead of wherever it sorts alphabetically.
 */
export function searchSymbols(
  entries: readonly SearchEntry[],
  userInput: string,
  exchange: string,
  symbolType: string,
  limit = 50,
): SearchSymbolResultItem[] {
  if (exchange && exchange.toUpperCase() !== EXCHANGE.toUpperCase()) return [];
  const q = userInput.trim().toUpperCase().replace(/\s+/g, '');
  const scored: { e: SearchEntry; score: number }[] = [];
  for (const e of entries) {
    if (symbolType && symbolType !== e.engine) continue;
    const name = e.sym.name.toUpperCase();
    const display = (e.sym.displayName || e.sym.name).toUpperCase();
    const base = (e.sym.baseCoin || '').toUpperCase();
    let score: number;
    if (!q) score = 5;
    else if (name === q || display === q) score = 0;
    else if (base === q) score = 1;
    else if (name.startsWith(q) || display.startsWith(q)) score = 2;
    else if (base.startsWith(q)) score = 3;
    else if (name.includes(q) || display.includes(q)) score = 4;
    else continue;
    scored.push({ e, score });
  }
  // Ties: shorter name first (BTC-USD before BTC-USD-PERP-X), then plain
  // code-unit order - not localeCompare, whose punctuation collation varies.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.e.sym.name.length - b.e.sym.name.length ||
      cmp(a.e.sym.name, b.e.sym.name) ||
      cmp(a.e.engine, b.e.engine),
  );
  return scored.slice(0, limit).map(({ e }) => {
    const ticker = tickerOf(e.engine, e.sym.name);
    return {
      symbol: e.sym.name,
      full_name: ticker,
      ticker,
      description: `${e.sym.displayName || e.sym.name} ${engineLabel(e.engine)}`,
      exchange: EXCHANGE,
      type: 'crypto',
    };
  });
}

// --- bars -----------------------------------------------------------------------

const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * One gateway kline ({t,o,h,l,c,v,...}, decimal strings) -> one TradingView
 * bar. Null for anything malformed: a bar with a NaN in it poisons the
 * library's autoscale for the whole visible range, so it is dropped rather
 * than passed through.
 */
export function klineToBar(k: unknown): Bar | null {
  if (!k || typeof k !== 'object') return null;
  const r = k as Record<string, unknown>;
  const time = finite(r.t);
  const open = finite(r.o);
  const high = finite(r.h);
  const low = finite(r.l);
  const close = finite(r.c);
  if (time === null || time <= 0 || open === null || high === null || low === null || close === null) return null;
  const volume = finite(r.v);
  return volume === null ? { time, open, high, low, close } : { time, open, high, low, close, volume };
}

/**
 * The gateway returns newest-first; the library wants strictly ascending
 * times with no duplicates. `beforeMs` enforces the EXCLUSIVE `to` of a
 * history page - a bar at or after it belongs to a page the library already
 * holds, and sending it twice is a "time order violation".
 */
export function normalizeBars(rows: readonly unknown[], opts: { beforeMs?: number } = {}): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const row of rows) {
    const bar = klineToBar(row);
    if (!bar) continue;
    if (opts.beforeMs !== undefined && bar.time >= opts.beforeMs) continue;
    byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * A live `candle` push -> bars for one series. The hub's fan-out matches on
 * engine, channel and interval but NOT on symbol (see ws.ts), so a push that
 * names another market is dropped here rather than drawn onto this one.
 */
export function candleToBars(data: unknown, symbol: string, interval: string): Bar[] {
  const rows = Array.isArray(data) ? data : [data];
  const out: Bar[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.s === 'string' && r.s !== symbol) continue;
    if (typeof r.i === 'string' && r.i !== interval) continue;
    const bar = klineToBar(r);
    if (bar) out.push(bar);
  }
  return out.sort((a, b) => a.time - b.time);
}

// --- paging ---------------------------------------------------------------------

/** Floor on a page: bigger pages mean fewer requests against a rate-limited
 *  gateway, and the library accepts more bars than it asked for. */
export const PAGE_MIN = 300;
/** The backend clamps `limit` to 1000 (server/src/routes/market.ts). */
export const PAGE_MAX = 1000;

export interface HistoryPlan {
  interval: string;
  limit: number;
  /** Inclusive upper bound sent to the gateway (ms). Absent on the first
   *  request, which asks for the newest bars exactly as the klinecharts chart
   *  does today. */
  endTime?: number;
  /** Exclusive filter applied to what comes back (ms). */
  beforeMs?: number;
}

/**
 * Turn the library's history request into one gateway call.
 *
 * `countBack` wins over `from` - the docs are explicit that the bar COUNT
 * matters more than matching [from, to). Old builds that do not send it get a
 * count estimated from the range instead.
 *
 * The gateway's `endTime` is inclusive, the library's `to` is exclusive, so
 * the bound sent is `to - 1ms` and the result is filtered to `< to` as well:
 * if the gateway ever ignored the bound and returned the newest bars again,
 * every one of them would be filtered out, the page would come back empty,
 * and the chart would stop asking (noData) instead of drawing duplicates.
 */
export function planHistory(params: PeriodParams, interval: string): HistoryPlan {
  const secs = intervalSeconds(interval) ?? 60;
  let want = params.countBack > 0 ? params.countBack : Math.ceil((params.to - params.from) / secs);
  if (!Number.isFinite(want) || want < 1) want = 1;
  const limit = Math.min(PAGE_MAX, Math.max(PAGE_MIN, Math.ceil(want)));
  if (params.firstDataRequest) return { interval, limit };
  const toMs = params.to * 1000;
  return { interval, limit, endTime: toMs - 1, beforeMs: toMs };
}

/** An empty page is the end of history: `noData` stops further requests. */
export function historyMeta(bars: readonly Bar[]): HistoryMetadata {
  return { noData: bars.length === 0 };
}
