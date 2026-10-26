/**
 * The shared price oracle: one coin's top of book (and mark, where the venue
 * has one) on several outside venues, combined into two reference prices.
 *
 *   ORACLE MID   the median of the fresh venues' mids ((bid + ask) / 2).
 *   ORACLE FAIR  the median of the fresh venues' fair prices, where a venue's
 *                fair price is its own MARK price when it publishes one (the
 *                perpetual venues: Binance USD-M, Bitget, OKX, Bybit - each
 *                venue's manipulation-resistant, index-anchored price that it
 *                liquidates on), and its mid where it does not (Binance spot,
 *                Hyperliquid's book read here). A median, so one venue's wick
 *                or outage cannot move it; marks, so a thin book's momentary
 *                spread does not either.
 *
 * A venue whose quote is older than `maxAgeMs` (5 s) is STALE: left out of
 * both prices and listed in `stale`. With no fresh venue there is no price
 * (null): callers pause or fall back, never price off a stale quote.
 *
 * Who reads it: the API's GET /api/vs/oracle (apps/server/src/oracle.ts),
 * one fetch per venue and coin at most once a second for every user together
 * (OracleFeed below); the executors with the same OracleFeed in-process; the
 * browser through the API only (it never contacts the venues itself).
 *
 * Every endpoint is public, unauthenticated market data:
 *   binanceFutures  GET fapi.binance.com/fapi/v1/ticker/bookTicker + /fapi/v1/premiumIndex (mark)
 *   binanceSpot     GET api.binance.com/api/v3/ticker/bookTicker
 *   bitget          GET api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES (bid, ask, mark)
 *   hyperliquid     POST api.hyperliquid.xyz/info {type: l2Book} (bid, ask)
 *   okx             GET www.okx.com/api/v5/market/ticker + /api/v5/public/mark-price (SWAP)
 *   bybit           GET api.bybit.com/v5/market/tickers?category=linear (bid, ask, mark)
 *
 * Prices are per ONE unit of the coin (a 1000x contract is scaled on the way in).
 *
 * TWO COPIES. The API keeps a copy of everything below the marker in
 * apps/server/src/valuescan/oracle.ts (its release does not ship or restart
 * on this package); a server test fails when the two differ.
 */
import type { FetchLike } from './io.ts';

// ---- shared with apps/server/src/valuescan/oracle.ts below this line ----

export type OracleVenue = 'binanceFutures' | 'binanceSpot' | 'bitget' | 'hyperliquid' | 'okx' | 'bybit';
export const ORACLE_VENUES: readonly OracleVenue[] = ['binanceFutures', 'binanceSpot', 'bitget', 'hyperliquid', 'okx', 'bybit'];
export const ORACLE_VENUE_NAMES: Readonly<Record<OracleVenue, string>> = {
  binanceFutures: 'Binance futures',
  binanceSpot: 'Binance spot',
  bitget: 'Bitget',
  hyperliquid: 'Hyperliquid',
  okx: 'OKX',
  bybit: 'Bybit',
};
export const isOracleVenue = (v: unknown): v is OracleVenue => typeof v === 'string' && (ORACLE_VENUES as readonly string[]).includes(v);

/** Older than this, a venue's quote is stale. */
export const ORACLE_MAX_AGE_MS = 5_000;
/** One read per venue and coin per this long, for everyone. */
export const ORACLE_CACHE_MS = 1_000;
const VENUE_TIMEOUT_MS = 2_000;

/** One venue's quote, per one unit of the coin. `at`: the venue's own stamp, else when it was read. */
export interface VenueQuote {
  venue: OracleVenue;
  bid: number;
  ask: number;
  mid: number;
  mark: number | null;
  at: number;
}

export interface OracleCombined {
  /** Median of the fresh mids; null with no fresh venue. */
  mid: number | null;
  /** Median of the fresh venues' fair prices (mark, else mid); null with no fresh venue. */
  fair: number | null;
  /** The venues both prices are made of. */
  used: OracleVenue[];
  /** Asked for, quoted, but older than the limit. */
  stale: OracleVenue[];
  /** Asked for and not quoted at all (failed, timed out, not listed). */
  missing: OracleVenue[];
}

