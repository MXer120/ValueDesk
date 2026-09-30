/**
 * Cached Intl formatters - the same strings as toLocaleString, without the cost.
 *
 * `n.toLocaleString(locale, options)` is specified as "construct a new
 * Intl.NumberFormat(locale, options), format n with it" - and engines really do
 * build the formatter (locale data, pattern, rounding setup) on EVERY call.
 * Profiling the pages under a 4x CPU slowdown put exactly that at the top of the
 * main thread: format.ts's `fmt` on the trade page's book and tape, Explore's
 * money columns, the leaderboard's cells - hundreds of calls per render, tens of
 * microseconds each.
 *
 * Formatting through a kept formatter returns the identical string (that is the
 * definition of toLocaleString), so this changes cost and nothing else. The
 * cache is keyed by locale + options and bounded; option sets in this app are a
 * small fixed family (decimal places 0-10, compact or not).
 */

const MAX = 256;
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function cached<T>(map: Map<string, T>, key: string, make: () => T): T {
  let f = map.get(key);
  if (f === undefined) {
    if (map.size >= MAX) map.clear();
    f = make();
    map.set(key, f);
  }
  return f;
}

/** A kept `new Intl.NumberFormat(locale, options)`. */
export function numberFormat(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached(numberFormats, options ? locale + JSON.stringify(options) : locale, () => new Intl.NumberFormat(locale, options));
}

/** Exactly `n.toLocaleString(locale, options)`, for a number. */
export function formatNumber(n: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return numberFormat(locale, options).format(n);
}

/**
 * Exactly `new Date(ms).toLocaleTimeString(locale, options)` - for options that
 * name at least one time field (hour/minute/second), where toLocaleTimeString
 * adds no defaults of its own. An invalid time reads "Invalid Date", as
 * toLocaleTimeString does (Intl's format() would throw instead).
 */
export function formatTime(ms: number | Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  const t = typeof ms === 'number' ? ms : ms.getTime();
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return 'Invalid Date';
  if (options.hour === undefined && options.minute === undefined && options.second === undefined) {
    return new Date(t).toLocaleTimeString(locale, options); // defaults would apply: no shortcut
  }
  return cached(dateFormats, locale + JSON.stringify(options), () => new Intl.DateTimeFormat(locale, options)).format(t);
}
