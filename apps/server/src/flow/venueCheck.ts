/**
 * THE OTHER VENUES' OWN COUNT, for the markets on screen. SoDEX has a ledger written all day (ledger.ts). Hyperliquid has 227
 * markets and trade.xyz 120 on one 1,200-weight budget per IP, with a candle read costing 21+, and Lighter allows about 20
 * calls a minute, so walking them all is not on: instead the API process reads a market's candles when someone opens that
 * market's candle, and keeps what cannot change. The indexer's thread does nothing here.
 *
 * WHAT EACH VENUE GIVES (measured 2026-11-06):
 *   Hyperliquid, trade.xyz  candleSnapshot `n`: prints, exact (14:00 1372/1372, 14:30 4061/5258)
 *   Arcus                   /v1/candles `tradeCount`, with `isFinal`: prints
 *   Lighter                 /api/v1/candles `v`: volume only, no count. Whole slots read 1.00000-1.00005; the newest ones run
 *                           ahead or behind for a while (1.0064 at 12 minutes), so they wait SETTLE and a 0.05 % margin
 *
 * Arcus's count is by its REST time, its stream's stamp 2 to 16 ms later, so a print can be held one slot on: lateAcrossEdge.
 *
 * A slot with fewer or more than the venue's figure is a hole; one we could not compare is unchecked, and a window with either
 * is not final (read.ts), so nothing goes uncompared into a day's cache. Slots follow the window: 5 minutes up to 12 hours, then
 * hours, then days. Beyond 60 days, or Lighter past 12 hours (its slots need chunks decoded), a window is said to be unchecked.
 *
 * PACING, per API process: Hyperliquid and trade.xyz together 6 reads a minute (about 130 of the API's 200 weight, on the shared
 * hlInfo client with its 429 backoff), Arcus 20, Lighter 6 (its pacer's cooldown on a 429). Past that a window stays "checking"
 * and the panel asks again, so a crowd costs the venue no more. Asked the same again, an answer is reused.
 */
import type { Venue } from '../valuedesk/types.js';
import { hlInfo } from '../valuedesk/hyperliquid/client.js';
import { ARCUS_API, arcusPacer } from '../valuedesk/extra/arcus.js';
import { LIGHTER_API, lighterMarkets, lighterPacer } from '../valuedesk/extra/lighter.js';
import { joinSpans, type CoverageHole, type VenueCoverage } from './ledger.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIVE_MS_SPAN = 12 * HOUR;
const HOUR_SPAN = 14 * DAY;
const MAX_SPAN = 60 * DAY;
const VOLUME_TOLERANCE = 0.0005;
const SETTLE: Partial<Record<Venue, number>> = { lighter: 20 * MIN };
const SETTLE_MS = 2 * MIN;
const MAX_HOLES = 200;
/** Most prints put back across one slot edge: a sweep's fills share one stamp. */
const EDGE_MAX = 50;
/** Whose stream stamps later than its count: compared with the slot either side in view. */
const LATE_STAMPS: ReadonlySet<Venue> = new Set(['arcus']);
/** What failed is not asked again this soon. */
const FAILED_MS = 60_000;
/** What was read while a slot of it could still move. */
const OPEN_MS = 60_000;
const CACHE_MAX = 3_000;

export type Timeframe = '5m' | '1h' | '1d';
const SLOT: Record<Timeframe, number> = { '5m': 5 * MIN, '1h': HOUR, '1d': DAY };

export interface CandleRows {
  unit: 'prints' | 'volume';
  rows: Array<{ t: number; v: number; final: boolean }>;
}

/** A market's candles in [from, to), or null where the venue cannot say. */
export type CandleRead = (venue: Venue, symbol: string, tf: Timeframe, from: number, to: number) => Promise<CandleRows | null>;

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null);