export const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The venues' quotes as one mid and one fair price (pure). `venues`: the ones to use (empty or absent: all). */
export function combineOracle(quotes: readonly VenueQuote[], now: number, opts: { venues?: readonly OracleVenue[] | null; maxAgeMs?: number } = {}): OracleCombined {
  const want = opts.venues?.length ? opts.venues : ORACLE_VENUES;
  const maxAge = opts.maxAgeMs ?? ORACLE_MAX_AGE_MS;
  const used: OracleVenue[] = [];
  const stale: OracleVenue[] = [];
  const mids: number[] = [];
  const fairs: number[] = [];
  const seen = new Set<OracleVenue>();
  for (const q of quotes) {
    if (!want.includes(q.venue) || seen.has(q.venue)) continue;
    if (!(q.mid > 0) || !Number.isFinite(q.mid)) continue;
    seen.add(q.venue);
    // A stamp far in the future is as unusable as an old one.
    if (now - q.at > maxAge || q.at > now + 1_000) {
      stale.push(q.venue);
      continue;
    }
    used.push(q.venue);
    mids.push(q.mid);
    fairs.push(q.mark !== null && q.mark > 0 && Number.isFinite(q.mark) ? q.mark : q.mid);
  }
  return { mid: median(mids), fair: median(fairs), used, stale, missing: want.filter((v) => !seen.has(v)) };
}

/* ------------------------------------------------------------ reading ----- */

type Timer = unknown;
const g = globalThis as unknown as { setTimeout(fn: () => void, ms: number): Timer; clearTimeout(t: Timer): void; AbortController?: new () => { signal: unknown; abort(): void } };

async function getJson<T>(fetch: FetchLike, url: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const ctl = g.AbortController ? new g.AbortController() : { signal: undefined, abort() {} };
  const timer = g.setTimeout(() => ctl.abort(), VENUE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: init.method ?? 'GET', ...(init.body ? { body: init.body, headers: { 'content-type': 'application/json' } } : {}), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    return JSON.parse(text) as T;
  } finally {
    g.clearTimeout(timer);
  }
}

/** Coins a venue lists as a 1000x contract: its symbol and the units per contract. */
const SCALED: Partial<Record<OracleVenue, Record<string, [string, number]>>> = {
  binanceFutures: { PEPE: ['1000PEPEUSDT', 1000], SHIB: ['1000SHIBUSDT', 1000], BONK: ['1000BONKUSDT', 1000], FLOKI: ['1000FLOKIUSDT', 1000] },
  bybit: { PEPE: ['1000PEPEUSDT', 1000], BONK: ['1000BONKUSDT', 1000], FLOKI: ['1000FLOKIUSDT', 1000] },
  hyperliquid: { PEPE: ['kPEPE', 1000], SHIB: ['kSHIB', 1000], BONK: ['kBONK', 1000], FLOKI: ['kFLOKI', 1000] },
};

/** The venue's symbol for a coin and its units per contract. */
export function oracleSymbol(venue: OracleVenue, coin: string): { symbol: string; units: number } {
  const c = coin.toUpperCase();
  const o = SCALED[venue]?.[c];
  if (o) return { symbol: o[0], units: o[1] };
  switch (venue) {
    case 'hyperliquid': return { symbol: c, units: 1 };
    case 'okx': return { symbol: `${c}-USDT-SWAP`, units: 1 };
    default: return { symbol: `${c}USDT`, units: 1 };
  }
}

const num = (x: unknown): number => (typeof x === 'string' || typeof x === 'number' ? Number(x) : NaN);
const stamp = (x: unknown, now: number): number => {
  const t = num(x);
  return Number.isFinite(t) && t > 1e12 ? t : now;
};

function quote(venue: OracleVenue, bid: number, ask: number, mark: number | null, at: number, units = 1): VenueQuote | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return { venue, bid: bid / units, ask: ask / units, mid: (bid + ask) / 2 / units, mark: mark !== null && mark > 0 ? mark / units : null, at };
}

