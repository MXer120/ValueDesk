/**
 * What the markets expect of the FOMC: the probability of each decision at
 * each coming meeting, from prediction markets that settle on it.
 *
 *   Kalshi      (primary, public market data, no key) the KXFEDDECISION
 *               series: one event per meeting (KXFEDDECISION-26DEC, its
 *               strike_date the statement's time), one binary market per
 *               outcome - cut >25, cut 25, maintain, hike 25, hike >25 bp.
 *               History from its candlesticks (/markets/candlesticks, every
 *               outcome of a meeting in one call): hourly for a week, daily
 *               for longer.
 *   Polymarket  (second opinion, gamma API, no key) its "Fed Decision in
 *               <Month>?" events, one market per outcome; kept only for a
 *               meeting whose month and Eastern day match Kalshi's.
 *
 * A market's probability is its order book's midpoint (yes bid and ask, in
 * dollars = probability) while the spread is at most 10 cents: the last trade
 * on a thin market can be days old (Mar 2027's cut traded at 35 c with the
 * book at 6-13 c). With a wider or one-sided book it is the last trade, held
 * inside the book. A meeting's outcomes are then scaled to sum to 1 when they
 * already sum to between 0.85 and 1.15 (the books' spreads add a few cents);
 * otherwise they are left as they are.
 *
 * The resulting target range of an outcome is counted from the current range
 * (the newest FOMC statement releases.ts read, else FRED's DFEDTARL/DFEDTARU)
 * for the next meeting, and for a later one from the range the most likely
 * outcome of each meeting before it leaves.
 *
 * The meetings are read at most every 60 s, a history every 10 minutes. The
 * parsers are pure and covered by test/fedwatch.test.ts on saved responses.
 */
import { easternDay, latestTargetRange } from './releases.js';
import { fredSeries } from './indicators.js';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXFEDDECISION';
const POLYMARKET_SEARCH = 'https://gamma-api.polymarket.com/public-search?q=fed%20decision&events_status=active&limit_per_type=20';
const UA = 'ValueDesk economic calendar (+https://www.valuedesk.so)';
const MEETINGS_MS = 60_000;
const HISTORY_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
/** Meetings returned, nearest first. */
const MAX_MEETINGS = 6;
/** The widest book whose midpoint is trusted, in dollars. */
const MAX_SPREAD = 0.1;
const MAX_HISTORY_CACHED = 32;

export interface TargetRange {
  lower: number;
  upper: number;
}

export interface FedOutcome {
  /** cut_gt25 | cut25 | hold | hike25 | hike_gt25 (Kalshi's "maintains" is hold). */
  key: string;
  /** "Cut 25 bp", "Hold", "Hike 50+ bp". */
  label: string;
  /** The change in basis points, signed; "more than 25" counts as 50. */
  bp: number;
  /** 0..1. */
  prob: number;
  /** The range it leaves, "3.50–3.75" ("≤3.25–3.50" for a cut of more than 25). */
  target: string | null;
}

export interface FedMeeting {
  /** The statement's day in New York, YYYY-MM-DD. */
  meeting: string;
  /** The statement's time, ms (2:00 pm ET). */
  statementAt: number;
  /** "FOMC December 2026". */
  title: string;
  /** Lowest change first. */
  outcomes: FedOutcome[];
  /** Polymarket's probabilities by outcome key, where its meeting matches. */
  polymarket?: Record<string, number>;
  source: 'kalshi';
  /** When this server read Kalshi's books, ms. */
  updatedAt: number;
}

/** Kalshi's event and markets, as the history needs them. */
interface MeetingRef {
  event: string;
  markets: Array<{ ticker: string; key: string; label: string; bp: number }>;
}

// --- parsing -------------------------------------------------------------------------

const dollars = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/**
 * A binary market's probability from its yes bid, ask and last price
 * (dollars): the midpoint of a book at most 10 c wide, else the last price
 * kept inside the book, else whatever of them there is.
 */