const readCandles: CandleRead = async (venue, symbol, tf, from, to) => {
  const limit = Math.ceil((to - from) / SLOT[tf]) + 2;
  if (venue === 'hyperliquid' || venue === 'tradexyz') {
    const j = await hlInfo.post<Array<{ t?: unknown; n?: unknown }> | null>({ type: 'candleSnapshot', req: { coin: symbol, interval: tf, startTime: from, endTime: to - 1 } }, { ttlMs: 0, timeoutMs: 10_000 });
    return { unit: 'prints', rows: (j ?? []).flatMap((r) => { const v = count(r.n); return typeof r.t === 'number' && v !== null ? [{ t: r.t, v, final: true }] : []; }) };
  }
  if (venue === 'arcus') {
    // Times in microseconds, as Arcus has them.
    const j = await arcusPacer.get<{ candles?: Array<{ openTime?: unknown; tradeCount?: unknown; isFinal?: unknown }> }>(`${ARCUS_API}/v1/candles?market=${encodeURIComponent(symbol)}&timeframe=${tf}&from=${from * 1000}&to=${to * 1000}&limit=${limit}`, 20);
    return { unit: 'prints', rows: (j.candles ?? []).flatMap((r) => { const v = count(r.tradeCount); return typeof r.openTime === 'number' && v !== null ? [{ t: Math.floor(r.openTime / 1000), v, final: r.isFinal === true }] : []; }) };
  }
  if (venue === 'lighter') {
    const markets = await lighterMarkets();
    const id = [...markets].find(([, s]) => s === symbol)?.[0];
    if (id === undefined) return null;
    const j = await lighterPacer.get<{ c?: Array<{ t?: unknown; v?: unknown }> }>(`${LIGHTER_API}/api/v1/candles?market_id=${id}&resolution=${tf}&start_timestamp=${Math.floor(from / 1000)}&end_timestamp=${Math.ceil(to / 1000)}&count_back=${limit}`);
    return { unit: 'volume', rows: (j.c ?? []).flatMap((r) => (typeof r.t === 'number' && typeof r.v === 'number' ? [{ t: r.t, v: r.v, final: true }] : [])) };
  }
  return null;
};

let read: CandleRead = readCandles;
/** Tests: another source of candles (null puts the real one back); forgets what was read. */
export function setCandleRead(fn: CandleRead | null): void {
  read = fn ?? readCandles;
  clearVenueChecks();
}

/** Reads a minute, per venue's own limit. Hyperliquid's budget is one, whichever of its two venues asks. */
const PER_MIN: Partial<Record<Venue, number>> = { hyperliquid: 6, arcus: 20, lighter: 6 };
const bucketOf = (v: Venue): Venue => (v === 'tradexyz' ? 'hyperliquid' : v);
const buckets = new Map<Venue, { tokens: number; at: number }>();
function takeRead(v: Venue, now: number): boolean {
  const k = bucketOf(v);
  const cap = PER_MIN[k] ?? 0;
  const b = buckets.get(k) ?? { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) * cap) / MIN);
  b.at = now;
  buckets.set(k, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

type Kept = { rows: CandleRows | null; until: number };
const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<void>>();

export function clearVenueChecks(): void {
  kept.clear();
  reading.clear();
  buckets.clear();
}

/** The candles if they are here; else a read is started, when the venue's share allows, and awaited for up to `waitMs`. */
async function candlesOf(venue: Venue, symbol: string, tf: Timeframe, from: number, to: number, now: number, waitMs: number): Promise<CandleRows | null | 'pending'> {
  const key = `${venue}|${symbol}|${tf}|${from}|${to}`;
  const hit = kept.get(key);
  if (hit && now < hit.until) return hit.rows;
  let p = reading.get(key);
  if (!p) {
    if (!takeRead(venue, now)) return 'pending';
    p = read(venue, symbol, tf, from, to)
      .then((rows) => {
        // All final, the slots settled when it was asked: it cannot change.
        const closed = rows !== null && rows.rows.every((r) => r.final);
        if (kept.size >= CACHE_MAX) kept.delete(kept.keys().next().value!);
        kept.set(key, { rows, until: closed ? Infinity : Date.now() + OPEN_MS });
      })
      .catch(() => {
        kept.set(key, { rows: null, until: Date.now() + FAILED_MS });
      })
      .finally(() => { reading.delete(key); });
    reading.set(key, p);
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<void>((ok) => { timer = setTimeout(ok, waitMs); })]);
  if (timer) clearTimeout(timer);
  const got = kept.get(key);
  return got ? got.rows : 'pending';
}

