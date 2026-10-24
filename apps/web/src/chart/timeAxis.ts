/**
 * The time axis, labelled the way TradingView labels it.
 *
 * klinecharts places a tick every N bars and prints the same template on every
 * one of them ("2026-08-16" on a daily chart, "13:23" intraday), so a label
 * says nothing about where the calendar turns and the times land on whatever
 * minute the stride happened to hit. TradingView instead puts ticks on ROUND
 * times and names each one by the largest unit that changed there:
 *
 *   a new year   2026
 *   a new month  Oct
 *   a new day    24
 *   otherwise    14:00
 *
 * so the axis reads "22  23  Oct  2  3" or "12:00  18:00  24  06:00" and the
 * calendar can be read off it at a glance. That is what `timeTicks` does:
 *
 *   1. Pick the smallest round step (1m … 10y) whose labels sit at least one
 *      label width plus a gutter apart at the current zoom.
 *   2. Walk the visible bars and keep the ones that start a new step - or a
 *      new day, month or year, which always qualify.
 *   3. Where two labels would collide, the higher-ranked one (year over month
 *      over day over time) wins, so "Oct" is never pushed out by "30".
 *
 * Pure: every chart-specific input (timestamps, pixel positions, text widths)
 * arrives as a function, so this file is tested without a canvas.
 */
import type { AxisTick } from 'klinecharts';

/** Which clock the axis, the crosshair and the footer read. */
export type TimeZoneMode = 'local' | 'utc';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  wd: number;
  /** Milliseconds since the epoch on this zone's wall clock - what round
   *  steps are counted in, so a 4h step lands on 00:00/04:00/08:00 local. */
  wall: number;
}

/** Calendar fields of a timestamp in the chosen zone. Date's own getters, not
 *  Intl: they run once per visible bar on every frame of a pan, and Intl's
 *  formatToParts is two orders of magnitude slower. */
export function partsOf(ts: number, tz: TimeZoneMode): Parts {
  const dt = new Date(ts);
  if (tz === 'utc') {
    return {
      y: dt.getUTCFullYear(),
      mo: dt.getUTCMonth(),
      d: dt.getUTCDate(),
      h: dt.getUTCHours(),
      mi: dt.getUTCMinutes(),
      wd: dt.getUTCDay(),
      wall: ts,
    };
  }
  return {
    y: dt.getFullYear(),
    mo: dt.getMonth(),
    d: dt.getDate(),
    h: dt.getHours(),
    mi: dt.getMinutes(),
    wd: dt.getDay(),
    wall: ts - dt.getTimezoneOffset() * MIN,
  };
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "UTC+2", "UTC-3:30", "UTC" - the zone the local clock is in at `ts`. */
export function utcOffsetLabel(ts: number = Date.now()): string {
  const off = -new Date(ts).getTimezoneOffset();
  if (off === 0) return 'UTC';
  const sign = off > 0 ? '+' : '-';
  const a = Math.abs(off);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m === 0 ? '' : `:${pad2(m)}`}`;
}

/** The footer clock: "14:45:52" in the chosen zone. */
export function clockText(ts: number, tz: TimeZoneMode): string {
  const p = partsOf(ts, tz);
  const s = tz === 'utc' ? new Date(ts).getUTCSeconds() : new Date(ts).getSeconds();
  return `${pad2(p.h)}:${pad2(p.mi)}:${pad2(s)}`;
}

/**
 * The crosshair's time label: "Fri 24 Oct '26  14:45" intraday, without the
 * time from a daily bar up, and "Oct '26" on a monthly chart - a date with a
 * weekday, because the crosshair is where a trader asks "which session was
 * this", and a bare "10-24" does not answer it.
 */
export function crosshairLabel(ts: number, intervalMs: number, tz: TimeZoneMode): string {
  const p = partsOf(ts, tz);
  const yy = `'${pad2(p.y % 100)}`;
  if (intervalMs >= 28 * DAY) return `${MONTHS[p.mo]} ${yy}`;
  const date = `${WEEKDAYS[p.wd]} ${p.d} ${MONTHS[p.mo]} ${yy}`;
  if (intervalMs >= DAY) return date;
  return `${date}  ${pad2(p.h)}:${pad2(p.mi)}`;
}