/** One venue's quote for `coin` ('BTC'), or null (not listed, failed). Throws on a network error. */
export async function readVenue(fetch: FetchLike, venue: OracleVenue, coin: string, now: () => number = Date.now): Promise<VenueQuote | null> {
  const vs = oracleSymbol(venue, coin);
  const s = encodeURIComponent(vs.symbol);
  switch (venue) {
    case 'binanceFutures': {
      const [b, p] = await Promise.all([
        getJson<{ bidPrice?: string; askPrice?: string; time?: number }>(fetch, `https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${s}`),
        getJson<{ markPrice?: string; time?: number }>(fetch, `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`).catch(() => null),
      ]);
      return quote(venue, num(b?.bidPrice), num(b?.askPrice), p ? num(p.markPrice) : null, stamp(b?.time, now()), vs.units);
    }
    case 'binanceSpot': {
      const b = await getJson<{ bidPrice?: string; askPrice?: string }>(fetch, `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${s}`);
      return quote(venue, num(b?.bidPrice), num(b?.askPrice), null, now(), vs.units);
    }
    case 'bitget': {
      const r = await getJson<{ data?: Array<{ bidPr?: string; askPr?: string; markPrice?: string; ts?: string }> }>(fetch, `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${s}&productType=USDT-FUTURES`);
      const d = r?.data?.[0];
      return d ? quote(venue, num(d.bidPr), num(d.askPr), num(d.markPrice), stamp(d.ts, now())) : null;
    }
    case 'hyperliquid': {
      const r = await getJson<{ levels?: Array<Array<{ px?: string }>>; time?: number }>(fetch, 'https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'l2Book', coin: vs.symbol }) });
      const bid = num(r?.levels?.[0]?.[0]?.px);
      const ask = num(r?.levels?.[1]?.[0]?.px);
      return quote(venue, bid, ask, null, stamp(r?.time, now()), vs.units);
    }
    case 'okx': {
      const [t, m] = await Promise.all([
        getJson<{ data?: Array<{ bidPx?: string; askPx?: string; ts?: string }> }>(fetch, `https://www.okx.com/api/v5/market/ticker?instId=${s}`),
        getJson<{ data?: Array<{ markPx?: string }> }>(fetch, `https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${s}`).catch(() => null),
      ]);
      const d = t?.data?.[0];
      return d ? quote(venue, num(d.bidPx), num(d.askPx), m?.data?.[0] ? num(m.data[0].markPx) : null, stamp(d.ts, now())) : null;
    }
    case 'bybit': {
      const r = await getJson<{ result?: { list?: Array<{ bid1Price?: string; ask1Price?: string; markPrice?: string }> }; time?: number }>(fetch, `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`);
      const d = r?.result?.list?.[0];
      return d ? quote(venue, num(d.bid1Price), num(d.ask1Price), num(d.markPrice), stamp(r?.time, now()), vs.units) : null;
    }
  }
}

/* ---------------------------------------------------------- the feed ----- */

interface Slot {
  quote: VenueQuote | null;
  /** When the last read finished (0: never). */
  at: number;
  inflight: Promise<VenueQuote | null> | null;
  error: string | null;
}

export interface OracleSnapshot extends OracleCombined {
  coin: string;
  at: number;
  quotes: Array<VenueQuote & { ageMs: number; stale: boolean }>;
  errors: Partial<Record<OracleVenue, string>>;
}

/**
 * Quotes read on demand and shared: a venue and coin is read at most once per
 * `cacheMs`, and while a read is in flight every caller waits on that same
 * read. Coins nobody asks for are never read.
 */
export class OracleFeed {
  private slots = new Map<string, Slot>();
  constructor(private readonly deps: { fetch: FetchLike; now?: () => number; cacheMs?: number; read?: typeof readVenue }) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The venue's quote, from the cache when it is under `cacheMs` old. */
  venue(venue: OracleVenue, coin: string): Promise<VenueQuote | null> {
    const key = `${venue}:${coin.toUpperCase()}`;
    let s = this.slots.get(key);
    if (!s) {
      s = { quote: null, at: 0, inflight: null, error: null };
      this.slots.set(key, s);
      if (this.slots.size > 2_000) this.slots.delete(this.slots.keys().next().value as string);
    }
    if (s.inflight) return s.inflight;
    if (s.at && this.now() - s.at < (this.deps.cacheMs ?? ORACLE_CACHE_MS)) return Promise.resolve(s.quote);
    const slot = s;
    const read = this.deps.read ?? readVenue;
    slot.inflight = read(this.deps.fetch, venue, coin, () => this.now())
      .then((q) => {
        slot.quote = q;
        slot.error = q ? null : 'not listed';
        return q;
      })
      .catch((e: unknown) => {
        // Keep the last quote: it ages out on its own stamp.
        slot.error = e instanceof Error ? e.message : String(e);
        return slot.quote;
      })
      .finally(() => {
        slot.at = this.now();
        slot.inflight = null;
      });
    return slot.inflight;
  }

  /** Every asked venue's quote for the coin. */
  async quotes(coin: string, venues: readonly OracleVenue[] = ORACLE_VENUES): Promise<VenueQuote[]> {
    const got = await Promise.all(venues.map((v) => this.venue(v, coin)));
    return got.filter((q): q is VenueQuote => q !== null);
  }

  /** Quotes, ages, errors and the combined prices. */
  async snapshot(coin: string, venues: readonly OracleVenue[] = ORACLE_VENUES, maxAgeMs = ORACLE_MAX_AGE_MS): Promise<OracleSnapshot> {
    const qs = await this.quotes(coin, venues);
    const now = this.now();
    const errors: Partial<Record<OracleVenue, string>> = {};
    for (const v of venues) {
      const e = this.slots.get(`${v}:${coin.toUpperCase()}`)?.error;
      if (e) errors[v] = e;
    }
    return {
      coin: coin.toUpperCase(),
      at: now,
      ...combineOracle(qs, now, { venues, maxAgeMs }),
      quotes: qs.map((q) => ({ ...q, ageMs: Math.max(0, now - q.at), stale: now - q.at > maxAgeMs })),
      errors,
    };
  }
}