/**
 * Slots of held against the venue's. Pure (tests). A slot past a venue's first or last row with prints held is unchecked, not
 * short: that can be the end of how far its candles reach. Between them a venue's missing row means it counted nothing.
 */
export function compareSlots(o: {
  venue: Venue;
  unit: 'prints' | 'volume';
  slotMs: number;
  from: number;
  to: number;
  venueRows: ReadonlyArray<{ t: number; v: number; final: boolean }>;
  held: ReadonlyMap<number, number>;
  /** The stream stamps a print later than the venue's count does: see lateAcrossEdge. */
  lateStamps?: boolean;
  edgeRows?: ReadonlyArray<{ t: number; v: number; final: boolean }>;
}): VenueCoverage {
  const rows = new Map(o.venueRows.map((r) => [r.t, r]));
  const times = o.venueRows.map((r) => r.t);
  const first = times.length ? Math.min(...times) : Infinity;
  const last = times.length ? Math.max(...times) : -Infinity;
  const heldOf = o.lateStamps ? lateAcrossEdge(o.held, new Map([...(o.edgeRows ?? []), ...o.venueRows].map((r) => [r.t, r])), o.slotMs) : o.held;
  const holes: CoverageHole[] = [];
  const unchecked: Array<[number, number]> = [];
  let held = 0;
  let expected = 0;
  let holeSlots = 0;
  let overSlots = 0;
  for (let t = o.from; t < o.to; t += o.slotMs) {
    const h = heldOf.get(t) ?? 0;
    const r = rows.get(t);
    if (t < first || t > last) {
      if (h > 0) unchecked.push([t, t + o.slotMs]);
      continue;
    }
    if (r && !r.final) { unchecked.push([t, t + o.slotMs]); continue; }
    const v = r?.v ?? 0;
    held += h;
    expected += v;
    const same = o.unit === 'prints' ? h === v : Math.abs(h - v) <= VOLUME_TOLERANCE * Math.max(v, 1e-12);
    if (same) continue;
    holeSlots++;
    if (h > v) overSlots++;
    const hole = holes[holes.length - 1];
    if (hole && hole.to === t) { hole.to = t + o.slotMs; hole.held += h; hole.venue += v; }
    else holes.push({ from: t, to: t + o.slotMs, held: h, venue: v });
  }
  return { venue: o.venue, unit: o.unit, from: o.from, to: Math.max(o.from, o.to), held, expected, holes: holes.slice(0, MAX_HOLES), holeSlots, overSlots, unchecked: joinSpans(unchecked) };
}

/**
 * Arcus's count goes by its REST time and the stream's print is stamped 2 to 16 ms later (indexer/arcusCatchup.ts), so a print
 * just before a slot's end is held in the next slot: that slot one over and this one short, with nothing lost and nothing twice.
 * Only that shape is put back, and only in that direction: short, with the very next slot over by as much.
 */
function lateAcrossEdge(held: ReadonlyMap<number, number>, rows: ReadonlyMap<number, { v: number; final: boolean }>, slotMs: number): Map<number, number> {
  const out = new Map(held);
  const times = [...rows.keys()].sort((a, b) => a - b);
  const last = times[times.length - 1] ?? -Infinity;
  for (const t of times) {
    const r = rows.get(t)!;
    // Between a venue's rows, one that is not there counted nothing.
    const next = rows.get(t + slotMs) ?? (t + slotMs <= last ? { v: 0, final: true } : undefined);
    if (!r.final || !next?.final) continue;
    const short = r.v - (out.get(t) ?? 0);
    const over = (out.get(t + slotMs) ?? 0) - next.v;
    if (short <= 0 || over <= 0) continue;
    const k = Math.min(short, over, EDGE_MAX);
    out.set(t, (out.get(t) ?? 0) + k);
    out.set(t + slotMs, out.get(t + slotMs)! - k);
  }
  return out;
}