// --- steps -------------------------------------------------------------------

type StepUnit = 'ms' | 'day' | 'month' | 'year';

interface Step {
  unit: StepUnit;
  /** Count of the unit: 15 (minutes, as ms), 2 (days), 3 (months)… */
  n: number;
  /** Rough length, for choosing a step by spacing only. */
  approxMs: number;
  /** The label rank this step's own ticks carry (see `Rank`). */
  rank: Rank;
}

/** What changed since the previous bar, which is also what the label says. */
const Rank = { Time: 1, Day: 2, Month: 3, Year: 4 } as const;
type Rank = (typeof Rank)[keyof typeof Rank];

const STEPS: Step[] = [
  ...[1, 2, 5, 10, 15, 30].map((m) => ({ unit: 'ms' as const, n: m * MIN, approxMs: m * MIN, rank: Rank.Time })),
  ...[1, 2, 3, 4, 6, 12].map((h) => ({ unit: 'ms' as const, n: h * HOUR, approxMs: h * HOUR, rank: Rank.Time })),
  ...[1, 2, 3, 5, 7, 14].map((d) => ({ unit: 'day' as const, n: d, approxMs: d * DAY, rank: Rank.Day })),
  ...[1, 2, 3, 6].map((m) => ({ unit: 'month' as const, n: m, approxMs: m * 30.44 * DAY, rank: Rank.Month })),
  ...[1, 2, 5, 10, 25, 50].map((y) => ({ unit: 'year' as const, n: y, approxMs: y * 365.25 * DAY, rank: Rank.Year })),
];

/** The smallest round step at least `minGapPx` wide at this zoom. */
export function chooseStep(intervalMs: number, barSpace: number, minGapPx: number): Step {
  const pxPerMs = barSpace / Math.max(1, intervalMs);
  for (const s of STEPS) {
    if (s.approxMs < intervalMs) continue;
    if (s.approxMs * pxPerMs >= minGapPx) return s;
  }
  return STEPS[STEPS.length - 1]!;
}

/** Which slot of the step a bar falls in; a change of slot is a tick. */
function slotOf(p: Parts, s: Step): number {
  switch (s.unit) {
    case 'ms':
      return Math.floor(p.wall / s.n);
    case 'day':
      return Math.floor(Math.floor(p.wall / DAY) / s.n);
    case 'month':
      return Math.floor((p.y * 12 + p.mo) / s.n);
    case 'year':
      return Math.floor(p.y / s.n);
  }
}

function rankBetween(prev: Parts, cur: Parts): Rank {
  if (cur.y !== prev.y) return Rank.Year;
  if (cur.mo !== prev.mo) return Rank.Month;
  if (cur.d !== prev.d) return Rank.Day;
  return Rank.Time;
}

function labelFor(p: Parts, rank: Rank): string {
  switch (rank) {
    case Rank.Year:
      return String(p.y);
    case Rank.Month:
      return MONTHS[p.mo]!;
    case Rank.Day:
      return String(p.d);
    default:
      return `${pad2(p.h)}:${pad2(p.mi)}`;
  }
}

// --- ticks -------------------------------------------------------------------

export interface TimeTickInput {
  /** First and last visible data index (fractional ends are fine). */
  from: number;
  to: number;
  /** Bar open time at a data index - extrapolated past either end of the data. */
  timestampAt: (index: number) => number | null;
  /** Pixel x of a data index on the plot. */
  coordAt: (index: number) => number;
  /** Pixels between bar centres. */
  barSpace: number;
  intervalMs: number;
  /** Plot width, px. */
  width: number;
  tz: TimeZoneMode;
  /** Width of a label as it will be drawn. */
  measure: (text: string) => number;
  /** Clear space a label needs inside the plot's left edge. */
  edgeInset?: number;
}

/** Gutter between neighbouring labels, px. */
const LABEL_GAP = 28;

