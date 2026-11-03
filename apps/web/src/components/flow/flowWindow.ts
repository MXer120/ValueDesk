/**
 * The time window "Who traded" reads: one candle of the chart's interval, in UTC, as the venues
 * cut them - minutes, hours and days from the epoch (3D too, Binance-style), weeks from Monday
 * 00:00, months on the calendar. Pure (flowWindow.test.ts).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The epoch was a Thursday: Monday-based weeks start 4 days later. */
const WEEK_OFFSET = 4 * DAY;

export interface CandleWindow {
  from: number;
  to: number;
}

function unit(interval: string): { n: number; u: string } | null {
  const m = /^(\d+)([mhDWM])$/.exec(interval);
  return m ? { n: Number(m[1]), u: m[2]! } : null;
}

/** The candle of `interval` that holds `t`. An unknown interval reads as 1m. */
export function candleAt(interval: string, t: number): CandleWindow {
  const p = unit(interval) ?? { n: 1, u: 'm' };
  if (p.u === 'M') {
    const d = new Date(t);
    const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const start = Math.floor(months / p.n) * p.n;
    return { from: Date.UTC(Math.floor(start / 12), start % 12, 1), to: Date.UTC(Math.floor((start + p.n) / 12), (start + p.n) % 12, 1) };
  }
  if (p.u === 'W') {
    const span = p.n * 7 * DAY;
    const from = Math.floor((t - WEEK_OFFSET) / span) * span + WEEK_OFFSET;
    return { from, to: from + span };
  }
  const span = p.n * (p.u === 'm' ? MIN : p.u === 'h' ? HOUR : DAY);
  const from = Math.floor(t / span) * span;
  return { from, to: from + span };
}

/** The candle Who traded shows: the one holding `at`, else the last closed one (a forming candle is often still empty). */
export function flowCandle(interval: string, at: number | null): CandleWindow {
  return at !== null ? candleAt(interval, at) : stepCandle(interval, candleAt(interval, Date.now()), -1);
}

/**
 * The candles Who traded shows (owner 2026-11-03: "possible by pressing cmd + mouse or dragging the
 * mouse for multiple candles"): the one holding `at`, or every candle from it to the one holding `end`
 * (either order).
 */
export function flowSpan(interval: string, at: number | null, end: number | null): CandleWindow {
  const a = flowCandle(interval, at);
  if (end === null) return a;
  const b = candleAt(interval, end);
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}

/** How many candles of `interval` a window holds (months and weeks counted, the rest divided). */
export function candleCount(interval: string, w: CandleWindow): number {
  const one = candleAt(interval, w.from);
  if (!/[WM]$/.test(interval)) return Math.max(1, Math.round((w.to - w.from) / (one.to - one.from)));
  let n = 0;
  for (let c = one; c.from < w.to && n < 10_000; c = candleAt(interval, c.to)) n++;
  return Math.max(1, n);
}

/** The candle `steps` away from the one starting at `from` (negative: earlier). */
export function stepCandle(interval: string, w: CandleWindow, steps: number): CandleWindow {
  let c = w;
  for (let i = 0; i < Math.abs(steps); i++) c = candleAt(interval, steps > 0 ? c.to : c.from - 1);
  return c;
}

/** "Oct 29, 08:00 – Oct 30, 08:00 UTC" (the day once when both ends share it). */
export function windowText(w: CandleWindow): string {
  const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
  const end = w.to;
  return day(w.from) === day(end - 1) && (end - w.from) < DAY
    ? `${day(w.from)}, ${time(w.from)} – ${time(end)} UTC`
    : `${day(w.from)}, ${time(w.from)} – ${day(end)}, ${time(end)} UTC`;
}