/** Several markets of one venue (a coin on two of Hyperliquid's dexes) as one line. */
function mergeChecks(list: readonly VenueCoverage[]): VenueCoverage {
  const a = list[0]!;
  return {
    ...a,
    from: Math.min(...list.map((c) => c.from)),
    to: Math.max(...list.map((c) => c.to)),
    held: list.reduce((s, c) => s + c.held, 0),
    expected: list.reduce((s, c) => s + c.expected, 0),
    holes: mergeHoles(list.flatMap((c) => c.holes)),
    holeSlots: list.reduce((s, c) => s + c.holeSlots, 0),
    overSlots: list.reduce((s, c) => s + (c.overSlots ?? 0), 0),
    unchecked: joinSpans(list.flatMap((c) => c.unchecked)),
    ...(list.some((c) => c.pending) ? { pending: true } : {}),
  };
}

function mergeHoles(list: readonly CoverageHole[]): CoverageHole[] {
  const out: CoverageHole[] = [];
  for (const h of [...list].sort((x, y) => x.from - y.from)) {
    const last = out[out.length - 1];
    if (last && h.from <= last.to) { last.to = Math.max(last.to, h.to); last.held += h.held; last.venue += h.venue; }
    else out.push({ ...h });
  }
  return out.slice(0, MAX_HOLES);
}

export interface CheckMarket {
  venue: Venue;
  symbol: string;
  id: number;
}

/** Which slots a window is compared in, or null when it is too long to compare. */
export function slotsFor(venue: Venue, span: number): Timeframe | null {
  if (span > MAX_SPAN) return null;
  if (span <= FIVE_MS_SPAN) return '5m';
  if (venue === 'lighter') return null;
  return span <= HOUR_SPAN ? '1h' : '1d';
}

/** Every asked venue with a market here but SoDEX: what its own figures say of [from, to). */
export async function venueChecks(
  markets: readonly CheckMarket[],
  from: number,
  to: number,
  now: number,
  heldOf: (m: CheckMarket, unit: 'prints' | 'volume', a: number, b: number, slotMs: number) => Promise<Map<number, number>>,
  waitMs = 800,
): Promise<VenueCoverage[]> {
  const byVenue = new Map<Venue, VenueCoverage[]>();
  await Promise.all(markets.map(async (m) => {
    const tf = slotsFor(m.venue, to - from);
    const slotMs = tf ? SLOT[tf] : 5 * MIN;
    const a = Math.floor(from / slotMs) * slotMs;
    const settled = Math.floor((now - (SETTLE[m.venue] ?? SETTLE_MS)) / slotMs) * slotMs;
    const b = Math.min(Math.ceil(to / slotMs) * slotMs, settled);
    const empty = (o: Partial<VenueCoverage>): VenueCoverage => ({ venue: m.venue, from: a, to: Math.max(a, b), held: 0, expected: 0, holes: [], holeSlots: 0, overSlots: 0, unchecked: a < b ? [[a, b]] : [], ...o });
    let c: VenueCoverage;
    if (!tf || a >= b) c = empty({});
    else {
      const late = LATE_STAMPS.has(m.venue);
      const before = late ? a - slotMs : a;
      const past = late ? Math.min(b + slotMs, settled) : b;
      const got = await candlesOf(m.venue, m.symbol, tf, before, past, now, waitMs);
      if (got === 'pending') c = empty({ pending: true });
      else if (got === null) c = empty({});
      else {
        // The window's first and last row are what compareSlots reads its reach from; the slot either side only answers for an edge.
        const inWindow = got.rows.filter((r) => r.t >= a && r.t < b);
        const edges = got.rows.filter((r) => r.t < a || r.t >= b);
        c = compareSlots({ venue: m.venue, unit: got.unit, slotMs, from: a, to: b, venueRows: inWindow, edgeRows: edges, held: await heldOf(m, got.unit, before, past, slotMs), lateStamps: late });
      }
    }
    byVenue.set(m.venue, [...(byVenue.get(m.venue) ?? []), c]);
  }));
  return [...byVenue.values()].map(mergeChecks);
}