/** Ticks for the visible window, left to right. */
export function timeTicks(inp: TimeTickInput): AxisTick[] {
  const { from, to, timestampAt, coordAt, barSpace, intervalMs, width, tz, measure } = inp;
  const inset = inp.edgeInset ?? 4;
  if (!(barSpace > 0) || !(intervalMs > 0) || !(to > from)) return [];

  const widest = Math.max(measure('00:00'), measure('2026'), measure('Sep'));
  const step = chooseStep(intervalMs, barSpace, widest + LABEL_GAP);
  // Every bar is its own slot once the step is no wider than a bar.
  const everyBar = step.approxMs <= intervalMs;

  interface Candidate { coord: number; value: number; text: string; rank: Rank; half: number }
  const candidates: Candidate[] = [];

  const first = Math.floor(from);
  const last = Math.ceil(to);
  let prevTs = timestampAt(first - 1);
  let prev = prevTs === null ? null : partsOf(prevTs, tz);
  for (let i = first; i <= last; i++) {
    const ts = timestampAt(i);
    if (ts === null) {
      prev = null;
      continue;
    }
    const cur = partsOf(ts, tz);
    if (prev !== null && ts > (prevTs ?? -Infinity)) {
      const rank = rankBetween(prev, cur);
      // A bigger calendar unit turning over is always a tick; the step's own
      // unit is a tick when it enters a new slot; anything smaller never is.
      const take =
        rank > step.rank ||
        (rank === step.rank && (everyBar || slotOf(cur, step) !== slotOf(prev, step)));
      if (take) {
        const coord = coordAt(i);
        const text = labelFor(cur, rank);
        const half = measure(text) / 2;
        if (coord - half >= inset && coord + half <= width) {
          candidates.push({ coord, value: ts, text, rank, half });
        }
      }
    }
    prev = cur;
    prevTs = ts;
  }

  // Higher ranks claim their space first; ties go left to right.
  const byRank = [...candidates].sort((a, b) => b.rank - a.rank || a.coord - b.coord);
  const kept: Candidate[] = [];
  for (const c of byRank) {
    const clear = kept.every((k) => Math.abs(k.coord - c.coord) >= k.half + c.half + LABEL_GAP / 2);
    if (clear) kept.push(c);
  }
  return kept
    .sort((a, b) => a.coord - b.coord)
    .map((c) => ({ coord: Math.round(c.coord), value: c.value, text: c.text }));
}

/** Bar length of an interval key ("15m", "4h", "1D", "1W", "1M"). */
export function intervalToMs(interval: string): number {
  const m = /^(\d+)([mhDWM])$/.exec(interval);
  if (!m) return MIN;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm':
      return n * MIN;
    case 'h':
      return n * HOUR;
    case 'D':
      return n * DAY;
    case 'W':
      return n * 7 * DAY;
    default:
      return n * 30 * DAY;
  }
}

/**
 * A data index -> bar open time function that keeps going past both ends of
 * the loaded bars, so the empty space right of the last candle gets times too
 * (the axis does not stop dead at the newest bar). Monthly bars step by
 * calendar month rather than by a fixed 30 days.
 */
export function timestampLookup(
  n: number,
  timeAt: (index: number) => number,
  interval: string,
): (index: number) => number | null {
  const ms = intervalToMs(interval);
  const monthly = /M$/.test(interval);
  return (i) => {
    if (n === 0) return null;
    if (i >= 0 && i < n) return timeAt(i);
    const edge = i < 0 ? timeAt(0) : timeAt(n - 1);
    const k = i < 0 ? i : i - (n - 1);
    if (!monthly) return edge + k * ms;
    const d = new Date(edge);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  };
}

/** A timestamp as a `<input type="datetime-local">` value ("2026-10-24T14:45") on the chosen clock. */
export function inputTime(ts: number, tz: TimeZoneMode): string {
  const p = partsOf(ts, tz);
  return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

/**
 * Such a value back to a timestamp, on the bar it falls in (a drawing's anchor
 * sits on a bar's open time). Null for anything that is not a date and time.
 * Up to a day, bars open on whole multiples of their length since the epoch
 * (UTC midnight for 1D); longer bars are left where the user put them.
 */
export function parseInputTime(value: string, tz: TimeZoneMode, intervalMs: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ts = tz === 'utc' ? Date.UTC(y, mo - 1, d, h, mi) : new Date(y, mo - 1, d, h, mi).getTime();
  if (!Number.isFinite(ts)) return null;
  return intervalMs > 0 && intervalMs <= DAY ? Math.floor(ts / intervalMs) * intervalMs : ts;
}