export function marketProb(bid: number | null, ask: number | null, last: number | null): number | null {
  const book = bid !== null && ask !== null && ask > 0 && ask >= bid;
  // Cents in floating point: 0.40 - 0.30 is 0.10000000000000003, still a 10 c book.
  if (book && ask! - bid! <= MAX_SPREAD + 1e-9) return (bid! + ask!) / 2;
  if (last !== null && last > 0) return book ? Math.min(ask!, Math.max(bid!, last)) : last;
  if (book) return (bid! + ask!) / 2;
  return null;
}

/** Scaled to sum to 1 when the sum is already near it (0.85-1.15), else as they are. Four decimals. */
export function normalise(probs: number[]): number[] {
  const sum = probs.reduce((s, p) => s + p, 0);
  const k = sum >= 0.85 && sum <= 1.15 ? 1 / sum : 1;
  return probs.map((p) => Math.round(p * k * 10_000) / 10_000);
}

/** Kalshi's custom_strike ({"Cut": "25"}, {"Hike": ">25"}, {"Hike": "0"}) as an outcome. */
export function kalshiOutcome(strike: unknown): { key: string; label: string; bp: number } | null {
  if (!strike || typeof strike !== 'object') return null;
  const [dir, raw] = Object.entries(strike as Record<string, unknown>)[0] ?? [];
  if ((dir !== 'Cut' && dir !== 'Hike') || typeof raw !== 'string') return null;
  const m = /^(>)?\s*(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (n === 0) return { key: 'hold', label: 'Hold', bp: 0 };
  const more = !!m[1];
  const sign = dir === 'Cut' ? -1 : 1;
  return {
    key: `${dir.toLowerCase()}${more ? '_gt' : ''}${n}`,
    label: `${dir} ${more ? `${n + 25}+` : n} bp`,
    bp: sign * (more ? n + 25 : n),
  };
}

const fmt = (n: number) => n.toFixed(2);

/** The range an outcome leaves from `from`: "3.50–3.75"; a change of more than 25 bp is "≤"/"≥" its 50 bp range. */
export function targetAfter(from: TargetRange | null, o: Pick<FedOutcome, 'key' | 'bp'>): string | null {
  if (!from) return null;
  const d = o.bp / 100;
  const range = `${fmt(from.lower + d)}–${fmt(from.upper + d)}`;
  if (from.lower + d < 0) return null;
  return o.key.includes('_gt') ? `${o.bp < 0 ? '≤' : '≥'}${range}` : range;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Kalshi's open KXFEDDECISION events (with_nested_markets) as meetings,
 * nearest first; outcomes without a target (filled in by withTargets).
 */
export function parseKalshiEvents(body: unknown, readAt = Date.now()): Array<FedMeeting & { ref: MeetingRef }> {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const out: Array<FedMeeting & { ref: MeetingRef }> = [];
  for (const e of events as Array<Record<string, unknown>>) {
    const statementAt = typeof e.strike_date === 'string' ? Date.parse(e.strike_date) : Number.NaN;
    if (!Number.isFinite(statementAt) || typeof e.event_ticker !== 'string' || !Array.isArray(e.markets)) continue;
    const rows: Array<{ ticker: string; key: string; label: string; bp: number; p: number }> = [];
    for (const m of e.markets as Array<Record<string, unknown>>) {
      const o = kalshiOutcome(m.custom_strike);
      if (!o || typeof m.ticker !== 'string' || (m.status !== undefined && m.status !== 'active')) continue;
      const p = marketProb(dollars(m.yes_bid_dollars), dollars(m.yes_ask_dollars), dollars(m.last_price_dollars));
      if (p !== null && !rows.some((r) => r.key === o.key)) rows.push({ ticker: m.ticker, ...o, p });
    }
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.bp - b.bp);
    const probs = normalise(rows.map((r) => r.p));
    const meeting = easternDay(statementAt);
    out.push({
      meeting,
      statementAt,
      title: `FOMC ${MONTHS[Number(meeting.slice(5, 7)) - 1]} ${meeting.slice(0, 4)}`,
      outcomes: rows.map((r, k) => ({ key: r.key, label: r.label, bp: r.bp, prob: probs[k]!, target: null })),
      source: 'kalshi',
      updatedAt: readAt,
      ref: { event: e.event_ticker, markets: rows.map(({ ticker, key, label, bp }) => ({ ticker, key, label, bp })) },
    });
  }
  return out.sort((a, b) => a.statementAt - b.statementAt);
}

/**
 * The resulting ranges: the next meeting's from `current`; each later one's
 * from the range its predecessor's most likely outcome leaves.
 */
export function withTargets<T extends Pick<FedMeeting, 'outcomes'>>(meetings: T[], current: TargetRange | null): T[] {
  let from = current;
  return meetings.map((m) => {
    const outcomes = m.outcomes.map((o) => ({ ...o, target: targetAfter(from, o) }));
    const likely = outcomes.reduce<FedOutcome | null>((best, o) => (!best || o.prob > best.prob ? o : best), null);
    if (from && likely) from = { lower: from.lower + likely.bp / 100, upper: from.upper + likely.bp / 100 };
    return { ...m, outcomes };
  });
}

/** Polymarket's outcome title ("25 bps decrease", "50+ bps increase", "No change") as an outcome key. */
export function polymarketKey(title: string): string | null {
  if (/^no change$/i.test(title.trim())) return 'hold';
  const m = /^(\d+)(\+)?\s*bps?\s+(decrease|increase)$/i.exec(title.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const dir = m[3]!.toLowerCase() === 'decrease' ? 'cut' : 'hike';
  return m[2] ? `${dir}_gt${n - 25}` : `${dir}${n}`;
}

/**
 * Polymarket's "Fed Decision in <Month>?" events from a search: per meeting
 * (the Eastern day its markets end), each outcome's Yes price, normalised.
 */
export function parsePolymarket(body: unknown): Array<{ month: number; day: string; probs: Record<string, number> }> {
  const events = (body as { events?: unknown })?.events ?? body;
  if (!Array.isArray(events)) return [];
  const out: Array<{ month: number; day: string; probs: Record<string, number> }> = [];
  for (const e of events as Array<Record<string, unknown>>) {
    const t = typeof e.title === 'string' ? /^Fed Decision in ([A-Za-z]+)\?$/i.exec(e.title.trim()) : null;
    if (!t || e.closed === true || !Array.isArray(e.markets)) continue;
    const month = MONTHS.findIndex((n) => n.toLowerCase() === t[1]!.toLowerCase()) + 1;
    if (month < 1) continue;
    const keys: string[] = [];
    const ps: number[] = [];
    let end = Number.NaN;
    for (const m of e.markets as Array<Record<string, unknown>>) {
      const key = typeof m.groupItemTitle === 'string' ? polymarketKey(m.groupItemTitle) : null;
      let prices: unknown = m.outcomePrices;
      if (typeof prices === 'string') {
        try {
          prices = JSON.parse(prices);
        } catch {
          prices = null;
        }
      }
      const yes = Array.isArray(prices) ? dollars(prices[0]) : null;
      if (!key || yes === null || keys.includes(key) || m.closed === true) continue;
      keys.push(key);
      ps.push(yes);
      const at = typeof m.endDate === 'string' ? Date.parse(m.endDate) : Number.NaN;
      if (Number.isFinite(at)) end = Number.isFinite(end) ? Math.max(end, at) : at;
    }
    if (keys.length < 2 || !Number.isFinite(end)) continue;
    const probs = normalise(ps);
    out.push({ month, day: easternDay(end), probs: Object.fromEntries(keys.map((k, i) => [k, probs[i]!])) });
  }
  return out;
}

/** Polymarket's probabilities on the Kalshi meeting they are for: same month, and they end on the statement's day. */
export function matchPolymarket<T extends Pick<FedMeeting, 'meeting'>>(meetings: T[], pm: ReturnType<typeof parsePolymarket>): Array<T & { polymarket?: Record<string, number> }> {
  return meetings.map((m) => {
    const hit = pm.find((p) => p.day === m.meeting && p.month === Number(m.meeting.slice(5, 7)));
    return hit ? { ...m, polymarket: hit.probs } : m;
  });
}

export type FedHistoryRange = '7d' | '30d' | '90d';
export const FED_HISTORY_RANGES: readonly FedHistoryRange[] = ['7d', '30d', '90d'];

export interface FedSeries {
  key: string;
  label: string;
  bp: number;
  /** [ms, prob], oldest first. */
  points: Array<[number, number]>;
}

/**
 * Kalshi's batch candlesticks for a meeting's markets as one series per
 * outcome: at each candle's close, every outcome's probability (the same rule
 * as now, from the close of the bid, ask and trade - an outcome with no candle
 * then keeps its last one), normalised together.
 */
export function parseKalshiCandles(body: unknown, ref: MeetingRef): FedSeries[] {
  const markets = (body as { markets?: unknown })?.markets;
  if (!Array.isArray(markets)) return [];
  const byTicker = new Map<string, Array<[number, number]>>();
  for (const m of markets as Array<{ market_ticker?: unknown; candlesticks?: unknown }>) {
    if (typeof m.market_ticker !== 'string' || !Array.isArray(m.candlesticks)) continue;
    const pts: Array<[number, number]> = [];
    for (const c of m.candlesticks as Array<Record<string, Record<string, unknown> | unknown>>) {
      const t = Number(c.end_period_ts) * 1000;
      const close = (k: string) => dollars((c[k] as Record<string, unknown> | undefined)?.close_dollars);
      const price = c.price as Record<string, unknown> | undefined;
      const p = marketProb(close('yes_bid'), close('yes_ask'), dollars(price?.close_dollars) ?? dollars(price?.previous_dollars));
      if (Number.isFinite(t) && p !== null) pts.push([t, p]);
    }
    byTicker.set(m.market_ticker, pts.sort((a, b) => a[0] - b[0]));
  }
  const outcomes = ref.markets.filter((m) => byTicker.get(m.ticker)?.length);
  const times = [...new Set(outcomes.flatMap((m) => byTicker.get(m.ticker)!.map(([t]) => t)))].sort((a, b) => a - b);
  const series: FedSeries[] = outcomes.map((m) => ({ key: m.key, label: m.label, bp: m.bp, points: [] }));
  const cursor = outcomes.map(() => -1);
  for (const t of times) {
    const at: Array<number | null> = outcomes.map((m, k) => {
      const pts = byTicker.get(m.ticker)!;
      while (cursor[k]! + 1 < pts.length && pts[cursor[k]! + 1]![0] <= t) cursor[k]!++;
      return cursor[k]! >= 0 ? pts[cursor[k]!]![1] : null;
    });
    const have = at.flatMap((p, k) => (p === null ? [] : [k]));
    const probs = normalise(have.map((k) => at[k]!));
    have.forEach((k, j) => series[k]!.points.push([t, probs[j]!]));
  }
  return series;
}

// --- reading -----------------------------------------------------------------------------

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface FedWatchPage {
  now: number;
  current: TargetRange | null;
  meetings: FedMeeting[];
}

let meetings: { at: number; page: FedWatchPage; refs: Map<string, MeetingRef> } | null = null;
let meetingsFlight: Promise<void> | null = null;
const histories = new Map<string, { at: number; series: FedSeries[] }>();
const historyFlights = new Map<string, Promise<FedSeries[]>>();

/** Tests only. */
export function resetFedWatch(): void {
  meetings = null;
  meetingsFlight = null;
  histories.clear();
  historyFlights.clear();
}

/** The current target range: the newest statement read, else FRED's bounds. */
async function currentRange(fetchImpl: typeof fetch): Promise<TargetRange | null> {
  const fromStatement = latestTargetRange();
  if (fromStatement) return fromStatement;
  try {
    const [lo, up] = await Promise.all([fredSeries('DFEDTARL', fetchImpl), fredSeries('DFEDTARU', fetchImpl)]);
    const lower = lo.obs.at(-1)?.[1];
    const upper = up.obs.at(-1)?.[1];
    return lower !== undefined && upper !== undefined ? { lower, upper } : null;
  } catch {
    return null;
  }
}

/** The coming meetings (cached 60 s). Kalshi failing with nothing cached throws; Polymarket failing only leaves its numbers out. */
export async function fedWatch(fetchImpl: typeof fetch = fetch): Promise<FedWatchPage> {
  if (!meetings || Date.now() - meetings.at >= MEETINGS_MS) {
    meetingsFlight ??= (async () => {
      try {
        const [kalshi, pm, current] = await Promise.all([
          getJson(`${KALSHI}/events?series_ticker=${SERIES}&status=open&with_nested_markets=true&limit=50`, fetchImpl),
          getJson(POLYMARKET_SEARCH, fetchImpl).catch(() => null),
          currentRange(fetchImpl),
        ]);
        const parsed = parseKalshiEvents(kalshi).filter((m) => m.statementAt > Date.now() - 60 * 60_000).slice(0, MAX_MEETINGS);
        if (!parsed.length) throw new Error('Kalshi listed no open FOMC meeting');
        const refs = new Map(parsed.map((m) => [m.meeting, m.ref]));
        const list = matchPolymarket(withTargets(parsed.map(({ ref: _ref, ...m }) => m), current), pm ? parsePolymarket(pm) : []);
        meetings = { at: Date.now(), page: { now: Date.now(), current, meetings: list }, refs };
      } catch (e) {
        if (!meetings) throw e;
        // The last copy stays; it is asked for again in a minute.
        meetings.at = Date.now();
      }
    })().finally(() => {
      meetingsFlight = null;
    });
    await meetingsFlight;
  }
  return { ...meetings!.page, now: Date.now() };
}

export const parseFedHistoryRange = (v: unknown): FedHistoryRange => ((FED_HISTORY_RANGES as readonly unknown[]).includes(v) ? (v as FedHistoryRange) : '30d');

/** One meeting's history over `range` (cached 10 minutes); null for a meeting Kalshi does not list. */
export async function fedWatchHistory(meeting: string, range: FedHistoryRange, fetchImpl: typeof fetch = fetch): Promise<FedSeries[] | null> {
  await fedWatch(fetchImpl);
  const ref = meetings?.refs.get(meeting);
  if (!ref) return null;
  const id = `${ref.event}:${range}`;
  const hit = histories.get(id);
  if (hit && Date.now() - hit.at < HISTORY_MS) return hit.series;
  let flight = historyFlights.get(id);
  if (!flight) {
    flight = (async () => {
      const end = Math.floor(Date.now() / 1000);
      const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
      const period = range === '7d' ? 60 : 1440;
      const tickers = ref.markets.map((m) => m.ticker).join(',');
      const body = await getJson(`${KALSHI}/markets/candlesticks?market_tickers=${tickers}&start_ts=${end - days * 86_400}&end_ts=${end}&period_interval=${period}`, fetchImpl);
      const series = parseKalshiCandles(body, ref);
      if (histories.size >= MAX_HISTORY_CACHED) histories.delete(histories.keys().next().value!);
      histories.set(id, { at: Date.now(), series });
      return series;
    })().finally(() => historyFlights.delete(id));
    historyFlights.set(id, flight);
  }
  try {
    return await flight;
  } catch (e) {
    if (hit) return hit.series;
    throw e;
  }
}
